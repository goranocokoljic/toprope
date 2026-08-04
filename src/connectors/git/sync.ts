import type Database from 'better-sqlite3';
import {randomUUID} from 'crypto';
import {aggregateDailyMetrics, prMergeDurationHours} from './analyzer.js';
import {toAnalysisCommit, toAnalysisPR, toAnalysisReviewComment} from './analysis-types.js';
import type {AnalysisCommit, AnalysisPR, AnalysisReviewComment} from './analysis-types.js';
import {
    mergeDailyDisjoint,
    rawAuthorKeyFor,
    upsertRawAuthorDaily,
    RawAuthorDailyError,
    ROW_LEVEL_REFUSALS,
    type RawAuthorDailyErrorCode,
    type RawAuthorDailyInput,
} from './raw-author-daily.js';
import {
    buildDevLookupMap,
    projectSnapshots,
    resolveDeveloperId,
    resolveRawAuthor,
    type SnapshotCell,
} from './projection.js';
import {createGitProvider} from './providers/factory.js';
import {createCommitDiffstatCache, deleteContainerDiffstats} from './diffstat-cache.js';
import {
    containerKey,
    containerKeyOf,
    providerContainer,
    resolveGitProviderConfigs,
} from './providers/config.js';
import {resolveAllGitProviders} from './providers/resolve.js';
import type {GitRunDeadline} from './providers/http-retry.js';
import {
    GitRunDeadlineError,
    SYNC_RETRY_PROFILE,
    createRunDeadline,
    isRetryableGitFetchError,
    sleep,
} from './providers/http-retry.js';
import {findProviderByTypeContainer} from './providers/store.js';
import {loadServerKey} from './providers/secret.js';
import type {
    GitProviderConfig,
    GitProviderType,
    GitCommitDrop,
    GitCommitDropReason,
    GitFetchProgressListener,
    GitFileDiff,
    GitPR,
} from './providers/types.js';
import {COMMIT_DROP_REASONS} from './providers/types.js';
import {promoteAllCandidates} from './onboarding.js';
import {ensureTeam} from '../../registry/teams.js';
import {resolveAutoCreateSettings, type AutoCreateSettings} from '../../config/git-auto-create.js';
import type {ConnectorInterface, SyncResult} from '../types.js';
import type {GitConnectorConfig} from '../../config/types.js';

const CONNECTOR_NAME = 'git';

/**
 * Prefix of the advisory pushed into a SyncResult's `errors` when some commit
 * authors have no developer record. This is NOT a sync failure — unmatched
 * authors (CI bots, external contributors, not-yet-mapped humans) are the
 * expected steady state and their commits are simply dropped. Callers that
 * classify a run's outcome (e.g. the sync-now API) must exclude this advisory
 * from genuine errors; exported so there is a single source of truth for the
 * sentinel rather than a matched string literal that can drift.
 */
export const UNMATCHED_AUTHORS_PREFIX = 'Unmatched authors (no developer record found):';

/**
 * Prefix of the run summary pushed into a SyncResult's `errors` when opt-in auto-create
 * (#256) ran. Like {@link UNMATCHED_AUTHORS_PREFIX} this is an ADVISORY, not a failure —
 * it reports what the run onboarded — so outcome classifiers must exclude it.
 *
 * Auto-create FAILURES are deliberately NOT given this prefix: a promotion that could not
 * complete is a genuine error the operator must see turn a provider red, and hiding it
 * behind the same sentinel as the success summary is how a half-onboarded run reads as
 * an all-clear.
 */
export const AUTO_CREATE_SUMMARY_PREFIX = 'auto-created';

/**
 * Prefix of the advisory pushed when the projection REFUSED to write cells because their
 * stored rows are legacy (`is_projected = 0`, pre-#253) — accumulated totals no retained
 * raw row can reconstruct, so overwriting them would replace a real number with a partial
 * one.
 *
 * An ADVISORY rather than a failure: the run itself succeeded and the refusal is the safe
 * choice. But it must be SAID, because it is the one case where "the sync completed" stops
 * implying "the data for those days is current" — an upgraded deployment's straddling day,
 * or a backfill over a window that predates retention. A full distinctive sentence, not a
 * bare word, so a future error can never collide with it.
 */
export const LEGACY_CELLS_SKIPPED_PREFIX = 'Legacy snapshot cells left untouched:';

/**
 * Prefix of the advisory pushed when a container this run FETCHED changed owner before the run
 * wrote — the `git_providers` row was deleted during the minutes of network I/O (and, since
 * #264, its data retracted and its cursors purged), whether or not a replacement was added.
 *
 * Deliberately NOT a failure: nothing went wrong, the operator asked for the provider to be
 * removed and it was. But it must be SAID, because the run discards a whole provider's fetched
 * window. See the ownership gate in `runSync` for why writing it instead is far worse.
 */
export const PROVIDER_DELETED_MID_RUN_PREFIX = 'Provider changed during this run:';

/**
 * Prefix of the advisory pushed when an in-run retry HEALED a fetch that had failed (#272).
 *
 * Deliberately NOT a failure: the run recovered, which is the entire point of the retry, and
 * classifying it otherwise would turn every survived blip red and make the pipeline re-fetch
 * the whole connector. But it must be SAID. Without it a healed retry is completely invisible —
 * the run reports no error, and the only trace is that it took up to 20 minutes longer per repo
 * while the progress indicator sat at `0 / null`, which reads exactly like a hang. An operator
 * asking "why was last night's sync 90 minutes long and why did the dashboard look frozen"
 * needs this line to exist.
 */
export const RETRY_HEALED_PREFIX = 'Recovered after retry:';

/**
 * Prefix of the advisory pushed when the per-commit diffstat cache (#273) swallowed one or more
 * faults during this provider's fetch.
 *
 * Deliberately NOT a failure: the cache is a memo of an idempotent remote read, every fault
 * degrades to exactly one re-fetch, and turning a provider red because a disposable optimisation
 * misfired would hold its cursor and discard a perfectly good window — the precise outcome the
 * cache's never-throw contract exists to prevent.
 *
 * But it must be SAID, and this is the only place that can say it. A read-only database, a
 * schema drift, sustained `SQLITE_BUSY` against the dashboard's connection or a full disk makes
 * EVERY cache call fail; the ratchet is then completely dead, the deployment silently reverts to
 * paying full price on every commit of every run, and the sole symptom is "the sync is still
 * slow". Without this line, a permanently broken feature and a working one produce byte-identical
 * output.
 */
export const DIFFSTAT_CACHE_DEGRADED_PREFIX = 'Diffstat cache degraded:';

/**
 * Prefix of the advisory pushed when a provider returned commits carrying no `GitCommit.diffs`,
 * so this run fell back to a second per-commit `getCommitDiff` request for each of them (#280).
 *
 * Deliberately NOT a failure: taking the fallback is a supported branch of the interface (see
 * `GitCommit.diffs` for why the field is optional), and the fallback fetches the same diff. What
 * turning the provider red would actually cost is not a held cursor — the cursor advance and the
 * snapshot write are gated on {@link ProviderFetchResult.complete}, never on `errors` — it is a
 * red `sync_logs` row, a red provider in the admin UI, and `sync-pipeline` re-running the ENTIRE
 * git connector (a second full network fetch) for a run that in fact imported everything.
 *
 * But it must be SAID, because the fallback is exactly the ~2N per-commit request volume #271
 * removed, and nothing else in the run distinguishes it from the reuse path. Every in-tree
 * provider supplies `diffs`, so a non-zero count means either a new provider that never honoured
 * the contract or a refactor that dropped the field from an existing one — and the only other
 * symptom is a sync that got slower, or a rate-limit stall that #235's lag machinery reports
 * with no cause. The count is what makes that diagnosable instead of merely felt.
 *
 * TWO counts, not one, and the difference is a data-integrity claim rather than a nicety. A
 * fallback request that FAILS is swallowed by design (the commit is kept with empty diffs rather
 * than failing the repo — #271's preserved semantics), and empty diffs mean `files_changed`,
 * `code_churn_rate` and `ai_signature_score` are computed from nothing for that commit. This
 * line is the only output about those commits, so it must not claim "no metric is wrong" over
 * them: the reassuring sentence is emitted only when the failure count is zero, and when it is
 * not, the loss is stated plainly. Reporting a healthy fallback and a lossy one identically is
 * precisely the "a completion signal is not a currency claim" failure this project has already
 * been bitten by.
 *
 * TWO LINES, not one, and the seam is the same one #275's drop advisory is cut along. Everything
 * about REQUEST VOLUME is true the moment the requests are made, so it is pushed straight into
 * `errors` here. Everything about the loss being PERMANENT depends on this run's window actually
 * being recorded as covered, which `fetchProviderData` cannot see — three paths discard a fetched
 * window with no cursor advance (incomplete provider, rolled-back write, container deleted
 * mid-run), and on all three the commits are re-asked next run and the zeros never land. So the
 * permanence half is threaded out as {@link ProviderFetchResult.diffLossAdvisories} and emitted
 * from the cursor-advance closure, exactly like {@link ProviderFetchResult.droppedAdvisories}.
 * Making that claim unconditionally would be worse than saying nothing, because the remedy it
 * names is destructive: it sends the operator to rebuild a span that is in fact intact.
 *
 * WHICH REMEDY IT NAMES MATTERS. Purging `git_last_sync`/`git_earliest_sync` on its own and
 * re-syncing is the one action that is NEVER safe here: `mergeDailyAcrossRuns` ADDS commits,
 * lines and files on the premise that run windows are disjoint, and `upsertRawAuthorDaily` has no
 * dedup guard, so re-importing an already-imported span permanently DOUBLES every commit metric
 * in it (#262) — a far larger corruption than the understatement being repaired. The line
 * therefore names the provider delete cascade (`providers/delete-cascade.ts`), which retracts the
 * container's `raw_author_daily`/`pr_records`/`commit_diffstats` and re-projects the affected days
 * BEFORE purging its cursors, so the re-import lands on an empty span.
 */
export const DIFFS_NOT_SUPPLIED_PREFIX = 'Provider supplied no commit diffs:';

/**
 * Prefix of the advisory pushed when a provider LISTED commits it could not return.
 * {@link GitCommitDrop} is the canonical statement of that decision — permanent and
 * non-retryable, so reported rather than thrown — and of where this line does and does not
 * reach; read it rather than re-deriving the argument here (#275).
 *
 * Deliberately NOT a failure, for the same reason as {@link DIFFSTAT_CACHE_DEGRADED_PREFIX}:
 * a fault no retry can fix must not be classified as one that retrying helps. Turning the
 * provider red would make `sync-pipeline` re-run the ENTIRE git connector — a second full
 * network fetch — on every run forever and still never recover the commit.
 *
 * But it must be SAID, and this line is the whole point of #275. Before it, such a commit
 * vanished with nothing in `errors[]`, nothing in the sync log, and the forward cursor already
 * advanced past it — a permanent, silent hole in `git_snapshots`, the exact failure class
 * #231/#235 exist to prevent. It is also one of the places where "the run completed" stops
 * implying "every commit in the window is present", so it states the loss plainly rather than
 * leaving the operator to infer it from a `diff N/M` counter (the only trace it previously
 * left — see `GitSyncProgress.repo_step`).
 *
 * Emitted only for a run whose data was actually KEPT — see the emit site and the rollback
 * handler. A discarded window is re-fetched, so calling its drops permanent would be a lie.
 *
 * "UNATTRIBUTABLE" IN THE SENTINEL IS THE HEADLINE FOR THE CHANNEL, not a claim about every
 * reason on it, and since #304 that distinction is real: {@link FUTURE_AUTHOR_DATE_DROP_REASON}
 * describes a commit whose date is perfectly usable and merely ahead of every window a run can
 * request, so THIS run did not attribute it while a run started after that date could. The
 * sentinel is deliberately not renamed for it — it is matched by `isAdvisoryError` and
 * `isPermanentLossAdvisory`, persisted into `sync_logs.errors` and `last_sync_advisories`, and
 * asserted verbatim across the suite, so widening the word would cost more than it buys. What
 * carries the distinction is the grouped reason the line ends with — the body says nothing at all
 * about whether a given drop can come back, because only the reason knows. (It said "nothing
 * re-asks them" until #304, which was true of two reasons and false of the third; the replacement
 * is silence rather than a per-reason clause, since `${groups}` renders the reasons two clauses
 * later and would only be restating them.)
 *
 * The body also says only that the commits could not be imported BY THIS RUN, never that they
 * belonged to the covered window. Since #304 one of the reporting paths — Bitbucket's cutoff-page
 * tail — reports rows that are, by the endpoint's own ordering, almost certainly OLDER than the
 * window's floor, so a line claiming they were lost from inside it would have an operator sizing
 * a repair against a hole that is not there.
 */
export const COMMITS_DROPPED_PREFIX = 'Commits dropped as unattributable:';

/**
 * Prefix of the advisory pushed when a provider returned commits whose CHURN it could not
 * observe — the commits it flagged `churnObserved: false` (#288); on GitHub, a commit-detail
 * response carrying no usable `stats` object. `GitCommit.churnObserved` is the canonical
 * statement of why that is neither a fetch failure nor a drop; read it rather than
 * re-deriving the argument here.
 *
 * Deliberately NOT a failure, for the same reason as {@link COMMITS_DROPPED_PREFIX}: the
 * response was well-formed by the endpoint's published contract, so re-fetching returns the
 * identical body. Turning the provider red would make `sync-pipeline` re-run the ENTIRE git
 * connector every run forever and still never learn the line counts.
 *
 * But it must be SAID. The commit IS imported — its author, date and file list all land — so
 * every count-based surface looks complete; the only thing wrong is that `lines_added` and
 * `lines_removed` on that developer-day are short by this commit's contribution, and nothing
 * else in the run distinguishes "this commit changed nothing" from "nobody told us what it
 * changed". That is the "a completion signal is not a currency claim" failure exactly.
 *
 * Emitted only for a run whose data was actually KEPT — same seam, same staging and the same
 * three discard paths as {@link COMMITS_DROPPED_PREFIX} and the permanence half of
 * {@link DIFFS_NOT_SUPPLIED_PREFIX}: a held, rolled-back or deleted-container window is
 * re-fetched intact next run, and calling its understatement permanent would send an operator
 * to repair a span that is fine. The memo half needs no such gate and is handled at the
 * provider, which simply never writes a `commit_diffstats` row for these commits.
 */
export const COMMIT_CHURN_UNKNOWN_PREFIX = 'Commit churn not observed:';

/**
 * Prefix of the advisory pushed when the run built an author-day row the raw store would
 * REFUSE, and skipped it rather than letting the refusal throw (#302).
 *
 * WHY A SKIP AT ALL. `upsertRawAuthorDaily` validates fail-closed and throws, and it runs
 * inside this run's SINGLE all-providers write transaction — so one unusable row does not cost
 * one row. It rolls back every provider's window, advances no cursor, and re-throws identically
 * on every subsequent run: a permanent stall of the whole git connector, from data no retry can
 * change. #275/#290 closed that door for the commit author date by gating it at each provider;
 * three more dates reach the store ungated (`pr.createdAt`, `pr.mergedAt`, `comment.createdAt`,
 * each keyed into a day by `analyzer.ts` and copied verbatim onto the row) and a NaN
 * `avg_time_to_merge_hours` computed from the first two is a fourth door. Skipping at the WRITE
 * boundary is total over all of them and over every future provider, which a fifth per-provider
 * gate would not be.
 *
 * WHAT THE TRADE COSTS, stated plainly because it is the whole of the decision. The run keeps
 * its other rows and its cursor advances, so the skipped author-day is gone: its commits, PRs
 * and review comments for that day are absent from `raw_author_daily` and therefore from
 * `git_snapshots`, and nothing re-asks them. That is strictly better than the alternative — the
 * throw loses the same day AND every other provider's whole window, forever — but it is a real
 * loss, which is why it is reported here and ranked with the permanent ones.
 *
 * WHAT THE LINE CANNOT SAY. The drop advisory names the SHAS it lost, because a provider
 * reports a drop per commit. This row is keyed by (author, day) — the individual commits and
 * PRs were already folded into its counters before the store ever saw it — so the finest thing
 * this line can name is the author-day and the store's refusal code. It does NOT say which
 * commits were in it; nothing at this boundary knows any more.
 *
 * Deliberately NOT a failure, for the same reason as {@link COMMITS_DROPPED_PREFIX}: the
 * response was well-formed enough to reach here and re-fetching returns the identical unusable
 * value, so turning the provider red would re-run the entire git connector every run forever
 * and still never write the row.
 *
 * Emitted only for a run whose data was actually KEPT — same seam and same staging as the drop
 * advisory: a held, rolled-back or deleted-container window is re-fetched intact next run, and
 * calling its skip permanent would send an operator to repair a span that is fine.
 */
export const AUTHOR_DAYS_SKIPPED_PREFIX = 'Author-days skipped as unwritable:';

/**
 * How many examples an advisory names before falling back to "+N more". Enough to go look one
 * up in the provider's UI; small enough that a systemic shape problem across thousands of
 * commits still produces one readable line.
 */
const ADVISORY_SAMPLE_SIZE = 5;

/**
 * The bounded example sample every loss advisory renders — {@link COMMITS_DROPPED_PREFIX} per
 * reason group, {@link COMMIT_CHURN_UNKNOWN_PREFIX} per repo (#288), and
 * {@link AUTHOR_DAYS_SKIPPED_PREFIX} per refusal code (#302).
 *
 * ONE renderer, not three, so "these lines cannot drift to different budgets" is structurally
 * true rather than a promise a shared constant only half keeps: the cap, the join and the
 * `(+N more)` tail are the whole of what an operator reads as the sample, and a second copy
 * could diverge on any of them while both still sliced at the same number.
 *
 * Takes ALREADY-SANITIZED entries: the allowlist (or escape) belongs at the boundary that knows
 * what KIND of value it holds, and folding it in here would make it easy for a future caller to
 * pass some other untrusted field and have it silently rendered under the wrong control — a sha
 * as `<invalid sha>` when it is really an author key, or vice versa.
 */
function formatBoundedSample(entries: readonly string[]): string {
    const sample = entries.slice(0, ADVISORY_SAMPLE_SIZE);
    const more = entries.length - sample.length;
    return `${sample.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/** One thing an advisory lost, already sanitized by the boundary that knew what it was. */
interface AdvisoryLoss {
    /** The classification the operator's next step follows from. */
    reason: string;
    /** What was lost, in whatever identifier that class of loss can name it by. */
    label: string;
}

/**
 * `N <verb> <reason> — e.g. a, b (+3 more); M <verb> <other> — e.g. c` — the grouped body every
 * loss advisory ends with: {@link COMMITS_DROPPED_PREFIX}, {@link AUTHOR_DAYS_SKIPPED_PREFIX}
 * and {@link PR_RECORDS_SKIPPED_PREFIX} (#302).
 *
 * GROUPED BY REASON rather than listed beside a merged reason set, because the reasons exist
 * only where the operator's next step differs — a line that says "reasons: A; B — affected: 5"
 * tells them nothing about which step applies to which item. The sample cap is applied per
 * group, so a systemic failure of one class cannot crowd the other out of the line entirely.
 *
 * ONE body, three callers. Before #302 the grouping was open-coded at the drop advisory and
 * copied again for the new one, with only {@link formatBoundedSample}'s cap/join/tail actually
 * shared — so the "one renderer" claim above it was true of the tail and not of the grouping.
 *
 * Insertion-ordered, so the rendered output is deterministic.
 */
function formatLossGroups(losses: readonly AdvisoryLoss[], verb: string): string {
    const byReason = new Map<string, string[]>();
    for (const {reason, label} of losses) {
        const labels = byReason.get(reason);
        if (labels === undefined) byReason.set(reason, [label]);
        else labels.push(label);
    }
    return [...byReason]
        .map(([reason, labels]) => `${labels.length} ${verb} ${reason} — e.g. ${formatBoundedSample(labels)}`)
        .join('; ');
}

/**
 * A sha, safe to interpolate into an operator-facing line.
 *
 * The sha is raw response JSON, and this line is printed to a terminal by the CLI, persisted
 * into `sync_logs.errors`, and — since #289 — stored on `git_providers.last_sync_advisories`
 * and rendered in the admin provider row. That third sink adds no markup hazard (React
 * escapes text children), so the control THIS allowlist exists for is unchanged: the terminal
 * and the log, where a newline or an ANSI escape is what does the damage. It covers the sha
 * and nothing else — the repo name interpolated beside it, and the author login/email and
 * provider error text carried by neighbouring advisory lines, are response-derived and
 * unsanitized; that gap is pre-existing and belongs in one shared container-sanitizing helper
 * rather than here. Allowlisted rather than escaped (the graduated
 * validate-at-the-boundary rule): a git object name is hex, so anything else is not a sha, and
 * a value that survives this cannot carry a newline, an ANSI escape, or excess length.
 *
 * TOTAL over `unknown`, which is the point of the signature. `sha` is declared `string` by a
 * cast over an unvalidated body, so it can be a number or an array at runtime — and
 * `RegExp.test` COERCES, so a bare pattern test would pass `12345` straight through and the
 * next `.slice` would throw a `TypeError` out of a line that runs AFTER the provider's whole
 * network walk, discarding the window. `typeof` first, exactly as `isAttributableDate` does.
 *
 * The length bound lives IN the pattern rather than in a trailing `slice`: truncating a
 * 64-char hex value to 40 would manufacture a well-formed-looking sha that resolves to
 * nothing, sending the operator to look up a commit that never existed. Anything not a
 * plausible object name renders as `<invalid sha>` instead — visibly wrong, because "the
 * provider returned a malformed sha" is itself something the operator needs to see.
 */
function sanitizeSha(sha: unknown): string {
    return typeof sha === 'string' && /^[0-9a-fA-F]{4,40}$/.test(sha) ? sha : '<invalid sha>';
}

/**
 * A drop reason, safe to interpolate into the same line.
 *
 * A runtime allowlist against {@link COMMIT_DROP_REASONS}, not just the compile-time
 * {@link GitCommitDropReason} union — the graduated rule is explicit that a TS union at a
 * trust boundary is not a control, and this value crosses a provider boundary before reaching
 * a terminal and `sync_logs`. An unrecognized value is named rather than pasted through, so a
 * future provider interpolating an API error body cannot reach the log through this field.
 */
function sanitizeDropReason(reason: unknown): string {
    return COMMIT_DROP_REASONS.includes(reason as GitCommitDropReason)
        ? (reason as string)
        : '<unrecognized drop reason>';
}

/** How many characters of a response-derived label an advisory prints before truncating. */
const ADVISORY_LABEL_MAX_CHARS = 60;

/**
 * Every character that can move a terminal cursor, start an ANSI escape, break one log line into
 * two, or reorder what an operator reads:
 *   - C0 controls, DEL and C1 controls — newline, CR, and the ESC every ANSI sequence opens with;
 *   - U+2028/U+2029, which several renderers (and `eval`ed JS) treat as line terminators, so
 *     stripping only C0 would leave the "this advisory is exactly one entry" property half-true;
 *   - the bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069) and the invisible
 *     format/zero-width characters (U+200B–U+200F), which can visually reorder the line — an
 *     author login carrying an RLO can make the refusal code render as something else entirely.
 * Non-ASCII stays otherwise untouched: a CJK or accented display name is legitimate.
 *
 * Declared once, at module scope, so the regex is compiled once rather than per label on a run
 * that skips thousands of rows. `g`-flagged and used only with `String.replace`, never `.test`,
 * so there is no `lastIndex` state to carry between calls.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/**
 * An author key or a day, safe to interpolate into {@link AUTHOR_DAYS_SKIPPED_PREFIX}.
 *
 * NOT allowlisted, unlike {@link sanitizeSha} — and that is a decision, not an omission. A sha
 * is hex, so "anything else is not a sha" is a true statement; an author login is free-form
 * text in every provider and a rejected DAY is by definition off-shape, so an allowlist here
 * would render the very values the operator needs to see as `<invalid>`. The control that
 * actually matters for a line printed to a terminal and stored in a log is therefore applied
 * directly — see {@link CONTROL_CHARS_RE} for exactly which characters and why — and the length
 * is bounded so one absurd value cannot fill the surface.
 *
 * Truncation is marked with `…`, so a shortened value reads as shortened. That is safe here and
 * would not be for a sha (see {@link sanitizeSha}): nobody looks an author key up by exact
 * prefix expecting it to resolve, whereas a silently-truncated 64-char sha resolves to nothing.
 * The cut is by CODE POINT, not by UTF-16 unit, so it cannot split a surrogate pair and leave a
 * lone surrogate in a string that is later `JSON.stringify`d into a TEXT column.
 *
 * TOTAL over `unknown`: `RawAuthorDailyInput.date` is typed `string` but is built by slicing a
 * response field, and `PRRecordInput.repo`/`prId` are casts over an unvalidated body. `<empty>`
 * is not defensive either — `toDateString` yields `''` for every non-string date, and that `''`
 * is exactly what this line has to name.
 */
export function sanitizeAdvisoryLabel(value: unknown): string {
    if (typeof value !== 'string') return '<non-string>';
    if (value === '') return '<empty>';
    const printable = [...value.replace(CONTROL_CHARS_RE, '?')];
    return printable.length > ADVISORY_LABEL_MAX_CHARS
        ? `${printable.slice(0, ADVISORY_LABEL_MAX_CHARS).join('')}…`
        : printable.join('');
}

/** One author-day row this run built and the raw store would not accept (#302). */
interface SkippedAuthorDay {
    raw_author_key: string;
    date: string;
    code: RawAuthorDailyErrorCode;
}


/**
 * The {@link AUTHOR_DAYS_SKIPPED_PREFIX} line for one provider instance, or `[]` when it skipped
 * nothing — so the caller can spread the result unconditionally.
 *
 * ONE line per provider instance with a count and a bounded sample, the same layout as the drop
 * and churn advisories, because an operator reading all of them in one `errors` list should not
 * have to learn a third.
 *
 * Every interpolated value is handled at the boundary that knows what each one is: `skip.code` is
 * a first-party {@link RawAuthorDailyErrorCode} caught from the store's own typed refusal (#307)
 * — a closed enum produced in-process, not a value crossing a trust boundary, so it interpolates
 * verbatim exactly as `formatSkippedPRRecords`'s reason does. The author key and day (both
 * response-derived) go through {@link sanitizeAdvisoryLabel}. The container is operator-configured
 * rather than response-derived, but it goes through the same call — it is free-form text on the
 * admin form, and there is no reason for this line to be the one that trusts it.
 *
 * WHY IT SAYS "AT LEAST". `toDateString` folds every non-string date — `null`, a number, an
 * array, a missing key — into ONE `''` day, so a truncated page that cost an author 300 PRs
 * arrives here as a single unwritable row. Author-days is the only quantity this boundary can
 * count honestly; printing it bare would let an operator read "1" as "one PR".
 */
function formatSkippedAuthorDays(
    providerType: GitProviderType,
    container: string,
    skips: readonly SkippedAuthorDay[],
): string[] {
    if (skips.length === 0) return [];
    const groups = formatLossGroups(
        skips.map((skip) => ({
            reason: skip.code,
            label: `${sanitizeAdvisoryLabel(skip.raw_author_key)} on ${sanitizeAdvisoryLabel(skip.date)}`,
        })),
        'refused as',
    );
    return [
        `${AUTHOR_DAYS_SKIPPED_PREFIX} [${providerType}/${sanitizeAdvisoryLabel(container)}] ` +
            `${skips.length} author-day row(s) could not be written to raw_author_daily, and this ` +
            `run has recorded its window as covered — nothing re-asks them. Everything that day ` +
            `carried for the author — commits, PRs and review comments alike — is absent from ` +
            `raw_author_daily and therefore from git_snapshots. The row is keyed by (author, day), ` +
            `so this is at LEAST ${skips.length} lost item(s) and may be far more: an unusable ` +
            `date collapses every PR and comment carrying it onto one row, and nothing at this ` +
            `boundary still knows how many. Neither a forward sync nor "sync older history" can ` +
            `re-ask them — the latter only extends STRICTLY older than the earliest synced ` +
            `instant, so it reaches neither a forward window nor a span a backfill just covered. ` +
            `${groups}.`,
    ];
}

/**
 * The {@link SYSTEMIC_ROW_REFUSAL_PREFIX} line for one provider instance (#306).
 *
 * Deliberately NOT a second copy of the advisory's prose: the sibling line beside it already
 * names the refusal codes, the sample rows and the fact that nothing re-asks them. This one says
 * only what the advisory cannot — the SCALE, and that the scale is what changed the verdict —
 * and points at the line that carries the detail.
 *
 * The remedy is deliberately thin, and that is the honest answer rather than an omission. The
 * graduated rule is that a printed remedy must be safe, reachable and complete; the two repairs
 * that would recover the lost span are neither safe nor reachable here. Purging the cursors and
 * re-syncing re-arms the #262 permanent double-count over the rows this run DID retain, and the
 * delete-and-re-add procedure {@link permanentSpanRepair} prescribes is refused outright for a
 * config-file provider. So the instruction is the one that is always both: find the cause from
 * the codes on the sibling line and stop the bleeding, because every further run loses more.
 *
 * It says explicitly that the codes are readable WITHOUT re-running a sync. That is not padding:
 * a sync is the one action this same line calls lossy (it advances the cursor over another window
 * under the unfixed cause), so an instruction that implied one as step 1 would prescribe the
 * damage it warns about.
 *
 * WHERE it sends them is provenance-checked, and the honest answer is narrower than the first
 * version claimed. The one store written on EVERY provenance is the run's own error list — the
 * text the caller is already looking at. The two durable stores each cover one provenance and
 * only one: `sync_logs` rows are written by `runConnectorWithRetry` alone (`sync-pipeline.ts`),
 * i.e. the scheduler and `toprope sync all` — `toprope sync git` and the admin Sync-now button
 * write NO row; `last_sync_advisories` is written by the sync-now route alone. Naming either
 * unconditionally would send half the deployments to an empty table. `sync_logs` additionally has
 * no reader in `src/` at all (`getRecentSyncLogs` is uncalled), so reaching it means a direct SQL
 * read, and saying so is the difference between an instruction and a dead end.
 */
function formatSystemicRowRefusal(
    providerType: GitProviderType,
    container: string,
    refusal: GitRowRefusal,
): string {
    const {skipped, retained, runs} = refusal;
    // Name the arm that actually fired, because the three describe different failures and an
    // operator's next question ("is this one bad import, an ongoing bleed, or an old wound?") is
    // answered by which one it was. A line that reported only the counts would leave the streak
    // arm looking like an arithmetic error — 3 of 3 rows is not obviously an escalation on its
    // own — and would leave `carried` unexplained entirely, since on that arm THIS run's counts
    // are below every threshold. Asked of the SHARED classifier, so this line and doctor's cannot
    // tell one record two stories.
    //
    // The streak sentence says "refusing runs" rather than "consecutive runs": `runs` is
    // incremented only by a run that refused rows, so a run over an empty window neither
    // increments nor resets it and the streak can span more calendar time than a raw run count
    // implies.
    const arm = escalationArm(refusal);
    const cause =
        arm === 'ratio'
            ? `most of what this run built was refused`
            : arm === 'streak'
              ? `this provider has now refused most of what it built on ${runs} consecutive refusing runs`
              : `an EARLIER run of this provider already refused a window systemically, and nothing has imported cleanly since — this run being smaller does not recover that span`;
    return (
        `${SYSTEMIC_ROW_REFUSAL_PREFIX} [${providerType}/${sanitizeAdvisoryLabel(container)}] ` +
        `${skipped} of ${skipped + retained} author-day row(s) this run built were refused and ` +
        `only ${retained} were written, while the forward cursor advanced over the whole window ` +
        `— and ${cause}. That is not the incidental single-row loss the ` +
        `"${AUTHOR_DAYS_SKIPPED_PREFIX}" advisory reports, so this run is reported as a FAILURE ` +
        `even though it committed. Read the refusal codes on that advisory line — it is beside ` +
        `this one in THIS run's own error output, so you do NOT need to re-run a sync to see it ` +
        `(durably, it is in sync_logs.errors only for a scheduled run or "toprope sync all", and ` +
        `on git_providers.last_sync_advisories only for an admin Sync-now of a DB-connected ` +
        `provider) — and fix the cause: every further run loses another ` +
        `window the same way. The windows already covered cannot be re-asked (neither a forward ` +
        `sync nor "sync older history" reaches them), and do NOT purge this provider's cursors ` +
        `to re-import them: that permanently doubles every commit metric on the rows that WERE ` +
        `retained (#262).`
    );
}

/**
 * Prefix of the advisory pushed when a PR's `pr_records` row could not be written (#302).
 *
 * THE SECOND WRITE IN THE SAME TRANSACTION, and the reason a skip at `raw_author_daily` alone
 * was not enough. `pr_records.created_at` / `repo` / `pr_id` / `state` are `NOT NULL` columns
 * bound from fields the providers CAST out of a response body rather than validate, so a
 * `created_at: null` — the shape a truncated page really produces — reached SQLite as a NULL
 * bind and threw `NOT NULL constraint failed` from inside `insertMany`. That is the identical
 * geometry {@link AUTHOR_DAYS_SKIPPED_PREFIX} exists to close: every other provider's window
 * rolled back, no cursor advanced, and the next run replayed the same body forever.
 *
 * Deliberately NOT a failure and staged on the cursor advance, for the same reasons as its
 * sibling: re-fetching returns the identical unusable value, and the loss is only permanent once
 * the window is recorded as covered.
 *
 * NARROWER THAN ITS SIBLING, and worth stating: a PR whose record is skipped still contributes
 * its `prs_opened`/`prs_merged` counts to `raw_author_daily` whenever those rows were writable.
 * What is lost is the per-PR review record — comment counts, review rounds, time-to-merge — so
 * the PR-review coaching surfaces, not the adoption metrics, are what go short.
 */
export const PR_RECORDS_SKIPPED_PREFIX = 'PR records skipped as unwritable:';

/** The single reason the PR-skip advisory groups by (#307) — see {@link isUnstorablePRFieldError}. */
const PR_RECORD_UNSTORABLE_REASON = 'an unstorable field';

/**
 * One PR whose record this run built and `pr_records` refused at the write (#302/#307).
 *
 * `repo`/`prId` are `unknown`, not `string`: the record was refused precisely because a field of
 * it could not be bound, and one of these two may be the offender, so declaring them `string`
 * would assert the thing the refusal just disproved. {@link sanitizeAdvisoryLabel} is total over
 * `unknown`.
 */
interface SkippedPRRecord {
    repo: unknown;
    prId: unknown;
}

/**
 * Is this error `pr_records` refusing an unstorable field VALUE (#307), rather than a genuine
 * failure the run must surface (SQLITE_BUSY, disk-full, a FK violation, a bug in our own code)?
 *
 * The PR write is the OTHER unvalidated bind in the git sync's single all-providers transaction:
 * `repo`/`pr_id`/`state`/`created_at` are `NOT NULL`, and every column is bound from a field the
 * providers CAST out of a response body. #307 refuses at the write itself rather than mirroring
 * the bind list in a hand-maintained pre-check (`findPRRecordDefect`, now deleted) — which is what
 * makes a newly-added `NOT NULL` column covered the day it lands, with no second body to keep in
 * step. The price is that the discrimination is on the ERROR, and it must be EXACT: a bare catch
 * that also swallowed SQLITE_BUSY would advance the cursor over a transient failure and report the
 * run clean — a worse fail-open than the rollback #302 closed. So this matches only the three
 * shapes an unstorable value actually produces, and lets everything else propagate and roll back:
 *
 *   - `null`/`undefined` into a NOT NULL column: SQLite RUNS the statement and rejects it with a
 *     `SqliteError` carrying `code: 'SQLITE_CONSTRAINT_NOTNULL'`. That is the ONE SQLite-side code
 *     matched — any OTHER `SQLITE_*` code (a FK violation on `developer_id`, a `RAISE(ABORT)`
 *     trigger, `SQLITE_BUSY`, disk-full) is a genuine failure and rethrows.
 *   - an object/array/symbol positional bind (a cast body field that is not a scalar): the driver
 *     rejects the JS VALUE at its binding layer, before SQLite runs, as a bare `RangeError` /
 *     `TypeError` with no `code`, carrying one of a few fixed messages ({@link DRIVER_VALUE_BIND_RE}).
 *     We match those messages POSITIVELY rather than the whole `RangeError`/`TypeError` class,
 *     because the driver throws the SAME two classes (also uncoded) for LIFECYCLE faults that are
 *     NOT bad values — "The database connection is not open", "This database connection is busy
 *     executing a query", "Too many parameter values were provided" — and a bare class match would
 *     swallow those (and any future own-code `TypeError`) as a per-PR skip WITH the cursor
 *     advanced, the exact fail-open #302 closed. Version drift fails SAFE: an unrecognized message
 *     falls through to a rethrow and rolls the run back loudly rather than losing a PR silently.
 */
/**
 * better-sqlite3's VALUE-rejection messages, the ones that mean "this bound JS value is not
 * storable" as opposed to a connection/statement lifecycle fault (#307). An object/array
 * positional arg is misread as a named-parameter bag ("Too few parameter values"); two such
 * objects collide ("named parameters in two different objects"); an unbindable scalar like a
 * symbol is refused outright ("can only bind"). Deliberately EXCLUDES "Too MANY parameter values"
 * (an arg-count bug at a fixed-arity call site, not a bad value) and the "not open"/"busy"
 * lifecycle messages — those must roll the run back, not skip one PR.
 */
const DRIVER_VALUE_BIND_RE =
    /too few parameter values|named parameters in two different objects|can only bind/i;

function isUnstorablePRFieldError(err: unknown): boolean {
    if (err instanceof Error) {
        const code = (err as {code?: unknown}).code;
        if (typeof code === 'string' && code.startsWith('SQLITE_')) {
            return code === 'SQLITE_CONSTRAINT_NOTNULL';
        }
    }
    return (err instanceof RangeError || err instanceof TypeError) && DRIVER_VALUE_BIND_RE.test(err.message);
}

/** The {@link PR_RECORDS_SKIPPED_PREFIX} line for one provider instance, or `[]` for none. */
function formatSkippedPRRecords(
    providerType: GitProviderType,
    container: string,
    skips: readonly SkippedPRRecord[],
): string[] {
    if (skips.length === 0) return [];
    // The reason is a fixed first-party literal (#307), not a per-column code — the write no
    // longer classifies WHICH field was unstorable, only that a bind refused. The repo and PR id
    // DO come from a cast response body, which is what `sanitizeAdvisoryLabel` is for.
    const groups = formatLossGroups(
        skips.map((skip) => ({
            reason: PR_RECORD_UNSTORABLE_REASON,
            label: `${sanitizeAdvisoryLabel(skip.repo)}#${sanitizeAdvisoryLabel(skip.prId)}`,
        })),
        'refused as',
    );
    return [
        `${PR_RECORDS_SKIPPED_PREFIX} [${providerType}/${sanitizeAdvisoryLabel(container)}] ` +
            `${skips.length} PR(s) carried a field pr_records cannot store, and this run has ` +
            `recorded its window as covered — nothing re-asks them. Their per-PR review record ` +
            `(comment counts, review rounds, time-to-merge) is absent, so the PR-review coaching ` +
            `surfaces are short by exactly these: each was authored by a registered developer, ` +
            `resolved, and then refused at the write, so the count is every LOST PR — not merely ` +
            `every refused one (#307). The day counts in raw_author_daily are unaffected wherever ` +
            `those rows were themselves writable. Providers re-fetch PRs by updated_at/updated_on, ` +
            `so a PR that is never touched again is never re-delivered. ${groups}.`,
    ];
}

/**
 * The repair for a span whose metrics are permanently understated, shared verbatim by the two
 * advisories that have to prescribe one ({@link DIFFS_NOT_SUPPLIED_PREFIX}'s permanence half
 * and {@link COMMIT_CHURN_UNKNOWN_PREFIX}).
 *
 * ONE copy, deliberately. This is executable advice whose first sentence exists to stop an
 * operator from doing something strictly worse than the damage being repaired (#262), and two
 * copies of it is two chances for a later change to the cascade to update one and leave the
 * other prescribing the old procedure — the exact drift the "a remedy printed to an operator
 * is executable advice" rule is about.
 */
function permanentSpanRepair(): string {
    return (
        'raw_author_daily has no recompute path. Whatever you do, do NOT simply purge this ' +
        "provider's cursors and re-sync: that re-imports over the surviving rows and " +
        'permanently DOUBLES every commit metric in the span (#262), which is strictly worse ' +
        'than the understatement. For a provider registered in the admin UI the repair is to ' +
        'DELETE it and re-add it — the delete cascade retracts this container\'s raw rows and ' +
        're-projects the affected days BEFORE purging its cursors, so the re-import lands on ' +
        'an empty span — then run "sync older history" to recover anything beyond the ' +
        `${FIRST_SYNC_WINDOW_DEFAULT_MONTHS}-month first-sync window a re-added provider ` +
        `starts from. ${configFileProviderNotDeletable()}, so it has no ` +
        'supported repair today: leave the span understated'
    );
}

/**
 * Why the admin delete is not a remedy for a CONFIG-FILE provider — the one sentence every
 * surface that prescribes "delete it" has to carry.
 *
 * ONE copy, for the reason {@link permanentSpanRepair} states about itself: this is the clause
 * that makes a named remedy reachable or not, and it is exactly the clause a second hand-written
 * rendering drops. It was dropped once already — the #306 `doctor` hint told the operator to
 * "delete it in the admin UI" flat, which the route refuses for every YAML-configured provider.
 */
export function configFileProviderNotDeletable(): string {
    return (
        'A CONFIG-FILE provider cannot be deleted (the route refuses it, and the cascade is ' +
        'skipped while the YAML entry still owns the container)'
    );
}

/**
 * Prefix of the line raised when a provider instance's author-day refusals stop being
 * incidental and become SYSTEMIC (#306) — a GENUINE ERROR, deliberately absent from
 * {@link ADVISORY_PREFIXES}.
 *
 * The gap it closes. {@link AUTHOR_DAYS_SKIPPED_PREFIX} is unconditional per row, and its
 * "skipping is the lesser loss" trade is the right one for the single bad PR date that
 * motivated it. It is quietly wrong when the SAME refusal hits every row: the provider writes
 * nothing, its cursor still advances, `recordSyncOutcome` NULLs `last_sync_error` and stores
 * `status: 'ok'` (because the advisory prefix says so), and the only evidence is one prose line
 * on a channel with no dashboard surface. `1 author-day row(s)` and `40,000 author-day row(s)`
 * produced the same green. Under the pre-#302 throw the same event was loud, red, and
 * RECOVERABLE — the window was intact.
 *
 * This is the graduated "a completion signal is not a currency claim" rule: the run that
 * succeeds while a provider's entire window is permanently gone is exactly the one an operator
 * reads as an all-clear. The skip stays (re-asking cannot help — see `ROW_LEVEL_REFUSALS`), but
 * the RUN stops claiming it went fine.
 *
 * SCOPED TO THE AUTHOR-DAY GRAIN, knowingly. {@link PR_RECORDS_SKIPPED_PREFIX} has the identical
 * geometry one grain over — it is in {@link ADVISORY_PREFIXES}, so a provider whose every PR is
 * refused (an adapter regression leaving `state` undefined, say) still settles green while its
 * whole PR-review history goes missing — and this escalation does NOT cover it. That is a scope
 * decision, not an oversight: the two need separate denominators (pr_records written, not
 * author-day rows), the losses differ in weight (adoption metrics vs the PR-coaching surfaces),
 * and folding them into one ratio would let a healthy author-day window mask a total PR refusal
 * and vice versa. The refused count DOES reach `records_skipped` either way — which is also the
 * cost of the decision, since the two grains now share one number whose magnitude no longer says
 * which of them moved. Tracked as #313 rather than smuggled in here; the issue number is named
 * so the claim can be checked rather than taken on trust.
 *
 * Staged on the cursor advance like the advisories it escalates, for the identical reason: the
 * loss is only beyond recovery once the window is recorded as covered.
 */
export const SYSTEMIC_ROW_REFUSAL_PREFIX = 'Systemic author-day refusal:';

/**
 * How many author-day rows ONE RUN must refuse before it alone can be called systemic.
 *
 * A FLOOR, not a preference, and the reason the one-bad-date case #302 was built around stays an
 * advisory. A provider that builds two rows and refuses one is at a 50% refusal rate on a sample
 * of two — the ratio test alone would escalate it, and that PR is exactly the incidental loss the
 * advisory channel exists for.
 *
 * 5, from the smallest sample on which "most of what this run built was refused" is a statement
 * about the provider rather than about the sample. Below that a single odd PR timestamp moves the
 * ratio across the threshold on its own, which is noise; at 5 it cannot.
 *
 * It is a floor on ONE RUN, which is why it is not the whole rule. A three-developer org's daily
 * window builds ~3 rows, so a cause refusing 100% of them clears no per-run floor, ever — that
 * hole is closed by {@link TOTAL_REFUSAL_ALERT_RUNS}, not here. See {@link isEscalatedRefusal}.
 */
export const SYSTEMIC_SKIP_MIN_ROWS = 5;

/**
 * Consecutive runs in which a provider refused MOST of what it built before the streak alone
 * escalates, whatever the per-run counts (#306).
 *
 * The arm {@link SYSTEMIC_SKIP_MIN_ROWS} cannot cover. The scheduled sync is daily, so a
 * steady-state window is one day; for a small org that is a handful of author-day rows. A cause
 * refusing every one of them — an adapter regression making `author.login` a non-string, say —
 * loses 100% of that provider's data every day forever while `skipped` never reaches 5. The
 * per-run floor is right about ONE run and blind to the sequence.
 *
 * 3, and deliberately the same number and the same argument as {@link GIT_STALL_ALERT_RUNS}
 * beside it: one run importing almost nothing is the common, self-healing case (an empty window, a
 * provider with no activity that day), and alerting on it would train the reader to ignore the
 * signal. Three consecutive runs that built rows and refused most of them cannot be explained away.
 *
 * "MOST", not "all": `retained === 0` was the first predicate and it left the two arms with an
 * uncovered intersection — a window too small for the floor and never quite totally refused. See
 * {@link GitRowRefusal.runs} and the counter's own comment in `recordRowRefusal`. A run that
 * writes MORE than it refuses breaks the streak; that is the incidental-loss shape, and it proves
 * the cause is not systemic.
 */
export const TOTAL_REFUSAL_ALERT_RUNS = 3;

/**
 * Did this ONE RUN refuse rows systemically rather than incidentally (#306)?
 *
 * "At or near its write count", as a predicate: at least {@link SYSTEMIC_SKIP_MIN_ROWS} refused,
 * and at least as many refused as retained. The failure it is named for refuses 100% of a
 * provider's rows; half is the point at which "this provider mostly did not import" stops being
 * arguable, while leaving a genuinely mixed window — a handful of bad PR dates among a normal
 * day's rows — on the advisory channel.
 *
 * Both operands are counted AT THE WRITE (#307): `skipped` is the rows the write refused,
 * `retained` the rows it accepted, both tallied in `insertMany`'s raw loop over `rawWrites`. That
 * is the DEDUPED map, but the count equals the pre-dedupe one in practice: `aggregateDailyMetrics`
 * already collapses a provider instance's repos to one row per `(login, date)` BEFORE the row is
 * built, and the within-run `mergeDailyDisjoint` only ever fires for the same container appearing
 * twice — the duplicate-container case the resolver forecloses. So no real single-provider run has
 * two `rawWrites` entries that a merge collapses, and the ratio moves only with genuine refusals.
 *
 * `retained` counts rows the store ACCEPTED, which is also rows that reached SQLite past the
 * `isWritable` gate — but that gate is per `(provider, container)`, so a container whose closure
 * runs at all had every one of its rows counted, and a container deleted mid-run returns early
 * from its cursor-advance closure and never reads these counts (it is reported by
 * {@link PROVIDER_DELETED_MID_RUN_PREFIX} instead).
 *
 * This is ONE of the two arms. A run below the floor can still escalate on the streak — ask
 * {@link isEscalatedRefusal}, which is what every surface reads.
 */
export function isSystemicRowRefusal(skipped: number, retained: number): boolean {
    return skipped >= SYSTEMIC_SKIP_MIN_ROWS && skipped >= retained;
}

/** Every sentinel that marks an `errors` entry as advisory rather than a failure. */
const ADVISORY_PREFIXES: readonly string[] = [
    UNMATCHED_AUTHORS_PREFIX,
    AUTO_CREATE_SUMMARY_PREFIX,
    LEGACY_CELLS_SKIPPED_PREFIX,
    PROVIDER_DELETED_MID_RUN_PREFIX,
    RETRY_HEALED_PREFIX,
    DIFFSTAT_CACHE_DEGRADED_PREFIX,
    DIFFS_NOT_SUPPLIED_PREFIX,
    COMMITS_DROPPED_PREFIX,
    COMMIT_CHURN_UNKNOWN_PREFIX,
    AUTHOR_DAYS_SKIPPED_PREFIX,
    PR_RECORDS_SKIPPED_PREFIX,
];

/**
 * Is this `SyncResult.errors` entry an ADVISORY (something the run wants to report) rather
 * than a FAILURE (something that went wrong)?
 *
 * `errors` carries both, because advisories describe the steady state of a healthy sync —
 * unmatched CI bots and external contributors exist in nearly every real repo — and a run
 * that reports them synced perfectly well. Every consumer that classifies a run's outcome
 * must agree on which is which, so the rule lives here, once, beside the sentinels it
 * matches. Two consumers previously disagreed: the sync-now route excluded advisories, the
 * scheduler did not, so a repo with one bot author had every scheduled run retried in full
 * (a second complete network fetch) and logged as an error.
 *
 * Auto-create FAILURE lines deliberately match nothing here: a promotion that could not
 * complete is authorship left unattributed, and the operator must see it turn a provider
 * red rather than have it hidden behind the success summary's sentinel.
 */
export function isAdvisoryError(error: string): boolean {
    return ADVISORY_PREFIXES.some((prefix) => error.startsWith(prefix));
}

/**
 * Genuine failures that a re-run cannot repair, and that a re-run actively makes WORSE (#306).
 *
 * The third class, and the reason two were not enough. {@link isAdvisoryError} was answering two
 * questions with one bit — "does this turn the provider red?" and "should the connector be
 * re-run?" — which happened to have the same answer for every sentinel until this one.
 * {@link SYSTEMIC_ROW_REFUSAL_PREFIX} needs red WITHOUT a retry, and the retry it would otherwise
 * trigger is destructive three separate ways:
 *
 * 1. IT CANNOT HELP. `ROW_LEVEL_REFUSALS`' entire premise is that re-fetching returns the
 *    identical unusable value, and the run that emitted this already advanced the cursor past the
 *    window. There is nothing for a second attempt to recover.
 * 2. IT LOSES ANOTHER WINDOW. A catch-up run is capped at {@link GIT_CATCHUP_WINDOW_MAX_DAYS}
 *    (#235), so a provider 170 days behind advances only 30 days per run. The retry's window is
 *    therefore NOT the covered one — it is the next 30 days, which it fetches, refuses under the
 *    same unfixed cause, and records as covered. Shipping the retry would double the permanent
 *    loss this issue exists to stop, on exactly the provider it exists to protect.
 * 3. IT ERASES THE REPORT. `runConnectorWithRetry` returns the RETRY's result, and that is what
 *    `toprope sync all` prints and error-flags. For a caught-up provider the second attempt finds
 *    an empty window, refuses nothing and returns `snapshotsSkipped: 0` — so the escalation would
 *    make the primary CLI path quieter and greener than it was before this issue.
 *
 * A transient fault is the opposite case in all three respects, which is why the split is by
 * sentinel rather than by severity.
 */
const NON_RETRYABLE_ERROR_PREFIXES: readonly string[] = [SYSTEMIC_ROW_REFUSAL_PREFIX];

/**
 * Should a run reporting this entry be re-attempted? The predicate `runConnectorWithRetry` asks.
 *
 * Advisories are excluded because they describe the steady state of a healthy sync (#272), and
 * {@link NON_RETRYABLE_ERROR_PREFIXES} because re-running is worse than not. Everything else — an
 * expired token, a 5xx, an unexpected throw — is exactly what a retry is for.
 */
export function isRetryableError(error: string): boolean {
    return (
        !isAdvisoryError(error) &&
        !NON_RETRYABLE_ERROR_PREFIXES.some((prefix) => error.startsWith(prefix))
    );
}

/**
 * The advisory sentinels that report a PERMANENT loss — something this pipeline can never
 * re-ask for, because the cursor has been recorded as covering the window it happened in.
 *
 * Every one of these is staged onto the cursor advance for exactly that reason (see the
 * `cursorAdvances` closure): they are emitted only once the loss is beyond recovery. The rest
 * of the advisory vocabulary reports a recoverable or cosmetic state — a healed retry, a
 * degraded cache, unmatched bot authors, an onboarding summary — and a run that loses one of
 * those lines has lost nothing an operator must act on.
 */
const PERMANENT_LOSS_ADVISORY_PREFIXES: readonly string[] = [
    COMMITS_DROPPED_PREFIX,
    DIFFS_NOT_SUPPLIED_PREFIX,
    COMMIT_CHURN_UNKNOWN_PREFIX,
    AUTHOR_DAYS_SKIPPED_PREFIX,
    PR_RECORDS_SKIPPED_PREFIX,
];

/** Does this advisory report a loss that can never be re-asked? */
export function isPermanentLossAdvisory(advisory: string): boolean {
    return PERMANENT_LOSS_ADVISORY_PREFIXES.some((prefix) => advisory.startsWith(prefix));
}

/**
 * The advisory sentinels that report a state which ALREADY RESOLVED ITSELF.
 *
 * The bottom tier, and the reason two tiers were not enough. `RETRY_HEALED_PREFIX` is the only
 * class with unbounded cardinality — one line per healed fetch, per repo, per fetch kind — so
 * on the rate-limited large-org run the ranking exists for it is also the class that FILLS the
 * surface. Ranked as merely "not permanent" it sits at the head of the remainder (it is
 * spliced in during fetch, before every post-commit line), and a 20-line cap then keeps twenty
 * reports that the run recovered by itself while evicting `PROVIDER_DELETED_MID_RUN_PREFIX`
 * and `LEGACY_CELLS_SKIPPED_PREFIX` — which arrive last and are the two remaining lines that
 * carry an operator INSTRUCTION ("re-run sync older history for the affected window").
 *
 * A healed retry is the one advisory whose whole content is "nothing needs doing", so it is
 * the correct thing to drop first.
 */
const SELF_HEALED_ADVISORY_PREFIXES: readonly string[] = [RETRY_HEALED_PREFIX];

/** Does this advisory report a state that already resolved itself? */
export function isSelfHealedAdvisory(advisory: string): boolean {
    return SELF_HEALED_ADVISORY_PREFIXES.some((prefix) => advisory.startsWith(prefix));
}

/**
 * Order advisories most-important-first for a surface that can only keep some of them.
 *
 * Required because `errors` ARRIVAL order is close to the inverse of its importance order. A
 * run appends every per-provider fetch-phase line first (`errors.push(...result.errors)`),
 * and `RETRY_HEALED_PREFIX` is emitted once per healed fetch — per repo, per fetch kind — so
 * a large org riding out transient rate limiting produces hundreds of "recovered after retry"
 * lines. The permanent-loss lines are appended LAST, after the write transaction commits,
 * because only then is the loss real. A bounded surface that truncates by arrival therefore
 * discards precisely the lines that cannot be recovered and keeps the ones that healed
 * themselves — which is why the ordering lives here, beside the sentinels whose relative
 * severity it encodes, rather than at the surface doing the truncating.
 *
 * THREE tiers, not two. Ranking permanent loss to the front is only half the job: the middle
 * tier holds the lines that report a recoverable state an operator must still ACT on
 * (`PROVIDER_DELETED_MID_RUN_PREFIX`, `LEGACY_CELLS_SKIPPED_PREFIX` — both emitted last), and
 * the bottom tier holds the self-healed ones, which are the only class numerous enough to
 * fill the surface on their own. See SELF_HEALED_ADVISORY_PREFIXES.
 *
 * STABLE within each class: two lines of the same importance keep their emitted order, so an
 * operator reading the retained set sees it in the order the run produced it.
 *
 * ONE pass over the input, and every entry lands in exactly one tier by construction — the
 * same reason the route partitions advisory-vs-failure in one loop rather than with two
 * complementary filters.
 */
export function rankAdvisories(advisories: readonly string[]): string[] {
    const permanent: string[] = [];
    const actionable: string[] = [];
    const selfHealed: string[] = [];
    for (const advisory of advisories) {
        if (isPermanentLossAdvisory(advisory)) permanent.push(advisory);
        else if (isSelfHealedAdvisory(advisory)) selfHealed.push(advisory);
        else actionable.push(advisory);
    }
    return [...permanent, ...actionable, ...selfHealed];
}

/**
 * The line auto-create emits when it could NOT onboard some candidates.
 *
 * Extracted so the classification test can assert against the string the code actually
 * produces rather than a copy of it. The distinction it carries — this line is a genuine
 * failure, the summary beside it is an advisory — is enforced only by wording, so a test
 * holding its own literal would keep passing through exactly the reword that breaks it.
 */
export function autoCreateFailureLine(failed: number, detail: string): string {
    return `Auto-create could not onboard ${failed} author(s): ${detail}`;
}

/**
 * The stages a sync run passes through, in pipeline order (GC#209). The network
 * fetch dominates wall time, so `listing_repos`/`fetching` are what a 1s HTTP
 * poll realistically observes; `analyzing`/`writing` are synchronous and brief —
 * part of the wire contract and visible to a direct listener, but a poll will
 * rarely catch them.
 */
export type GitSyncStage = 'listing_repos' | 'fetching' | 'analyzing' | 'writing';

/**
 * Which O(N) fan-out inside `current_repo` the run is working through (#270).
 *
 * The `fetching` stage's run-level `commits_fetched`/`prs_fetched` only move when a
 * whole repo finishes, so on a large repo they sit unchanged for minutes and read as
 * a hang. These name the three unbounded loops a single repo passes through, in
 * order, so a progress consumer can show motion *within* one repo:
 *   - `commits` — the provider's commit list paging, then its per-commit detail fetch
 *   - `diffs`   — this loop's per-commit diff pass. Since #271 it reuses the diff the
 *                 provider already returned on `GitCommit.diffs`; it is a `getCommitDiff`
 *                 fan-out only for a provider that supplied none. See `repo_step` below
 *                 for what that means for an observer.
 *   - `prs`     — the provider's PR list paging, then this loop's per-PR
 *                 review-comment/verdict fan-out
 */
export type GitSyncRepoStep = 'commits' | 'diffs' | 'prs';

/**
 * A live progress snapshot of an in-flight sync run, emitted through the
 * optional listener {@link GitSync.syncProviders} accepts (GC#209). Field names
 * are wire-shaped (snake_case) because the admin API serves each snapshot
 * verbatim on the provider list's `active_sync.progress` — one shape end to
 * end, nothing to drift. Counters are cumulative across the whole run; the
 * per-provider "sync now" trigger passes exactly one provider, so there they
 * read as that provider's counts.
 */
export interface GitSyncProgress {
    stage: GitSyncStage;
    /** Repos selected for the run; null until listing has completed. */
    repos_total: number | null;
    repos_processed: number;
    /** The repo currently being fetched (fetching stage only). */
    current_repo: string | null;
    commits_fetched: number;
    prs_fetched: number;
    /** Distinct developers resolved from the fetched activity (analyzing stage on). */
    developers_matched: number;
    /**
     * Which within-repo fan-out is in flight, and how far it has advanced (#270).
     * All four are reset to (null, 0, null, null) whenever a repo finishes (and on
     * leaving the fetching stage), so a consumer never shows a finished repo's stale counter.
     * A repo START is not idle — it enters the `commits` step immediately, before its
     * list request, so the indicator is never blank while that request is in flight.
     *
     * `repo_step_total` is null while the set is still being *discovered* (a list
     * endpoint paging in) — its size genuinely is not knowable until the last page,
     * so `repo_step_done` then reads as "seen so far", not "done out of total".
     * Once the set is in hand the total is real and both read as done/total. There
     * is deliberately no percentage or ETA anywhere: the pipeline cannot compute an
     * honest one for the listing phase.
     *
     * A total of 0 means "this step ran over an empty set" — nothing to count, so a
     * consumer must not render it as a counter (`repoStepCount` in AdminGitProviders
     * is the single place that decides this; producers do not pre-filter it).
     *
     * Two caveats a reader of these numbers needs:
     *   - On GitHub the `commits` total counts commits LISTED while the `diffs` total
     *     counts commits RETURNED, so `commit N/N` followed by `diff 0/M` with M < N
     *     means the run dropped N − M commits it could not attribute to a day. Since
     *     #275 that gap is no longer something a reader has to infer from these two
     *     numbers: the drop is reported in `SyncResult.errors` under
     *     {@link COMMITS_DROPPED_PREFIX}, with the full COUNT and a bounded sample of
     *     shas (not every sha — see {@link ADVISORY_SAMPLE_SIZE}). That is where
     *     an operator should look; these counters are a live indicator, not a record,
     *     and are gone the moment the repo finishes. GitLab lists exactly what it returns, and Bitbucket's
     *     total is commits RETAINED after its in-memory `until` filter (which is what
     *     `repo_step_scanned` exists to expose — #276), so on those two the `diffs` total
     *     always equals the `commits` total.
     *   - The `diffs` step no longer re-walks the per-commit endpoint (#271). All three
     *     providers now return each commit's diff on `GitCommit.diffs` from the fetch they
     *     already made during the `commits` step, so on any such provider `diffs` is a
     *     synchronous pass with no `await` in it — which means a POLLING consumer never
     *     observes it at all. Node cannot run the poll handler between the reports, so
     *     `repo_step: 'diffs'` is written and then overwritten by `'prs'` within one tick.
     *     Treat `diff N/M` as a FALLBACK-ONLY surface: seeing it never appear is correct
     *     and does not mean the run skipped diffs. The step still reports per commit
     *     because a provider that supplies no diffs falls back to `getCommitDiff`, and
     *     that IS an N-request fan-out a poller does see.
     */
    repo_step: GitSyncRepoStep | null;
    repo_step_done: number;
    /**
     * Rows the list endpoint returned to the step in flight, when that differs from the
     * rows it kept in `repo_step_done` (#276) — null whenever there is no such distinction.
     *
     * Only a provider that cannot push the run's window to the server reports it: Bitbucket
     * pages its commit list from HEAD and filters `until` in memory, so on a backfill or
     * catch-up chunk `repo_step_done` is pinned at 0 for hundreds of pages while this
     * advances a page of rows at a time. It is the ONLY field that moves there, and a
     * consumer that renders `repo_step_done` alone shows the frozen line #270 exists to
     * remove. `GitFetchProgress.scanned` is where the provider-side semantics live.
     *
     * Non-null is NOT by itself a reason to render it: the same provider reports it on a
     * forward run too, where it simply equals `repo_step_done`. It is also meaningful only
     * while `repo_step_total` is null — once the set is in hand, every row in it was kept.
     * Both suppressions are `repoStepCount`'s call, like the `repo_step_total === 0` one.
     *
     * `repo_step_scanned >= repo_step_done` for every producer, since a row cannot be kept
     * without having been returned.
     */
    repo_step_scanned: number | null;
    repo_step_total: number | null;
}

/** The idle within-repo indicator: no fan-out in flight. */
const NO_REPO_STEP = {
    repo_step: null,
    repo_step_done: 0,
    repo_step_scanned: null,
    repo_step_total: null,
} as const satisfies Pick<
    GitSyncProgress,
    'repo_step' | 'repo_step_done' | 'repo_step_scanned' | 'repo_step_total'
>;

/**
 * Listener for progress snapshots. Called synchronously with a fresh copy each time
 * — it must be cheap and must not block (the sync-now API just stores the latest
 * snapshot for the list endpoint to serve).
 *
 * Since #270 the call frequency is per-ITEM, not per pipeline step: the within-repo
 * indicator reports roughly `2 × commits + prs` times per repo (each provider page,
 * each commit detail, each diff, each PR), each allocating one shallow copy. A
 * listener that does I/O per call — an SSE frame, a DB write — must coalesce; the
 * only in-tree listener assigns the snapshot to a field and is safe.
 *
 * A throw from this listener is swallowed at every report site — it loses that one
 * update and nothing else. It must be: the per-item reports run INSIDE
 * `provider.getCommits`/`getPullRequests`, whose per-repo try/catch would otherwise
 * read a listener bug as a fetch failure, holding the provider's forward cursor and
 * dropping its snapshots (#231). Telemetry must never be able to make that call. The
 * flip side is that a broken listener fails silently — the indicator simply stops
 * moving — so a listener is responsible for its own error reporting.
 */
export type GitSyncProgressListener = (progress: GitSyncProgress) => void;

// Hard bounds for the first-sync history window (in whole months), enforced at the
// API trust boundary AND defensively here. Integer, inclusive on both ends: the
// lower bound keeps the window meaningful (a 0-month window would import nothing on
// the first sync), the upper bound stops "6 months" quietly becoming "walk the
// org's entire history" and re-draining the very rate-limit quota this feature
// exists to protect.
export const FIRST_SYNC_WINDOW_MIN_MONTHS = 1;
export const FIRST_SYNC_WINDOW_MAX_MONTHS = 60;
export const FIRST_SYNC_WINDOW_DEFAULT_MONTHS = 6;

// The earliest-synced watermark sentinel meaning "history synced back to the repo's
// first commit" (#229). A walk-all first sync (no window clamp → `since === ''`)
// imported everything, so nothing older exists to backfill; we record this epoch
// instant as the floor rather than '' (which the watermark accessor would read as
// "unset" and fall through to the lazy default). The overlap guard then rejects any
// backfill against such a provider, because every real target is `>=` the epoch.
export const EARLIEST_SYNC_EPOCH = new Date(0).toISOString();

/**
 * Hard cap (in whole days) on the span a SINGLE run re-fetches when a provider's
 * cursor has been held back (#235).
 *
 * #231 holds a provider's cursor whenever its window was not fully covered, so the
 * span still to re-cover is `[storedCursor, now]` — which GROWS every run the
 * provider stays broken. Left uncapped, a provider stalled for months eventually
 * asks each run to walk a months-long commit window across every repo (and one
 * per-commit diff request PER commit), so the cost of a stall compounds into the very
 * rate-limit drain the first-sync window cap exists to prevent.
 *
 * Capping `until` (never `since`) is what keeps this gap-free: the window is
 * CHUNKED, not skipped. A held cursor advances at most one cap-width per complete
 * run and the next run resumes exactly where this one stopped, so a recovering
 * provider catches up over consecutive runs. Clamping `since` forward instead would
 * bound the cost by silently dropping `[storedCursor, now - cap]` — the permanent
 * snapshot gap #231 exists to prevent.
 *
 * 30 days: wide enough that a healthy daily/weekly sync NEVER hits it (an
 * uncapped `until === now` is the unchanged normal path), narrow enough that one
 * catch-up run stays a bounded fetch.
 *
 * WHAT THIS DOES AND DOES NOT BOUND — the honest scope, because "a stalled run costs
 * a constant amount" is NOT true in general:
 *   - BOUNDED everywhere: the commit walk's `[since, until]` span, and with it the
 *     per-commit detail/diff fan-out inside `getCommits` (one API call PER COMMIT —
 *     usually the largest single cost of a catch-up; since #271 that is ONE call per
 *     commit rather than two, which halves this term but does not change what bounds it).
 *   - BOUNDED since #247: the per-PR review FAN-OUT. `getPullRequests(repo, state,
 *     since)` still takes no `until` (see GitProvider), so a run lists every PR touched
 *     since the cursor — the list rows all still feed the snapshot (prs_opened/prs_merged
 *     stay whole) — but the fan-out that dominates its cost (getReviewComments +
 *     getPRReviews, 2 API calls PER PR) is filtered to the same `[since, until]` window as
 *     the commit walk (prWithinFetchWindow, keyed on the `updatedAt` #247 added to GitPR).
 *     This collapses the recovery amplification the cap used to ADD — a 200-day recovery
 *     no longer re-fans 200+170+…+20 = 770 PR-days of reviews across 7 chunks, only the
 *     ~1x disjoint total (each PR is fanned out in exactly one chunk) — and bounds the
 *     stalled case. Lossless for the fan-out: a PR deferred for `updatedAt > until` is
 *     re-listed and fanned out on the next chunk (whose `since` IS this `until`). The one
 *     residual, on the multi-chunk recovery/backfill path only: `review_comments_given` is
 *     a per-day aggregate built from the fetched comments and max()-merged, so same-day
 *     comments on PRs whose `updatedAt` straddles a chunk boundary can undercount that day
 *     — a bounded, conservative error of the same class git_snapshots already accepts for
 *     lacking a provider/PR dimension (#192 SEC-2). See prWithinFetchWindow.
 *   - STILL UNBOUNDED: the PR LIST paging itself. github/bitbucket page PRs by
 *     `updated_at` DESC, so the out-of-window (newest) PRs sort FIRST and must be paged
 *     through to reach `[since, until]` — an upper bound on the list call cannot skip
 *     them. That paging is one list request per ~50–100 PRs though, far cheaper than the
 *     2-per-PR fan-out #247 bounds; the dominant cost is handled.
 *   - PROVIDER-DEPENDENT (commit walk): github/gitlab push `since`+`until` to the server,
 *     so the cap really does shrink what is listed. Bitbucket's getCommits pages from HEAD
 *     newest-first and breaks only when it crosses `since`, filtering `until` in memory —
 *     so for Bitbucket the cap bounds the diff fan-out but NOT the commit paging, and a
 *     chunked recovery re-pages HEAD→since once per chunk.
 */
export const GIT_CATCHUP_WINDOW_MAX_DAYS = 30;

/**
 * Pauses before each IN-RUN retry of a repo whose commit fetch threw (#272) — so
 * `[5min, 15min]` means "attempt, +5min, +15min", three attempts in total.
 *
 * This is the second layer of the same defence as `providers/http-retry.ts`. That layer
 * retries the failing REQUEST over ~2.5 minutes; this one retries the whole REPO after the
 * request layer has already given up, because the alternative is catastrophically
 * asymmetric: a repo's commit fetch failing leaves the provider's `[since, until]` window
 * incompletely covered, which correctly holds the cursor and discards EVERY provider's
 * partial data for the run (see `ProviderFetchResult.complete`). An initial full-history
 * sync makes thousands of per-commit requests over hours, so the chance of at least one
 * blip somewhere is high — and each one used to cost the entire run. On a multi-hour run
 * these pauses are free; losing the run is not.
 *
 * The all-or-nothing rule is deliberately untouched. This makes reaching it rare, not
 * cheap: after these retries are exhausted the behavior is exactly as before.
 *
 * Only faults that could plausibly heal are retried ({@link isRetryableGitFetchError}) —
 * a 401 or a 404 is a deterministic answer, and pausing 20 minutes per repo to re-ask it
 * would turn one bad credential into a run that never finishes.
 */
export const GIT_REPO_RETRY_DELAYS_MS: readonly number[] = [5 * 60_000, 15 * 60_000];

/**
 * Total time ONE provider's run may spend asleep in {@link GIT_REPO_RETRY_DELAYS_MS} pauses,
 * across all of its repos (#272).
 *
 * Without this the retry budget is per repo, so a provider-wide outage — which is the common
 * shape, since a 5xx is usually the provider being unhealthy rather than one repo being
 * cursed — costs `20 min × repos`. At 30 repos that is 10 hours of pure sleeping, the
 * pipeline's connector-level retry then doubles it, and the daily cron starts the next run on
 * top of the previous one. All to reach exactly the pre-#272 outcome: cursor held, partials
 * dropped.
 *
 * 40 minutes lets the first two repos spend their full sequence — enough to ride out the
 * multi-minute blip this is for — and then stops paying. Repos after that fail immediately
 * with the same recorded error, which is the honest answer once two repos in a row have
 * proved the provider is down rather than flaky.
 */
export const GIT_RUN_RETRY_SLEEP_BUDGET_MS = 40 * 60_000;

/**
 * The share of {@link GIT_RUN_RETRY_SLEEP_BUDGET_MS} a BEST-EFFORT fetch may draw to (#272) —
 * the PR list and the per-PR review fan-out, whose failure is recorded but does NOT hold the
 * provider's cursor.
 *
 * A reserve, not a second pool. Both kinds spend from the same counter; capping the best-effort
 * one lower guarantees at least `GIT_RUN_RETRY_SLEEP_BUDGET_MS - this` is still available to the
 * commit fetch, whose failure discards every provider's data for the whole run. Without it the
 * cheap failure spends the expensive failure's insurance: repo 1's PR retries exhaust the pool,
 * repo 2's commit fetch is then refused its pause, and the run is lost to a fault a five-minute
 * wait would have healed.
 */
export const GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS = 20 * 60_000;

/**
 * Total WALL CLOCK one `runSync` call may span, across every provider, repo and request (#283).
 *
 * The two budgets above bound only the REPO-level pauses. Nothing bounded the request layer's
 * own sleeping in aggregate — each request carries its own `MAX_SERVER_ERROR_RETRIES × 120s`
 * (see `SERVER_ERROR_MAX_DELAY_MS`: a host answering `503 Retry-After: 3600` pins every pause
 * to the cap, so ~10 minutes PER REQUEST), and the per-commit fan-out is an O(commits)
 * population of such requests. Run length was therefore a function of the provider's behaviour
 * with no ceiling at all, and length is not cosmetic here: `sync-pipeline` re-runs a failed
 * connector once, and two overlapping git runs read the same forward cursor into an ADDITIVE
 * commit merge — a permanent double-count (see `sync-log.ts`).
 *
 * FOUR HOURS, chosen against what actually runs on top of it rather than as a round number:
 * `runConnectorWithRetry` grants a failed connector one full second attempt, so the ceiling an
 * operator should quote for a scheduled git sync is ~8 hours + the 5-minute retry pause — well
 * inside the daily cadence, and now genuinely a ceiling rather than an estimate.
 *
 * The USABLE budget is smaller than the number for a rate-limited org, and deliberately so: a
 * pause is refused rather than truncated (see `sleepWithinRun`), so a run with 50 minutes left
 * that meets a 55-minute rate-limit reset stops there. Truncating instead would spend the last
 * 50 minutes and still not have waited the wall out. Read this as "at most four hours", not "a
 * guaranteed four hours of fetching".
 *
 * A run that hits it fails like any other incompletely-covered window: #231 holds the cursor
 * and drops the run's partial snapshots. That is only sound because of #273 — every per-commit
 * diffstat the run fetched is memoized OUTSIDE the write transaction, so the next run re-pages
 * the commit lists and serves the whole fan-out from the memo, redoing strictly less of the
 * dominant cost each time.
 *
 * That ratchet covers the per-commit fan-out and NOTHING ELSE: the commit-list paging and the
 * per-PR review fan-out are re-paid in full every run, so convergence holds iff the un-memoized
 * work for one window fits in the budget. {@link GIT_CATCHUP_WINDOW_MAX_DAYS} bounds that window
 * to 30 days on any cursor-resuming run, which is what makes the condition hold in practice; a
 * first sync is deliberately uncapped, so an initial import too large for one run stops at the
 * same place until an operator narrows it — which is why {@link runDeadlineLine} names that lever.
 * See {@link GitRunDeadline} for the same argument from the request layer's side.
 */
export const GIT_RUN_WALL_CLOCK_BUDGET_MS = 4 * 60 * 60_000;

/**
 * The two RUN-level bounds a sync carries into every provider: how long it may sleep in
 * repo-level retry pauses, and when it must stop altogether (#283).
 *
 * One object rather than two parameters because they are the same kind of thing — the run's
 * shared, mutable-in-one-direction budget — and because a future third bound should not widen
 * `fetchProviderData`'s already long signature again. Shared across PROVIDERS by construction:
 * a wide outage must not cost `budget × providers`, which is the defect #272's review cycle 3
 * found when the sleep counter was per provider.
 */
export interface GitRunBudget {
    /** Time the run has already spent asleep in {@link GIT_REPO_RETRY_DELAYS_MS} pauses. */
    retrySleepMs: number;
    /** The run's wall clock — see {@link GIT_RUN_WALL_CLOCK_BUDGET_MS}. */
    readonly deadline: GitRunDeadline;
}

/**
 * The sentinel marking the line a run emits when it stopped because it ran out of wall clock.
 *
 * A genuine FAILURE, not an advisory (it is deliberately absent from `ADVISORY_PREFIXES`): the
 * provider's window was not covered, its cursor is held and its partial snapshots are dropped,
 * so the run must go red and `sync-pipeline` must be allowed its retry — the retry starts with
 * a fresh deadline and a warm diffstat memo, which is exactly the ratchet that makes the run
 * eventually finish.
 */
export const RUN_DEADLINE_PREFIX = 'Run stopped at its wall-clock budget:';

/**
 * The operator-facing line for a run that ran out of wall clock, with the one number that
 * tells them whether to widen the window or investigate the provider: how far it got.
 *
 * Exported so the test asserts against the string the code emits rather than a copy of it —
 * the same reason `autoCreateFailureLine` is.
 *
 * The last sentence is deliberately CONDITIONAL rather than a promise (#283 review, SO-2).
 * Only the per-commit detail fan-out is memoized; the commit-list paging and the whole per-PR
 * review fan-out are re-paid in full every run. So "the next run gets further" holds for the
 * memoized half and is not unconditional overall — if the un-memoized work alone exceeds the
 * budget, consecutive runs stop at the same place and the operator needs a lever, which is why
 * one is named here rather than left for them to infer.
 */
export function runDeadlineLine(
    providerType: GitProviderType,
    reposDone: number,
    reposTotal: number,
): string {
    return (
        `${RUN_DEADLINE_PREFIX} [${providerType}] stopped after ${reposDone} of ${reposTotal} ` +
        `repo(s) — the run reached its ${Math.round(GIT_RUN_WALL_CLOCK_BUDGET_MS / 60_000)} min ` +
        'limit, so this window was not fully covered: the cursor is held and the whole window is ' +
        're-covered next run. Per-commit diffstats already fetched are kept, so the next run ' +
        'redoes less. If this repeats with the same repo count, the un-memoized work (commit-list ' +
        'paging and the per-PR review fan-out) does not fit in one run on its own — narrow the ' +
        'provider with repos/exclude_repos.'
    );
}

/**
 * The line for a provider the run never reached at all, because an EARLIER provider in the
 * same run spent the shared wall clock (#283 review, SO-3).
 *
 * Its own sentence rather than `runDeadlineLine(type, 0, 0)`, which rendered as "stopped after
 * 0 of 0 repo(s)" — a phrasing that reads as "this provider has no repositories", the opposite
 * of the truth (it never got as far as listing them).
 *
 * Carries the same {@link RUN_DEADLINE_PREFIX} as {@link runDeadlineLine} — those two are the
 * only wall-clock shapes, and every consumer that classifies a stop sees both. Equally a
 * FAILURE: this provider's window is uncovered and its cursor is held.
 *
 * Used for BOTH not-reached shapes: the provider whose turn never came, and the one whose
 * clock expired inside `listRepos` (there too no repo was reached, so a "0 of N" count would
 * be the same misreading).
 */
export function providerNotReachedLine(providerType: GitProviderType): string {
    return (
        `${RUN_DEADLINE_PREFIX} [${providerType}] not reached — an earlier provider in this run ` +
        `spent the shared ${Math.round(GIT_RUN_WALL_CLOCK_BUDGET_MS / 60_000)} min wall-clock ` +
        'budget, so no request was made for this provider and its cursor is held. Providers are ' +
        'fetched in configuration order out of ONE budget, so a provider that consistently fills ' +
        'it will starve every provider after it — reorder or narrow that provider if this repeats.'
    );
}

/**
 * The upper bound a forward run should actually fetch to, given the cursor it is
 * resuming from (#235): `now` normally, or `since + GIT_CATCHUP_WINDOW_MAX_DAYS`
 * when a held cursor left a wider span to re-cover.
 *
 * Total by construction — an unparseable bound, or a `since` at/after `now` (a
 * clock skew or a hand-edited cursor), degrades to `now`, i.e. the uncapped
 * behavior this replaced. Never returns an instant after `now`, so a future-dated
 * cursor can't push the window past the present. Exported for tests.
 */
export function catchUpUntil(since: string, now: string): string {
    const sinceMs = Date.parse(since);
    const nowMs = Date.parse(now);
    if (Number.isNaN(sinceMs) || Number.isNaN(nowMs)) return now;
    const capMs = GIT_CATCHUP_WINDOW_MAX_DAYS * 86_400_000;
    if (nowMs - sinceMs <= capMs) return now;
    return new Date(sinceMs + capMs).toISOString();
}

/**
 * Whether a PR's expensive review FAN-OUT (getReviewComments + getPRReviews) should run
 * this run (#247) — i.e. its last activity is at or before the run's upper bound `until`.
 *
 * This gates the FAN-OUT ONLY, never whether the PR feeds the snapshot. The list row is
 * already in hand and cheap, so the caller pushes EVERY listed PR into `allPRs`
 * (keeping prs_opened/prs_merged whole — see the SO-1 note at the call site); this
 * predicate only decides whether to spend the two per-PR review API calls now.
 *
 * `getPullRequests(repo, state, since)` takes no upper bound (see GitProvider), so a run
 * lists every PR touched since the cursor and — before this gate — fanned out two API
 * calls PER PR over the whole `[since, now]` span, unbounded while a cursor is held and
 * AMPLIFIED chunk-by-chunk on a capped recovery. Gating on `updatedAt <= until` fans each
 * PR out in EXACTLY ONE chunk (its `updatedAt` lands in exactly one contiguous
 * `[since, until]`), collapsing the amplification to ~1x.
 *
 * LOSSLESS for the fan-out: a PR touched in `(until, now]` has `updatedAt > until`, and a
 * capped run advances the cursor to exactly `until` (see forwardCursorTarget), so the next
 * run's `since` IS this run's `until` and re-lists it (`getPullRequests` fetches
 * `updatedAt >= since`); it is fanned out then. The final uncapped chunk (`until === now`)
 * defers nothing. On backfill, `until` is the earliest watermark, so a PR updated after it
 * is already covered by the forward window.
 *
 * KNOWN RESIDUAL (recovery/backfill only): `review_comments_given` is a per-day aggregate
 * built from the fetched comments and max()-merged across runs. Because each PR is fanned
 * out in only one chunk, two same-day comments on PRs whose `updatedAt` straddles a chunk
 * boundary are seen in different runs, so max() can undercount that day. Bounded, rare
 * (multi-chunk catch-up with same-day cross-PR comment activity), and the same class of
 * conservative undercount git_snapshots already accepts for lacking a provider/PR
 * dimension (#192 SEC-2). prs_opened/prs_merged are NOT affected — they come from the
 * always-complete `allPRs` list, whose widest first chunk captures the full set. The
 * per-PR `pr_records` review fields do NOT durably undercount either: each PR is fanned
 * out in exactly one chunk (writing its full counts then), a deferred PR carries prior
 * counts forward via upsertPRRecord, and a first-seen deferred PR's transient zeros
 * converge on the re-fan next chunk.
 *
 * Compared as PARSED INSTANTS, never as strings: provider `updatedAt` values are raw API
 * timestamps (github `...:00Z`, no millis) while `until` is a `toISOString()` value
 * (`...:00.000Z`), so a lexical `<=` would mis-order equal instants. Total and FAIL-OPEN:
 * an unparseable `until` (no usable bound) or an unparseable `updatedAt` (can't place the
 * PR) runs the fan-out — a bounded extra fetch, never a silent drop.
 */
export function prWithinFetchWindow(updatedAt: string, until: string): boolean {
    const untilMs = Date.parse(until);
    if (Number.isNaN(untilMs)) return true;
    const updatedMs = Date.parse(updatedAt);
    if (Number.isNaN(updatedMs)) return true;
    return updatedMs <= untilMs;
}

/** Knobs a sync run accepts beyond the provider set. */
export interface SyncRunOptions {
    /**
     * On a provider's FIRST sync (no stored cursor yet) clamp the history window to
     * `now - firstSyncWindowMonths` instead of walking all history from ''. This is
     * the lever that stops run #1 draining a provider's whole rate-limit budget.
     *
     * IGNORED once a provider has a stored cursor: `since` is cursor-derived and the
     * snapshot upsert is additive, so re-widening the window on a later run would
     * double-count the already-recorded span. Omitting it (undefined) preserves the
     * legacy "walk all history on first sync" behavior — the scheduled path passes
     * nothing and is deliberately unchanged. Residual exposure (out of scope for
     * #228, which scoped the cap to the "Sync now" button): a fresh org first synced
     * by the scheduler or `toprope sync all` — including config-file providers, which
     * can ONLY sync that way — still walks all history and drains the quota. Bounding
     * the automated path is a follow-up, not this issue.
     */
    firstSyncWindowMonths?: number;
    /**
     * "Sync older history" backfill (#229): extend a provider's synced window
     * BACKWARD by fetching the fixed, strictly-older commit slice [since, until]
     * and additively merging it. `until` is the provider's current earliest
     * watermark and `since` the new (older) target; the caller (the backfill route)
     * computes both and enforces `since < until` (the overlap guard) BEFORE
     * dispatching, so the slice is always disjoint from already-stored activity and
     * the additive snapshot merge stays correct — no double-count.
     *
     * In this mode the run does NOT advance the forward cursor (normal "Sync now"
     * must keep resuming from now); instead it LOWERS the earliest watermark to
     * `since`. `firstSyncWindowMonths` is IGNORED. Omitted on every non-backfill
     * path (first/incremental/scheduled sync), which is unchanged.
     */
    backfill?: {since: string; until: string};
}

/**
 * The `since` cursor for a provider's FIRST sync given a window in whole months:
 * `now - months`, in UTC ISO. `undefined` months (or a value outside the hard
 * bounds / a bad `now`) falls back to '' — i.e. walk all history — so a caller that
 * skips the window, or an out-of-range value that slipped past validation, degrades
 * to the legacy behavior rather than importing a wrong window. Exported for tests.
 *
 * The bounds/integer/NaN checks are a DELIBERATE belt-and-suspenders backstop: the
 * only production caller is the API route, which already rejects out-of-range values
 * fail-closed (parseFirstSyncWindowMonths). Keeping this a total, self-defending pure
 * function lets it stand alone and honors the project rule to range-validate numeric
 * config on both bounds even if a future caller forgets to.
 */
export function firstSyncSince(now: string, months: number | undefined): string {
    if (
        months === undefined ||
        !Number.isInteger(months) ||
        months < FIRST_SYNC_WINDOW_MIN_MONTHS ||
        months > FIRST_SYNC_WINDOW_MAX_MONTHS
    ) {
        return '';
    }
    // '' when `now` is unparseable (an out-of-range/bad value degrades to walk-all,
    // matching the pre-refactor behavior).
    return subtractUtcMonths(now, months) ?? '';
}

/**
 * `now` minus `months` whole months, in UTC ISO — or null if `now` is unparseable.
 * The single home for this arithmetic, shared by the first-sync window
 * ({@link firstSyncSince}) and the "sync older history" backfill target (#229,
 * {@link getEarliestSyncedWatermark} and the backfill route). `months` must be a
 * validated non-negative integer; callers own range-validation.
 *
 * UTC month arithmetic (all toprope timestamps are UTC); JS handles the year
 * rollover when the subtraction crosses January. Day-of-month is preserved, so a
 * long-month `now` (e.g. Mar 31) minus 1 lands on the normalized short-month date
 * (Mar 3), making the window a few days SHORTER than a strict calendar month —
 * never longer. That direction is safe (it can only under-import, never re-drain
 * quota / re-cover an already-synced span), and the window edge is inherently
 * coarse, so we accept the drift.
 */
export function subtractUtcMonths(now: string, months: number): string | null {
    const start = new Date(now);
    if (Number.isNaN(start.getTime())) return null;
    start.setUTCMonth(start.getUTCMonth() - months);
    return start.toISOString();
}

// Mutate-then-emit reporter threaded through the pipeline: applies `mutate` to
// the run's single progress state, then emits a defensive copy so a listener
// can never mutate pipeline state. Undefined when no listener was passed, so
// the scheduled path pays nothing.
type ProgressReporter = (mutate: (progress: GitSyncProgress) => void) => void;

export function syncStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_last_sync:${providerType}:${identifier}`;
}

/**
 * The sync_state key for a provider's EARLIEST-synced watermark (#229) — the
 * oldest instant whose activity has been imported. Parallel to the forward cursor
 * {@link syncStateKey} (`git_last_sync:…`); only the "sync older history" backfill
 * reads/writes it. Disjoint namespace so it can never be confused with the cursor.
 */
export function earliestSyncStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_earliest_sync:${providerType}:${identifier}`;
}

/**
 * Whether a provider's earliest-synced floor is UNKNOWN and unrecoverable (#233) —
 * i.e. it is LEGACY, first synced before #229 began recording the floor.
 *
 * DERIVED, not stored. `cursor present ∧ watermark absent` ⟺ legacy, because a
 * post-#229 first sync writes BOTH inside the same deferred closure, applied in the
 * same snapshot transaction (see the `cursorAdvances` push in {@link GitSync.syncProviders});
 * and that closure is the ONLY writer of a `git_last_sync:` cursor. So for any provider
 * synced by this build the two keys can never be out of step — only a provider whose
 * first sync predates that build can hold a cursor with no floor.
 *
 * Deriving beats seeding a marker row at upgrade time: a marker freezes the legacy set
 * at one instant and then needs reconciling whenever a real floor is recorded, which is
 * a second source of truth that can drift. The predicate is true at EVERY instant, so it
 * also fails closed on a cursor-without-floor that appears later (a partial restore, a
 * hand-edited row, a future code path) — states a migration-seeded marker would miss and
 * silently fall back to the too-recent guess for.
 */
function isEarliestFloorUnknown(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): boolean {
    // Falsy, not just null: a blank-valued floor row is no floor at all, and treating it
    // as present here (while getEarliestSyncedWatermark's `if (stored)` treats it as
    // absent) would disagree with that reader and fail OPEN — back to the too-recent
    // guess for a provider that has a cursor, the exact defect this exists to close.
    return (
        !getSyncStateValue(db, earliestSyncStateKey(providerType, identifier)) &&
        getSyncStateValue(db, syncStateKey(providerType, identifier)) !== null
    );
}

/**
 * Every git sync-state cursor key currently stored, resolved in ONE query. The
 * admin list uses this to tell whether a provider's FIRST sync is still pending
 * (no cursor yet) — the real gate the "Sync now" window input keys off. Read once
 * per list request and membership-tested in memory, never per-row: a stored cursor
 * (written by the pipeline on EVERY path — sync-now, scheduler, and CLI) is the
 * authoritative "has synced" signal, and it diverges from the row's `last_sync_at`
 * column (which only the sync-now route writes).
 */
export function loadProviderCursorKeys(db: Database.Database): Set<string> {
    const rows = db
        .prepare("SELECT key FROM sync_state WHERE key LIKE 'git_last_sync:%'")
        .all() as Array<{key: string}>;
    return new Set(rows.map((r) => r.key));
}

// ─── Stalled-provider detection (#235) ────────────────────────────────────────
//
// #231 made a provider's cursor advance atomic with — and conditional on — a
// COMPLETE fetch: any `listRepos`/`getCommits` failure holds the WHOLE provider's
// cursor so its window re-covers next run rather than leaving a silent snapshot
// gap. That is the right correctness trade-off, but it has an operational cost this
// tracks: one repo that fails permanently (oversized, permission drift,
// deleted-but-still-listed) holds the cursor forever, so no developer on ANY of
// that provider's other repos gets a new snapshot until a human excludes it.
//
// `errors[]` alone cannot say that. In a multi-provider run a healthy sibling still
// writes, so a permanent stall is shaped exactly like a transient per-repo hiccup —
// the run "succeeded". The counter below is the missing distinct signal: it makes
// "provider X's cursor has not advanced for N consecutive runs" queryable, which is
// what `toprope status` / `toprope doctor` report.

/**
 * Consecutive held-cursor runs before a provider is REPORTED as stalled.
 *
 * Not 1: a single held run is the common, self-healing case (a rate-limit blip, a
 * flaky 502) and alerting on it would train the reader to ignore the signal. Three
 * consecutive runs cannot be explained away — whatever the repo is doing, it is not
 * transient, and every run since the first has imported nothing.
 */
export const GIT_STALL_ALERT_RUNS = 3;

/**
 * The sync_state key for a provider's consecutive-stalled-runs counter (#235).
 * A THIRD namespace, disjoint from both the forward cursor {@link syncStateKey}
 * (`git_last_sync:…`) and the earliest watermark {@link earliestSyncStateKey}
 * (`git_earliest_sync:…`), so a stall row can never be read as either.
 */
export function stallStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_stall:${providerType}:${identifier}`;
}

/** A provider's current consecutive-stall streak (#235). */
export interface GitProviderStall {
    /** Consecutive runs that held this provider's cursor. Always >= 1. */
    runs: number;
    /** UTC ISO instant of the FIRST run in the current streak — "stalled since". */
    since: string;
}

/**
 * Decode a stored stall row, or null when there is no usable streak.
 *
 * `sync_state.value` is an unconstrained TEXT column, so the stored JSON is parsed
 * and RANGE-VALIDATED rather than cast: a row that is absent, unparseable, or
 * carries a non-positive/non-integer `runs` or an unparseable `since` is treated as
 * "no streak". That is deliberately self-healing rather than fail-closed — this is
 * a diagnostic counter, not an authorization gate, and the alternative (reporting a
 * corrupt row as a stall of `NaN` runs) is a false alarm that no remedy clears. The
 * next incomplete run rewrites the row from scratch; the next complete run deletes
 * it.
 */
function parseStall(value: string | null): GitProviderStall | null {
    if (!value) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const {runs, since} = raw as {runs?: unknown; since?: unknown};
    if (!Number.isInteger(runs) || (runs as number) < 1) return null;
    if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) return null;
    return {runs: runs as number, since};
}

/** The current stall streak for one provider (#235), or null if it is not stalled. */
export function getProviderStall(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): GitProviderStall | null {
    return parseStall(getSyncStateValue(db, stallStateKey(providerType, identifier)));
}

/**
 * Record that this run HELD this provider's cursor (#231's incomplete-fetch path):
 * open a streak at 1, or extend the open one, preserving its original `since`.
 *
 * Read-modify-write — MUST run inside the sync write transaction (see the
 * `stallUpdates` push in {@link GitSync.syncProviders}), which is also what makes it
 * atomic with the cursor decision it mirrors.
 *
 * On concurrency, precisely: better-sqlite3's `db.transaction()` issues a DEFERRED
 * BEGIN, so it does NOT serialize two concurrent runs — both can read `runs: 2`. What
 * it guarantees is that the second one to WRITE fails fast (SQLITE_BUSY) and rolls
 * back whole, so the outcome is "one run's accounting, or none" rather than a lost
 * update. Correct, but by fail-fast, not by mutual exclusion — don't read this as a
 * lock.
 */
function recordProviderStallRun(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    now: string,
): void {
    const open = getProviderStall(db, providerType, identifier);
    const next: GitProviderStall = open
        ? {runs: open.runs + 1, since: open.since}
        : {runs: 1, since: now};
    setSyncStateValue(db, stallStateKey(providerType, identifier), JSON.stringify(next));
}

/**
 * Clear a provider's stall streak — its window was covered completely, so the
 * cursor is advancing again. A no-op DELETE when it was never stalled, which is the
 * overwhelmingly common case and cheaper than reading first to decide.
 */
function clearProviderStall(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): void {
    db.prepare('DELETE FROM sync_state WHERE key = ?').run(stallStateKey(providerType, identifier));
}

/**
 * The sync_state key for a provider's row-refusal record (#306). A FOURTH namespace, disjoint
 * from the forward cursor, the earliest watermark and the stall counter, so a refusal row can
 * never be read as any of them.
 */
export function rowRefusalStateKey(providerType: GitProviderType, identifier: string): string {
    return `git_row_refusal:${providerType}:${identifier}`;
}

/**
 * What a provider's last row-refusing run did, plus its total-refusal streak (#306).
 *
 * Present does NOT mean escalated. The record also carries a sub-threshold streak, exactly as the
 * stall row carries a sub-threshold `runs` count — ask {@link isEscalatedRefusal} for the verdict.
 */
export interface GitRowRefusal {
    /** UTC ISO instant of the run that refused them. */
    at: string;
    /** Author-day rows that run refused. Always >= 1. */
    skipped: number;
    /** Author-day rows that run retained. May be 0 — that is the worst case, not an absent one. */
    retained: number;
    /**
     * Consecutive runs (this one last) whose refusals were the MAJORITY of what they built
     * (`skipped >= retained`); 0 when the last such run wrote more than it refused.
     * See {@link TOTAL_REFUSAL_ALERT_RUNS}.
     */
    runs: number;
    /**
     * STICKY: some run of this provider has already escalated, whether or not THIS one does.
     *
     * The record is rewritten wholesale by every refusing run, so without this the verdict lives
     * only in the last run's two counts — and the ordinary next-day window (one chronically bad PR
     * timestamp among five good rows) is below every threshold, so it silently downgraded an
     * escalation raised over a window that is permanently gone. That is the same erasure
     * {@link clearRowRefusal} is deliberately hardened against, reached through the UPDATE path
     * instead of the DELETE path. Once true it survives every rewrite; only `clearRowRefusal`'s
     * strict gate (refused nothing AND retained something) drops it, by deleting the record.
     */
    escalated: boolean;
}

/**
 * A count decoded out of `sync_state.value`: a non-negative safe integer, bounded on BOTH ends.
 *
 * The upper bound is not decoration. `doctor` renders `${r.skipped} of ${r.skipped + r.retained}`,
 * so a value past `Number.MAX_SAFE_INTEGER` prints an imprecise sum, and the graduated rule is
 * explicit that a numeric field at a trust boundary is range-validated on both bounds rather than
 * only checked for non-negativity. `Number.isSafeInteger` is the same predicate `isCommitCount`
 * uses one module over, for the same reason.
 */
function isStoredCount(value: unknown, min: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

/**
 * Decode a stored refusal record, or null when there is nothing usable to report.
 *
 * Same shape of totality as {@link parseStall} and for the same reason: `sync_state.value` is an
 * unconstrained TEXT column, so the JSON is parsed and range-validated rather than cast. It is
 * self-healing rather than fail-closed — a corrupt row reported as a refusal of `NaN` rows is a
 * false alarm no remedy clears, and the next run of that provider rewrites or deletes it.
 *
 * `at` goes through {@link isUtcIsoInstant}, the module's canonical instant check, rather than a
 * local regex. A `Date.parse` liveness test is NOT a shape check — the graduated #233 rule exists
 * because ISO 8601 expanded years (`+010000-01-01T00:00:00.000Z`) parse finite and compare wrong,
 * and V8's legacy parser additionally accepts free text and parenthesised comments carrying
 * arbitrary bytes — and the anchored regex ALONE is not enough either: it admits `2025-02-30`,
 * which `doctor` would then print as a date that does not exist. The canonical predicate is the
 * regex AND the `toISOString()` round-trip, so it is both, and reusing it is what stops this
 * becoming a third weaker copy of the same rule.
 */
function parseRowRefusal(value: string | null): GitRowRefusal | null {
    if (!value) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const {at, skipped, retained, runs, escalated} = raw as {
        at?: unknown;
        skipped?: unknown;
        retained?: unknown;
        runs?: unknown;
        escalated?: unknown;
    };
    if (typeof at !== 'string' || !isUtcIsoInstant(at)) return null;
    // `skipped >= 1` because a record of zero refusals describes nothing; the other two may be 0.
    if (!isStoredCount(skipped, 1)) return null;
    if (!isStoredCount(retained, 0)) return null;
    if (!isStoredCount(runs, 0)) return null;
    // Strict `=== true`, and absent decodes as false rather than rejecting the record: the sticky
    // flag is an ADDITION to the verdict, never the whole of it. A record written before the flag
    // existed still escalates if its own counts trip an arm, because {@link escalationArm}
    // recomputes those from `skipped`/`retained`/`runs` — so the only thing a missing flag can
    // lose is stickiness the old writer never claimed.
    return {at, skipped, retained, runs, escalated: escalated === true};
}

/**
 * Does this record warrant turning a provider red (#306)? The ONE predicate every surface asks,
 * so the sync's error line, `loadGitSyncHealth` and `doctor` cannot disagree about the verdict.
 *
 * THREE ARMS, because one run, a sequence of runs, and the history of the provider fail
 * differently. `ratio` catches a large window mostly refused — a first sync that builds 40,000
 * rows and writes none escalates immediately, on run 1. `streak` catches a small window mostly
 * refused, repeatedly: the per-run floor is blind to that, and it is the shape a small org
 * actually sees on a daily sync. `carried` is the sticky flag — a verdict already raised is not
 * un-raised by a later, healthier window, because that window is a DIFFERENT span and says
 * nothing about the one that was lost.
 */
export function isEscalatedRefusal(refusal: GitRowRefusal): boolean {
    return escalationArm(refusal) !== null;
}

/**
 * WHICH arm escalated this record, or null if neither did (#306).
 *
 * One function rather than each surface re-deriving it, because they were already drifting: the
 * sync line asked `isSystemicRowRefusal(...)` and `doctor` asked `runs >= TOTAL_REFUSAL_...`,
 * which are complementary rather than equal — a record that trips BOTH got a different story from
 * each. The arm decides only the sentence an operator reads, but "the sentence an operator reads"
 * is the whole product of this feature, so it gets the same single-source treatment as the
 * verdict.
 *
 * `ratio` wins a tie deliberately: it names a magnitude ("40 of 40 refused"), which is the more
 * specific statement, and a record that trips it has always also just refused everything.
 *
 * `carried` is checked LAST, so it is only ever the answer when THIS run's counts trip nothing.
 * That ordering is what makes the operator sentence honest: an arm naming what just happened is
 * preferred, and `carried` is reserved for "this run looked better, the earlier loss stands".
 */
export function escalationArm(refusal: GitRowRefusal): 'ratio' | 'streak' | 'carried' | null {
    if (isSystemicRowRefusal(refusal.skipped, refusal.retained)) return 'ratio';
    if (refusal.runs >= TOTAL_REFUSAL_ALERT_RUNS) return 'streak';
    return refusal.escalated ? 'carried' : null;
}

/** The row-refusal record for one provider (#306), escalated or not, or null if there is none. */
export function getProviderRowRefusal(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): GitRowRefusal | null {
    return parseRowRefusal(getSyncStateValue(db, rowRefusalStateKey(providerType, identifier)));
}

/**
 * Record what this run refused for this provider, and where that leaves its total-refusal streak
 * (#306). Read-modify-write of the streak, so it MUST run inside the sync write transaction —
 * which it does, from the cursor-advance closure.
 *
 * DURABLE, and that is the point rather than a convenience. The error line beside it is a
 * per-RUN report, and every surface that keeps one is either absent or overwritten on the path
 * that matters most:
 * - the SCHEDULED path never calls `recordSyncOutcome`, so `git_providers.last_sync_status` and
 *   `last_sync_advisories` — the admin UI's red/green — are written only by the sync-now route
 *   and say nothing at all about a scheduled run;
 * - a CONFIG-FILE provider has no `git_providers` row to record onto in the first place, on any
 *   path, so those two columns can never hold its verdict;
 * - `sync_logs` does retain the line (one row per attempt since #272), but every `latestSync`
 *   -style reader takes the NEWEST row, and the next scheduled run's row is a clean one.
 *
 * So the report survives the run and the verdict does not. `toprope doctor` and `toprope status`
 * read THIS instead — state that no later run clears without actually importing rows, on both
 * provenances.
 *
 * The streak is a property of the SEQUENCE, so it is written even for a run below every
 * escalation threshold — the record existing is not the verdict (see {@link isEscalatedRefusal}).
 *
 * Written in the SAME transaction as the cursor advance, so the claim and the advance can never
 * disagree about whether the window was recorded as covered.
 *
 * NOT RETRIED, unlike every other genuine error: see {@link NON_RETRYABLE_ERROR_PREFIXES} for
 * why a second attempt here loses another window rather than recovering one.
 */
function recordRowRefusal(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    skipped: number,
    retained: number,
    now: string,
): GitRowRefusal {
    const open = getProviderRowRefusal(db, providerType, identifier);
    const provisional: GitRowRefusal = {
        at: now,
        skipped,
        retained,
        // Extended by a run whose refusals were the MAJORITY of what it built, not only by one
        // that wrote nothing at all. `retained === 0` was too strict to be the sequence arm: the
        // per-run floor already declines to judge a small sample, so the shape neither arm saw was
        // a small window mostly — not entirely — refused, run after run. A 4-developer org losing
        // 3 of 4 rows every day cleared no floor (3 < SYSTEMIC_SKIP_MIN_ROWS) and reset the streak
        // every run (retained 1 ≠ 0), so 75% of that provider's data went permanently missing with
        // a green `doctor`, forever. `skipped >= retained` is the same majority predicate the ratio
        // arm uses, minus the floor the sequence makes unnecessary — one run of 1-in-2 is noise,
        // three consecutive is not. A run that writes more than it refuses still restarts it: that
        // is the incidental-loss shape #302 is built around, and it must stay quiet.
        runs: skipped >= retained ? (open?.runs ?? 0) + 1 : 0,
        // Seeded from the open record, then re-decided below. Sticky by construction: see
        // GitRowRefusal.escalated for why a later, healthier window may not clear a verdict.
        escalated: open?.escalated ?? false,
    };
    const next: GitRowRefusal = {
        ...provisional,
        escalated: escalationArm(provisional) !== null,
    };
    setSyncStateValue(db, rowRefusalStateKey(providerType, identifier), JSON.stringify(next));
    return next;
}

/**
 * Clear a provider's refusal record — a later run of it built rows and refused none of them.
 *
 * The caller's gate is deliberately the STRONGEST evidence available, not the weakest: the run
 * must have retained at least one AUTHOR-DAY row and refused no author-day row. Both halves are
 * at that grain, so a run that refused every `pr_records` row can still clear this — consistent
 * with the record being author-day-scoped throughout (see {@link SYSTEMIC_ROW_REFUSAL_PREFIX}'s
 * scope note), and stated here because "refused none" alone would read as covering both.
 *
 * `retained > 0` alone is not enough. A run that retains one row and refuses four is below every
 * threshold, yet deleting a record of a 40,000-row loss on the strength of it would let one
 * mostly-broken daily window erase the verdict on a mostly-broken first sync — and with a daily
 * schedule that is the ordinary next run, not an exotic one.
 *
 * THIS IS THE ONLY EXIT from an escalated verdict, and that is why the gate is this strict.
 * `recordRowRefusal` carries {@link GitRowRefusal.escalated} forward across every rewrite, so a
 * later run cannot downgrade the verdict by being smaller — it can only be dropped here, by a run
 * that built rows and refused none of them. Note what is still NOT claimed by that: the earlier
 * span stays lost. The clear says the CAUSE is gone, which is the most any later run can prove.
 *
 * `skipped === 0` alone is not enough either. A run that built nothing refused nothing, and "no
 * refusals" is then an absence rather than evidence: the graduated rule is that a positive health
 * claim must not be inferred from a narrower check coming back empty. The retry a systemic run
 * provokes is exactly such a run — its window is already covered, so it fetches an empty span.
 *
 * BACKFILL RUNS DO NOT REACH HERE AT ALL (see the cursor-advance closure). A backfill imports a
 * strictly OLDER span and leaves the forward cursor untouched, so however healthy it is it says
 * nothing about the forward window this record is about — and "sync older history" is the first
 * thing an operator reaches for when told data is missing, so clearing on it would be the common
 * path to a false all-clear. Same exclusion, same reason, as the stall accounting beside it.
 */
function clearRowRefusal(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): void {
    db.prepare('DELETE FROM sync_state WHERE key = ?').run(
        rowRefusalStateKey(providerType, identifier),
    );
}

/**
 * A provider that is ADVANCING but is still more than one cap-width behind the
 * present (#235) — a bounded catch-up in progress.
 *
 * This state is CREATED by {@link GIT_CATCHUP_WINDOW_MAX_DAYS}. Before the cap, a
 * complete run always reached `now`, so "the run completed" and "the data is
 * current" were the same statement. They no longer are: a provider recovering from
 * a 200-day stall completes every run and clears its stall streak while its cursor
 * is still ~170 days back, and needs ~6 more runs to catch up. Reporting only the
 * stall streak would call that provider healthy and print "advancing" — technically
 * true, and exactly the false all-clear an operator would act on right after
 * excluding the broken repo that caused the stall.
 */
export interface LaggingProvider {
    type: GitProviderType;
    identifier: string;
    /** The provider's current forward cursor (UTC ISO) — the instant it has synced to. */
    cursor: string;
    /** Whole days between {@link cursor} and now. Always > GIT_CATCHUP_WINDOW_MAX_DAYS. */
    daysBehind: number;
}

/** A provider whose cursor has been stuck long enough to report (#235). */
export interface StalledProvider {
    type: GitProviderType;
    identifier: string;
    /** Consecutive runs that held the cursor — always >= {@link GIT_STALL_ALERT_RUNS}. */
    runs: number;
    /** UTC ISO instant this streak began. */
    since: string;
}

/**
 * The complete git-sync health of an already-resolved provider set (#248), as ONE
 * classification rather than three separate readers over the same two row sets.
 *
 * Every configured provider lands in exactly one of four disjoint states, decided in
 * a single pass:
 * - {@link stalled}: an open streak of >= {@link GIT_STALL_ALERT_RUNS} held runs —
 *   cursor held, importing nothing. The most specific, most actionable signal, so it
 *   wins over every other classification.
 * - {@link lagging}: advancing (no open streak) but with a cursor still more than one
 *   {@link GIT_CATCHUP_WINDOW_MAX_DAYS} cap-width behind `now` — a bounded catch-up.
 * - {@link current}: the POSITIVE check — a cursor within one cap-width of now (and not
 *   ahead of it), with no open streak. This is the only state that lets `doctor` claim
 *   the data is actually current instead of inferring it from two readers coming back
 *   empty (#248).
 * - {@link neverSynced}: no stored cursor at all — a pending first sync.
 *
 * A provider can also be NONE of these: an open sub-threshold streak (1-2 held runs)
 * holds the cursor, so it is neither advancing (excluded from lagging) nor current,
 * and an unreadable or future-dated cursor cannot prove currency either. Those fall
 * through every bucket — which is exactly the point of the positive check: `current`
 * is COUNTED, never inferred, so a held-but-not-yet-reported provider is correctly not
 * counted as healthy. `current + lagging + neverSynced + stalled` therefore need NOT
 * equal the provider count; the remainder is the "not yet current" set doctor names.
 */
export interface GitSyncHealth {
    stalled: StalledProvider[];
    lagging: LaggingProvider[];
    /** Count of providers proven current — cursor within one cap-width of now, no open streak. */
    current: number;
    /** Count of providers with no stored cursor — a pending first sync. */
    neverSynced: number;
    /**
     * Providers whose last run refused most of the author-day rows it built (#306) — ORTHOGONAL
     * to the four states above, not a fifth one.
     *
     * The other four classify the CURSOR: whether it is held, catching up, current, or unset.
     * This classifies the DATA the cursor claims to cover, and the two disagree precisely here —
     * a systemic refusal advances the cursor to `now` over a window it wrote nothing into, so
     * the cursor reads perfectly current. A provider in this list is therefore reported IN
     * ADDITION to whatever cursor state it is in, and is denied `current` credit: currency is a
     * claim about the data, and this is the one row set that proves the claim false.
     */
    systemicRefusals: SystemicRefusalProvider[];
}

/** A provider whose last run's author-day refusals were systemic (#306). */
export interface SystemicRefusalProvider extends GitRowRefusal {
    type: GitProviderType;
    identifier: string;
}

/**
 * Classify every CONFIGURED provider's sync health in ONE pass (#248) — the single
 * canonical reader shared by `toprope doctor` and `toprope status`, so both report the
 * identical set on the identical thresholds.
 *
 * Collapses the former three readers (`loadStalledProviders`, `loadLaggingProviders`,
 * `countNeverSyncedProviders`), which every production caller invoked together over the
 * same `providerConfigs` and which read the `git_stall:%` set twice per run. The two
 * row sets are resolved in exactly ONE query each and membership-tested in memory
 * against the caller's already-resolved provider set — never a query per provider.
 * Filtering to that set (rather than returning every stored row) is what stops a stall
 * or cursor row orphaned by a deleted/renamed provider being reported forever against a
 * target that no longer exists. Order of {@link GitSyncHealth.stalled} and
 * {@link GitSyncHealth.lagging} follows `providerConfigs`, so output is deterministic.
 *
 * Total by construction: an unparseable `now`, or an unparseable/future-dated cursor,
 * yields no lagging entry and no `current` credit for that provider — a garbage or
 * skewed timestamp can never prove currency. See {@link GitSyncHealth} for the full
 * state machine and why the four states need not sum to the provider count.
 */
export function loadGitSyncHealth(
    db: Database.Database,
    providerConfigs: GitProviderConfig[],
    now: string,
): GitSyncHealth {
    const nowMs = Date.parse(now);
    const nowValid = !Number.isNaN(nowMs);

    const cursorByKey = new Map(
        (
            db
                .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'git_last_sync:%'")
                .all() as Array<{key: string; value: string}>
        ).map((r) => [r.key, r.value]),
    );
    const stallByKey = new Map(
        (
            db
                .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'git_stall:%'")
                .all() as Array<{key: string; value: string}>
        ).map((r) => [r.key, r.value]),
    );

    // The third row set, read in the same one-query-per-namespace shape as the two above (#306).
    const refusalByKey = new Map(
        (
            db
                .prepare("SELECT key, value FROM sync_state WHERE key LIKE 'git_row_refusal:%'")
                .all() as Array<{key: string; value: string}>
        ).map((r) => [r.key, r.value]),
    );

    const capMs = GIT_CATCHUP_WINDOW_MAX_DAYS * 86_400_000;
    const stalled: StalledProvider[] = [];
    const lagging: LaggingProvider[] = [];
    const systemicRefusals: SystemicRefusalProvider[] = [];
    let current = 0;
    let neverSynced = 0;

    for (const pc of providerConfigs) {
        const identifier = providerIdentifier(pc);
        const stall = parseStall(stallByKey.get(stallStateKey(pc.type, identifier)) ?? null);
        // Collected BEFORE the disjoint cursor chain below and without a `continue` of its own:
        // this is orthogonal to cursor state (see GitSyncHealth.systemicRefusals), so a provider
        // that is also stalled must appear on BOTH lists rather than have one silence the other.
        const refusal = parseRowRefusal(
            refusalByKey.get(rowRefusalStateKey(pc.type, identifier)) ?? null,
        );
        // ESCALATED records only, for the report AND for the currency denial below.
        //
        // An earlier draft denied currency from the FIRST refused row, by analogy with the
        // sub-threshold stall streak. The analogy does not hold: a stall record means the run
        // imported NOTHING, while a refusal record can mean "99 written, 1 refused" — a run this
        // feature deliberately classifies as green on every other channel (advisory, no error, no
        // report). Denying currency on it makes #248's positive all-clear unreachable forever for
        // any deployment with one chronically malformed PR timestamp, and unreachable with no
        // line naming why, which is the failure mode that teaches an operator to ignore the
        // check. Escalation is the threshold at which "this provider's data is not current" is
        // actually the claim being made, so it is the threshold both decisions key on.
        const escalated = refusal !== null && isEscalatedRefusal(refusal);
        if (escalated) systemicRefusals.push({type: pc.type, identifier, ...refusal!});

        // Reportable stall wins over every other state — the most specific, most
        // actionable signal, and reported even when the provider also has no cursor.
        if (stall && stall.runs >= GIT_STALL_ALERT_RUNS) {
            stalled.push({type: pc.type, identifier, runs: stall.runs, since: stall.since});
            continue;
        }

        const cursor = cursorByKey.get(syncStateKey(pc.type, identifier));
        if (!cursor) {
            // No cursor at all — a pending first sync, not evidence of health.
            neverSynced++;
            continue;
        }

        // An OPEN sub-threshold streak (1-2 held runs) holds the cursor: not advancing
        // (so not lagging) and not current (its data may be months old), it falls
        // through to the "not yet current" remainder until it recovers or trips the
        // stall alert at run GIT_STALL_ALERT_RUNS. Same exclusion the old lagging
        // reader applied — keyed on an OPEN streak, not the reporting threshold.
        if (stall) continue;

        const cursorMs = Date.parse(cursor);
        if (Number.isNaN(cursorMs) || !nowValid) continue; // Cannot place the cursor.

        const behindMs = nowMs - cursorMs;
        if (behindMs > capMs) {
            lagging.push({
                type: pc.type,
                identifier,
                cursor,
                daysBehind: Math.floor(behindMs / 86_400_000),
            });
            continue;
        }
        // A future-dated cursor (behindMs < 0) is clock skew, not proof of currency —
        // clamp it out rather than crediting it. Everything remaining is a cursor within
        // one cap-width of now with no open streak: the positive currency check.
        if (behindMs < 0) continue;
        // A cursor that is current over a window its own run wrote almost nothing into does not
        // prove the DATA is current — it proves the opposite. Denied here rather than subtracted
        // at the surface, so every reader of `current` gets the same answer (#306). Keyed on
        // ESCALATION, for the reason argued where `escalated` is computed.
        //
        // NO CALLER OBSERVES THIS TODAY, and that is stated rather than implied: `doctor` is the
        // only production reader of `current`, and its currency block is gated on having pushed no
        // check at all — which an escalated refusal always has. It stays because `current` is a
        // FIELD of an exported struct, documented as the count of providers whose data is current;
        // counting a provider whose window was refused would make that field's own contract false
        // for anyone who reads it next, and the guard costs one line. It is not a seam for a
        // hypothetical caller — it is the definition of the number already being returned.
        if (escalated) continue;
        current++;
    }

    return {stalled, lagging, current, neverSynced, systemicRefusals};
}

interface SyncStateRow {
    value: string;
}

// The single read/write pair for every `sync_state` row this module owns — the
// forward cursor, the earliest-synced watermark, and the stall counter. Named for
// the VALUE they move rather than for any one caller's meaning: not every row here
// holds a timestamp (the stall counter is JSON), and a `…LastSyncTime` name on the
// generic accessor would make those call sites read as a lie.
function getSyncStateValue(db: Database.Database, key: string): string | null {
    const row = db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(key) as SyncStateRow | undefined;
    return row?.value ?? null;
}

function setSyncStateValue(db: Database.Database, key: string, value: string): void {
    db.prepare(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
}

// Read/write the per-provider earliest-synced watermark (#229). Thin semantic
// wrappers over the generic sync_state accessors above so the "earliest" intent
// is explicit at call sites and the key derivation lives in exactly one place
// ({@link earliestSyncStateKey}) rather than being spelled out per call.
function getProviderEarliestSyncTime(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
): string | null {
    return getSyncStateValue(db, earliestSyncStateKey(providerType, identifier));
}

function setProviderEarliestSyncTime(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    time: string,
): void {
    setSyncStateValue(db, earliestSyncStateKey(providerType, identifier), time);
}

/**
 * Whether a provider's earliest-synced floor is known (#233). `unknown` is the LEGACY
 * case — a provider whose first sync predates #229's floor recording. Callers must
 * branch on `kind` rather than treat a missing watermark as "guess a default": the
 * guess is systematically too recent, which is the additive double-count direction.
 */
export type EarliestSyncedWatermark =
    | {kind: 'exact'; watermark: string}
    | {kind: 'unknown'};

/**
 * The current earliest-synced watermark for a provider — the oldest instant whose
 * activity has already been imported — as UTC ISO. The "sync older history"
 * backfill (#229) extends BELOW this edge: it fetches the strictly-older slice
 * [new_target, watermark], disjoint from everything already stored, so the
 * additive snapshot merge stays correct. The backfill route calls this to both
 * enforce the overlap guard (`new_target < watermark`) and set the fetch's upper
 * bound.
 *
 * The watermark is recorded at FIRST-SYNC time (runSync writes the real floor the
 * first forward sync reached — the clamped window start, or {@link
 * EARLIEST_SYNC_EPOCH} for a walk-all sync) and lowered by every backfill, so for
 * any provider synced by this build it is EXACT — the overlap guard never overlaps
 * an already-imported span. That is the `exact` result.
 *
 * LEGACY PROVIDERS return `unknown` (#233) — see {@link isEarliestFloorUnknown} for how
 * they are identified. Such a provider's true floor (`first_sync_time − window`) is
 * unrecoverable: sync_state stores neither the first-sync instant nor the window it
 * used, and git_snapshots merges every provider into UNIQUE(developer_id, date) rows,
 * so the earliest activity date can't be attributed back to one provider.
 *
 * THIS IS THE RATIONALE THE REST OF THE FEATURE POINTS AT. The previous lazy default
 * (`now` − the #228 window) was a guess, and it is systematically TOO RECENT — the true
 * floor is older by however long ago the provider first synced. Too-recent is precisely
 * the direction that makes the backfill slice OVERLAP already-imported activity, which
 * the additive merge then double-counts, permanently and silently. Guessing too-old is
 * no better (it makes the span between the guess and the true floor un-importable
 * forever), so there is no safe guess: we fail closed and let an admin who knows the
 * real floor declare it ({@link declareEarliestSyncedFloor}, `toprope git
 * set-history-floor`).
 *
 * A provider with NO cursor and no floor is ASSUMED never-synced, and returns the window
 * its first sync would use. Two caveats on that assumption, neither introduced here:
 *  - It is the DEFAULT window. The first sync's window is caller-supplied (1–60 months),
 *    so a backfill run BEFORE that first sync (API-only — the UI hides the control until
 *    a provider has synced) can leave a gap or an overlap against whatever window the
 *    later first sync actually uses. Pre-existing from #229.
 *  - Renaming a provider's container (a supported PATCH) ORPHANS its cursor and floor
 *    rows rather than re-keying them, so the renamed provider reads as never-synced here
 *    while its old activity is still stored. Pre-existing #228-era: the next forward sync
 *    already re-imports its window as a "first" sync.
 */
export function getEarliestSyncedWatermark(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    now: string,
): EarliestSyncedWatermark {
    const stored = getProviderEarliestSyncTime(db, providerType, identifier);
    if (stored) return {kind: 'exact', watermark: stored};
    // Legacy: cursor exists but the floor it reached was never recorded (#233).
    if (isEarliestFloorUnknown(db, providerType, identifier)) return {kind: 'unknown'};
    // Never-synced provider: nothing imported yet, so the window its first sync will
    // use is the honest floor. firstSyncSince returns '' only when `now` is
    // unparseable; fall back to `now` (a zero-width window the caller's overlap guard
    // rejects) rather than '', which downstream would read as "walk all history".
    return {
        kind: 'exact',
        watermark: firstSyncSince(now, FIRST_SYNC_WINDOW_DEFAULT_MONTHS) || now,
    };
}

/**
 * Declare a LEGACY provider's true earliest-synced floor (#233) — the admin-supplied
 * recovery path for a floor {@link getEarliestSyncedWatermark} refuses to guess. Writes
 * the exact watermark, restoring the provider's ability to back-extend its window.
 *
 * Only ever call this with a floor the admin actually knows (when the provider first
 * synced, minus the window that run used). Declaring a floor NEWER than the truth makes
 * the next backfill re-cover already-imported activity and double-count it; declaring
 * one OLDER silently strands the span in between. Hence: no default and no inference —
 * an explicit human assertion.
 *
 * By default this refuses a provider whose floor is already recorded, because clobbering
 * a floor EARNED by a real sync is exactly the corruption the feature guards. But a
 * hand-typed floor is fallible, and refusing every overwrite would make the admin's own
 * typo permanent — the mistake would only surface as inflated counts after the backfill
 * ran. `force` is the escape hatch: it says "I know a floor is recorded and I am
 * replacing it", which is correctable-by-design for a declared floor and a loaded gun for
 * an earned one. That is why it is opt-in per call and never the default.
 *
 * `force` overrides ONLY that refusal. It never waives the existence requirement: a
 * provider with neither a cursor nor a floor has synced nothing, so there is no floor to
 * describe and the identifier is far more likely a typo than a real target. Writing one
 * anyway would invent an `exact` floor out of thin air — and a first sync will not
 * correct it (it only records a floor when none is stored), so the span between the
 * invented floor and the window that sync actually reached would be permanently
 * un-importable: the backfill only ever walks BELOW the floor. Hence `never_synced` is
 * unconditional.
 */
export function declareEarliestSyncedFloor(
    db: Database.Database,
    providerType: GitProviderType,
    identifier: string,
    floor: string,
    now: string,
    options?: {force?: boolean},
): {
    ok: true;
} | {
    ok: false;
    reason: 'not_legacy' | 'never_synced' | 'invalid_floor' | 'future_floor';
} {
    // Must be a real UTC ISO instant: this value is compared as an ISO string by the
    // overlap guard, so a loosely-parsed date would corrupt every later comparison.
    if (!isUtcIsoInstant(floor)) return {ok: false, reason: 'invalid_floor'};
    // Bound the upper edge: a floor at/after `now` claims the provider imported nothing
    // (or imported the future). Both make every later backfill target look "older than
    // the floor" and pass the overlap guard onto already-synced spans. Compared as
    // INSTANTS so the guard is total for anything isUtcIsoInstant admits; `now` is
    // rejected outright if unparseable rather than letting NaN compare false and pass.
    if (Number.isNaN(Date.parse(now))) return {ok: false, reason: 'future_floor'};
    if (Date.parse(floor) >= Date.parse(now)) return {ok: false, reason: 'future_floor'};
    // Check-then-act: read the state and write the floor in ONE transaction so a
    // concurrent declare/first-sync can't land between them and clobber a real floor.
    return db.transaction(
        (): {ok: true} | {ok: false; reason: 'not_legacy' | 'never_synced'} => {
            // Falsy, matching isEarliestFloorUnknown: a blank row is not a floor.
            const hasFloor = Boolean(getProviderEarliestSyncTime(db, providerType, identifier));
            const hasCursor =
                getSyncStateValue(db, syncStateKey(providerType, identifier)) !== null;
            // Nothing synced under this key — refuse even under force (see above).
            if (!hasFloor && !hasCursor) return {ok: false, reason: 'never_synced'};
            // A floor is recorded: only an explicit force may replace it.
            if (hasFloor && !options?.force) return {ok: false, reason: 'not_legacy'};
            setProviderEarliestSyncTime(db, providerType, identifier, floor);
            return {ok: true};
        },
    )();
}

/**
 * True iff `value` is a canonical UTC ISO instant (what every stored timestamp is).
 * Both checks earn their place, and each catches what the other cannot:
 *  - the REGEX pins the shape to exactly 4 digits + millis + 'Z', excluding ISO 8601
 *    expanded/negative years ('+010000-01-01T00:00:00.000Z'), which parse and round-trip
 *    cleanly yet break the ISO-string ordering every watermark comparison relies on;
 *  - the ROUND-TRIP rejects values that match the shape but are not the instant they
 *    spell — '2025-02-30T00:00:00.000Z' parses and normalizes to 2025-03-02;
 *  - the NaN check guards `toISOString()`, which throws RangeError on an Invalid Date.
 */
function isUtcIsoInstant(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Derive the immutable raw-author key a day's metrics are RETAINED under (#253).
 *
 * `aggregateDailyMetrics` groups by `AnalysisCommit.authorLogin`, which
 * `toAnalysisCommit` fills as `username || email` — so a "login" that is byte-equal to
 * the author's email means the commit carried NO provider username. Passing it through
 * as a login would key an email-only author as `${provider}:login:alice@example.com`,
 * an identity shape nothing else in the system produces. Detect that case and let
 * {@link rawAuthorKeyFor} take its email branch, so the stored key matches the identity
 * the resolver actually looks the author up by.
 *
 * Returns null only for a truly anonymous author (no login, no email) — or one whose
 * login AND email are both unusable — whose day is skipped: there is no stable key to
 * retain it under, and bucketing every such commit together would attribute unrelated
 * people to one identity.
 *
 * TOTAL OVER A NON-STRING on both parameters (#302 review cycle 3, SO-1/SEC-1), for the
 * reason spelled out on {@link rawAuthorKeyFor}: `analysisLogin` is a `metricsMap` KEY, i.e.
 * `AnalysisCommit.authorLogin` verbatim, which `analysis-types.ts` builds with `||` over a
 * cast response body — so `{}` / `[]` / `42` reach here. `.toLowerCase()` on one of those
 * throws from a frame with no enclosing `try`, killing the entire run rather than one row.
 * The equality probe is therefore only asked when both operands are genuinely strings; a
 * non-string login is otherwise passed straight through to `rawAuthorKeyFor`, which treats
 * it as absent and lets the write boundary refuse the row as `invalid_identity`.
 */
function retentionKeyFor(
    providerType: GitProviderType,
    analysisLogin: unknown,
    email: unknown,
): string | null {
    const isEmailFallback =
        typeof analysisLogin === 'string' &&
        typeof email === 'string' &&
        analysisLogin.toLowerCase() === email.toLowerCase();
    return rawAuthorKeyFor(providerType, isEmailFallback ? null : analysisLogin, email);
}

// Raw container identifier (org/workspace/group) for a provider — the canonical
// helper, shared with the resolver so the mapping lives in one place.
const providerIdentifier = providerContainer;

/**
 * The id of the `git_providers` row that owns `(providerType, container)` right now, or `null`
 * when no DB row does.
 *
 * Deliberately the owner's IDENTITY, not a boolean (#264 review SEC-2/SO-3/TST-5). A boolean
 * "is it owned?" cannot tell "the row this run was predicated on is still here" from "a
 * DIFFERENT, newly-created row now occupies that pair" — and the second is a real sequence,
 * because the immutable-container UX actively directs an admin to delete and re-add. Writing a
 * pre-delete window under a re-added provider partially undoes the delete AND resurrects the
 * forward cursor, which makes the re-added provider's first-sync window silently ignored: the
 * #262 state this issue exists to make unreachable.
 *
 * Config-file providers are deliberately NOT represented here. They have no `git_providers` row
 * by design, cannot be deleted through the API, and the config cannot change mid-process — so
 * their ownership can never change during a run, and the gate simply excludes them from the
 * snapshot rather than giving them a synthetic owner to compare against itself.
 */
function containerOwner(
    db: Database.Database,
    providerType: GitProviderType,
    container: string,
): string | null {
    return findProviderByTypeContainer(db, providerType, container)?.id ?? null;
}

function applyRepoFilter(
    repos: string[],
    include: string[] | undefined,
    exclude: string[] | undefined,
): string[] {
    let filtered = repos;
    if (include && include.length > 0) {
        filtered = filtered.filter((r) => include.includes(r));
    }
    if (exclude && exclude.length > 0) {
        filtered = filtered.filter((r) => !exclude.includes(r));
    }
    return filtered;
}

function parseRepoFilters(rawRepos: string[] | undefined): {include: string[]; exclude: string[]} {
    const include: string[] = [];
    const exclude: string[] = [];
    for (const entry of rawRepos ?? []) {
        if (entry.startsWith('exclude:')) {
            exclude.push(entry.slice('exclude:'.length));
        } else if (entry.startsWith('include:')) {
            include.push(entry.slice('include:'.length));
        } else {
            include.push(entry);
        }
    }
    return {include, exclude};
}

// Per-PR normalized facts for pr_records (Task 5.2). Built in fetchProviderData
// where the raw GitPR + its review comments/verdicts are in hand, then resolved
// to a developer and upserted in sync().
export interface PRRecordInput {
    provider: GitProviderType;
    /**
     * The provider INSTANCE this PR came from (org/workspace/group) — the other half of the
     * attribution key `pr_records` is now unique on (#264). Non-optional so a write path
     * cannot omit it: a PR id is unique only WITHIN a container, and a row with no container
     * is a row no per-provider delete can retract.
     */
    container: string;
    repo: string;
    prId: string;
    authorLogin: string | null;
    authorEmail: string | null;
    state: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    reviewCommentCount: number;
    changesRequestedCount: number;
    /** Normalized review verdict events (approved / changes_requested). */
    reviewEventCount: number;
    // Whether the comment / verdict fetches succeeded. On failure the counts
    // above are zero BY ABSENCE, not by observation — the upsert must not let
    // them clobber previously-observed values (a transient API failure would
    // otherwise rewrite real review history as "clean reviews").
    commentsOk: boolean;
    reviewsOk: boolean;
}

interface ProviderFetchResult {
    commits: AnalysisCommit[];
    prs: AnalysisPR[];
    reviewComments: AnalysisReviewComment[];
    prRecords: PRRecordInput[];
    errors: string[];
    stateKey: string;
    /** The provider's container id — the second half of its sync-state keys, so
     *  runSync can lower the earliest watermark (#229) without re-deriving it. */
    identifier: string;
    /**
     * The floor a FIRST forward sync actually reached (#229) — the clamped window
     * start (`since`), or {@link EARLIEST_SYNC_EPOCH} for a walk-all sync — so
     * runSync can record the true earliest-synced watermark and the "sync older
     * history" backfill's default is exact rather than guessed. `null` on every
     * non-first-sync path (a backfill, an incremental run, or a first sync that
     * failed before any repo was processed), where the watermark must not be
     * (re)written from the forward path.
     */
    firstSyncFloor: string | null;
    /**
     * The instant this provider's forward cursor advances to on a COMPLETE run —
     * the effective `until` the fetch actually covered.
     *
     * `now` on every normal run (first sync, or a cursor within
     * {@link GIT_CATCHUP_WINDOW_MAX_DAYS} of now), and an EARLIER, capped instant
     * when a held cursor left a wider span to re-cover (#235). Threaded out rather
     * than re-deriving `now` at the advance: a capped run covered `[since, until]`
     * only, so advancing to `now` would skip `[until, now]` entirely — the silent
     * permanent snapshot gap #231 exists to prevent, reintroduced by the very cap
     * meant to bound the stall.
     *
     * Ignored on the backfill path, which never advances the forward cursor.
     */
    forwardCursorTarget: string;
    /**
     * Fully-formatted {@link COMMITS_DROPPED_PREFIX} lines for this provider, threaded out
     * rather than pushed into {@link errors} — because whether they are TRUE depends on
     * something `fetchProviderData` cannot see (#275).
     *
     * The line says these commits will not be re-asked, which holds only if this run's window
     * is actually recorded as covered. Three separate paths discard a fetched window with no
     * cursor advance: an incomplete provider (#231), a write transaction that rolls back, and a
     * container whose owner was deleted mid-run (#262/#264 — `isWritable` turns its advance
     * into a no-op while the transaction still commits). Enumerating those three at the push
     * site is how the first version got two of them and missed the third; instead these are
     * emitted from the ONE place that knows, keyed on the cursor advance having actually run.
     */
    droppedAdvisories: string[];
    /**
     * Fully-formatted {@link DIFFS_NOT_SUPPLIED_PREFIX} lines reporting that N fallback diff
     * requests FAILED, so those commits were kept with no file-level detail and their
     * `files_changed` / `code_churn_rate` / `ai_signature_score` contribution is zero rather than
     * absent (#280). Threaded out rather than pushed into {@link errors} for the same reason
     * {@link droppedAdvisories} is: the line's claim is that the understatement is PERMANENT,
     * which holds only if this run's window is actually recorded as covered. The request-volume
     * half of the report — which is true whatever happens to the window — is pushed into
     * `errors` directly and is not repeated here.
     *
     * Empty whenever no fallback request failed; a run that took the fallback and had every
     * request succeed says so on the volume line and stages nothing.
     */
    diffLossAdvisories: string[];
    /**
     * Fully-formatted {@link COMMIT_CHURN_UNKNOWN_PREFIX} lines for this provider (#288),
     * threaded out rather than pushed into {@link errors} for the identical reason
     * {@link droppedAdvisories} and {@link diffLossAdvisories} are: each claims an
     * understatement that nothing will re-ask, which is only true once this run's window is
     * recorded as covered. The three share one emit site (the cursor-advance closure) rather
     * than each enumerating the discard paths at its own push site — enumerating them is how
     * the first version of this pattern got two of the three and missed the container-deleted
     * one.
     *
     * Kept a SEPARATE field from the two siblings rather than merged into either: the
     * advisory sentinel is what classifies an `errors` entry, and these lines carry a
     * different prefix and a different remedy from both.
     */
    churnUnknownAdvisories: string[];
    /**
     * True iff every fetch feeding the ADDITIVE commit-derived snapshot succeeded
     * for this provider — `listRepos` AND every repo's `getCommits`. When false the
     * run must NOT advance this provider's cursor/watermark AND must NOT write its
     * snapshots (#231): commit counts are ADDED across runs (see
     * {@link remergeStoredSnapshot}), so persisting the partially-fetched window now
     * and re-fetching it next run would double-count. The only gap-free option is to
     * discard this provider's partial data and re-cover the whole window next run —
     * loud (errors surface every run) rather than a silent, permanent snapshot gap.
     *
     * Best-effort fetches that are idempotent under re-delivery (PRs/review comments
     * are max()-merged; commit diffs fall back to empty) do NOT clear this flag:
     * holding the cursor for them would force an additive commit re-fetch, which is
     * strictly worse than the bounded, self-healing undercount they already accept.
     */
    complete: boolean;
}

async function fetchProviderData(
    providerConfig: GitProviderConfig,
    now: string,
    db: Database.Database,
    runBudget: GitRunBudget,
    report?: ProgressReporter,
    firstSyncWindowMonths?: number,
    backfill?: {since: string; until: string},
): Promise<ProviderFetchResult> {
    const errors: string[] = [];
    const allCommits: AnalysisCommit[] = [];
    const allPRs: AnalysisPR[] = [];
    const allReviewComments: AnalysisReviewComment[] = [];
    const allPRRecords: PRRecordInput[] = [];

    const identifier = providerIdentifier(providerConfig);
    // The persistent per-commit diffstat cache (#273), scoped to this provider instance. It is
    // what turns a failed run from "lost every fetch" into "lost only the uncached tail": the
    // provider writes each commit's diffstat through as it goes, OUTSIDE this run's write
    // transaction, so the rows survive the #231 drop-partials rule that discards everything
    // else. Supplied only here — probe paths (`doctor`, test-connection) never walk commits.
    //
    // Built BEFORE the config is validated, which is safe because the cache is total: an
    // invalid config (blank org/workspace/group, bogus type) yields a cache whose every write
    // the table's CHECK constraints refuse and whose guard swallows — and `createGitProvider`
    // rejects that config with the canonical message on the very next line, before a single
    // commit is fetched.
    const diffstatCache = createCommitDiffstatCache(db, providerConfig.type, identifier);
    // The run's deadline rides into the request layer on the client (#283), so every request
    // this provider makes — including the per-commit fan-out, which is where the unbounded
    // sleeping lived — measures itself against the same clock `fetchRepoWithRetry` below does.
    const provider = createGitProvider(providerConfig, {
        diffstatCache,
        policy: {retries: SYNC_RETRY_PROFILE, deadline: runBudget.deadline},
    });
    const providerType = provider.name;
    const stateKey = syncStateKey(providerType, identifier);
    // Window selection:
    //   - Backfill (#229): a fixed, strictly-older slice [since, until] the caller
    //     already validated as disjoint from stored activity. It ignores the forward
    //     cursor entirely (it walks BELOW the earliest watermark, not above `now`).
    //   - Otherwise: first sync (no stored cursor) optionally clamps the window to
    //     the last N months so run #1 doesn't walk the whole history; once a cursor
    //     exists it is the source of truth and firstSyncWindowMonths is IGNORED —
    //     re-widening `since` against additive snapshots would double-count (see
    //     SyncRunOptions).
    const storedCursor = getSyncStateValue(db, stateKey);
    const since = backfill ? backfill.since : (storedCursor ?? firstSyncSince(now, firstSyncWindowMonths));
    // This run is a FIRST forward sync when it is not a backfill and no cursor exists
    // yet. Only then does runSync record the earliest-synced watermark (#229): the
    // real floor `since` reached, mapped to the epoch sentinel for a walk-all ('').
    const isFirstSync = !backfill && storedCursor === null;
    const firstSyncFloor = isFirstSync ? (since === '' ? EARLIEST_SYNC_EPOCH : since) : null;
    // Commit fetch upper bound:
    //   - Backfill (#229): the caller's watermark.
    //   - Resuming a stored cursor: `now`, CAPPED to GIT_CATCHUP_WINDOW_MAX_DAYS past
    //     the cursor (#235) so a long-held cursor re-fetches a bounded span per run
    //     instead of an ever-widening one. Chunked, never skipped — the run advances
    //     the cursor to this `until` (see forwardCursorTarget), so the next run
    //     resumes exactly here and no span is lost.
    //   - First sync (no cursor): `now`. The cap deliberately does NOT apply — the
    //     window is already bounded by firstSyncWindowMonths, and capping it would
    //     silently turn a requested 6-month import into a 30-day one.
    // `until` bounds BOTH the commit walk (with its per-commit detail/diff fan-out)
    // and — since #247 — the per-PR review fan-out below, which is filtered to
    // `updatedAt <= until` (prWithinFetchWindow). See GIT_CATCHUP_WINDOW_MAX_DAYS for the
    // full scope of what is and is not bounded.
    const until = backfill
        ? backfill.until
        : storedCursor !== null
          ? catchUpUntil(storedCursor, now)
          : now;

    const rawRepos = 'repos' in providerConfig ? providerConfig.repos : undefined;
    const excludeRepos =
        providerConfig.type === 'github' || providerConfig.type === 'bitbucket'
            ? providerConfig.exclude_repos
            : undefined;
    const {include: includeRepos, exclude: excludeFromList} = parseRepoFilters(rawRepos);
    const allExclude = [...excludeFromList, ...(excludeRepos ?? [])];

    // `runBudget.retrySleepMs` is time the RUN has already spent asleep in in-run retry pauses,
    // against GIT_RUN_RETRY_SLEEP_BUDGET_MS. Owned by the caller and shared by every PROVIDER as
    // well as every repo and every fetch kind, so a wide outage cannot cost
    // `pauses × providers × repos × fetches` (#272, review cycle 3). It was per-provider first,
    // which made the documented 40-minute ceiling really `40 min × providers` — and
    // `runConnectorWithRetry` doubles whatever that is again. Run length is not a cosmetic
    // concern here: two overlapping git runs read the same forward cursor and fetch
    // non-disjoint windows into an additive commit merge, which is a permanent double-count
    // (see `sync-log.ts`); since #283 `scheduler.ts` also refuses to start a tick while the
    // previous one is still in flight.
    //
    // `runBudget.deadline` is the run's WALL CLOCK (#283) — the bound the sleep counter could
    // not express, because the sleep counter only sees repo-level pauses. It is consulted in
    // two places: here, before a repo-level pause, and inside the request layer, which the
    // provider client carries it into (see `createGitProvider` above).

    /**
     * Did the run's wall clock end any fetch this provider attempted (#283)?
     *
     * A RUN-level fact, not a loop-control one, and that distinction is the whole reason it
     * exists. The obvious implementation — break at the top of the repo loop — only notices a
     * deadline that leaves another iteration to run, so it misses every expiry on the LAST
     * repo. And "last repo" is not a corner: the per-PR review fan-out is the largest request
     * population in a run and it runs at the END of each repo, and a single-repo provider is
     * an ordinary admin-UI configuration.
     *
     * Missing it is not cosmetic. `getPullRequests` and the review fan-out are BEST-EFFORT —
     * they record an error without clearing {@link commitsComplete} — so a deadline landing
     * there used to leave `complete: true`, advance the forward cursor past a window whose PR
     * data was never fetched, and lose it permanently: `getPullRequests` is bounded below by
     * the cursor, so a PR never touched again is never re-listed, and its `prs_opened` /
     * `prs_merged` / `review_comments_given` days are gone. Holding the cursor instead costs
     * a re-fetch of an already-discarded window, which is exactly #231's trade.
     */
    let deadlineStopped = false;

    /**
     * Run one repo fetch, retrying it in-run on a fault that could plausibly heal (#272).
     * Returns the value on success, or the LAST fault's message on failure — the one that
     * actually ended the fetch, which is what an operator needs.
     *
     * Used for EVERY per-repo fetch: `getCommits`, `getPullRequests`, and the per-PR review
     * fan-out. Hardening only the commit fetch would have made things WORSE for the others, not
     * better: the fetches used to fail together (a blip long enough to blow one 6-second budget
     * blew the rest too), so an incomplete commit fetch held the cursor and every other failed
     * window was re-covered next run as a side effect. Retry commits alone and that coupling
     * breaks — commits heal, `complete` stays true, the cursor advances past a window whose
     * fetch failed, and since `getPullRequests` is bounded below by the advanced cursor (and the
     * fan-out additionally by `prWithinFetchWindow`) a PR never touched again is never re-listed
     * and never re-fanned-out. Those fields are max()-merged, or carried forward, on the premise
     * that each run delivers the full per-day set, so the loss does not self-heal. Retrying them
     * all keeps them coupled.
     *
     * `budgetMs` bounds only these repo-level PAUSES; the request layer's own 5xx/rate-limit
     * sleeping inside each attempt is bounded by `runBudget.deadline` instead, which the
     * provider client carries into every request (#283). Both are checked here, and for the
     * same reason in the same order: BEFORE the pause, against the full delay, so each bounds
     * time actually spent rather than time attempted. A pause the deadline cannot absorb is
     * refused rather than truncated — sleeping 4 of the 5 minutes and retrying anyway would
     * spend the pause and still not have waited out the outage.
     *
     * The other half of #272's residual — "a retry re-issues the repo's whole O(commits) detail
     * fan-out rather than resuming it" — was closed by #273 rather than here: the per-commit
     * diffstat memo is written per commit outside the run's write transaction, so a retried
     * `getCommits` re-pages the commit LIST but serves the fan-out from the memo. The retry is
     * O(pages + commits whose detail never succeeded), not O(commits).
     *
     * `budgetMs` is the share of {@link GIT_RUN_RETRY_SLEEP_BUDGET_MS} this fetch kind may draw
     * to. It is what stops a BEST-EFFORT fetch from starving the cursor-critical one: a failed
     * PR list or fan-out is recorded and the run continues, while a failed commit fetch discards
     * every provider's data for the run. With one shared pool the cheap failure could spend the
     * expensive failure's insurance — repo 1's PR retries burn the budget, then repo 2's commit
     * fetch gets no pause at all and the run is lost. Best-effort callers pass the smaller
     * {@link GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS}, which reserves the remainder for commits.
     *
     * `onRetry` fires before each pause so the caller can reset its progress counter: the
     * count the failed attempt left behind is stale the moment it threw, and leaving it frozen
     * through a 15-minute wait is exactly the "reads as hung" symptom #270 exists to remove.
     *
     * Sets `deadlineStopped` when the run's clock is SPENT — see the declaration for why that
     * has to be a RUN-level fact rather than a loop-control one, and `GitRunDeadlineError.kind`
     * for the neighbouring case (a pause the budget cannot afford) that must not set it.
     */
    const fetchRepoWithRetry = async <T>(
        run: () => Promise<T>,
        onRetry: () => void,
        budgetMs: number = GIT_RUN_RETRY_SLEEP_BUDGET_MS,
        what: string = 'fetch',
    ): Promise<{value: T; error: null} | {value: null; error: string}> => {
        let healed: string | null = null;
        // THIS call's own sleep, not the run's. Reporting `runRetrySleep.spentMs` here overstated
        // every heal after the first — the second repo to heal claimed the whole run's wait as its
        // own, and an operator reading "after waiting 40 min" would go looking for a 40-minute
        // outage that never happened (#272, review cycle 3).
        let sleptMs = 0;
        for (let attempt = 0; ; attempt++) {
            try {
                const value = await run();
                // A heal is reported as an ADVISORY, not a failure: the run recovered, so it must
                // not go red, but it must not be silent either — see RETRY_HEALED_PREFIX.
                if (healed !== null) {
                    errors.push(
                        `${RETRY_HEALED_PREFIX} ${what} succeeded on attempt ${attempt + 1} ` +
                            `after waiting ${Math.round(sleptMs / 60_000)} min — ${healed}`,
                    );
                }
                return {value, error: null};
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                // The run's clock is SPENT — `assertRunTimeRemaining` refused to start a
                // request. Recorded on the RUN rather than left to the loop, because the caller
                // that needs it is the post-loop check, not this one: a deadline that lands on
                // the LAST repo's fetch has no next iteration to notice it (#283 review, SO-1).
                //
                // Gated on `kind`, and that gate is the whole finding of review cycle 3. The
                // OTHER producer of this error — `sleepWithinRun`, when a pause is longer than
                // the budget's remainder — is not the run ending: a rate-limit reset can be a
                // full hour, so it fires with most of the budget left, on a fetch that failed
                // for an ordinary retryable reason. Treating that as a stop escalated one
                // best-effort review-comment fetch into a whole-provider discard, which is the
                // #231 trade this file refuses to make for those fetches. It is the same
                // conflation the repo-level pause refusal below rejects — this is the request
                // layer's copy of it.
                if (err instanceof GitRunDeadlineError && err.kind === 'clock-passed') {
                    deadlineStopped = true;
                }
                if (attempt >= GIT_REPO_RETRY_DELAYS_MS.length || !isRetryableGitFetchError(err)) {
                    return {value: null, error: message};
                }
                const delay = GIT_REPO_RETRY_DELAYS_MS[attempt];
                // Check both budgets BEFORE sleeping, and count the pause we are about to take —
                // so each bounds time actually spent, not time attempted.
                if (runBudget.retrySleepMs + delay > budgetMs) {
                    return {value: null, error: message};
                }
                // The run's wall clock, which the sleep counter cannot express: `budgetMs` says
                // how much of the RETRY allowance is left, not how much of the RUN is (#283).
                // `<=` rather than `<`: finishing the pause with exactly zero left leaves no
                // time to make the request the pause exists to enable.
                //
                // Says WHY there was no retry. The bare fault message reads as "one 503 and it
                // gave up", which sends the operator to the provider instead of to the run's
                // length — the opposite of the diagnosis.
                //
                // Deliberately does NOT set `deadlineStopped`, for the same reason the
                // `pause-refused` case above does not. A refused PAUSE is not a spent DEADLINE:
                // the fault that ended this fetch was a retryable provider fault (the guard
                // above proved it), the clock has NOT passed, and the run is entitled to
                // finish. Conflating the two escalated every BEST-EFFORT failure in the last
                // five minutes — a PR list or one review-comment 503 — into `commitsComplete =
                // false`, discarding a whole provider's successfully-fetched run and holding
                // its cursor, which is precisely the #231 trade this file spends paragraphs
                // refusing to make for those fetches. If the clock really is spent, the next
                // request trips `assertRunTimeRemaining` and the flag is set above, where the
                // claim is true.
                if (runBudget.deadline.remainingMs() <= delay) {
                    return {
                        value: null,
                        error:
                            `${message} (no further retry: the run's wall-clock budget could ` +
                            'not absorb the pause)',
                    };
                }
                runBudget.retrySleepMs += delay;
                sleptMs += delay;
                healed = message;
                onRetry();
                await sleep(delay);
            }
        }
    };

    /**
     * The result for a provider that reached NO repo — nothing fetched, nothing imported, the
     * window not covered. Written once and shared by the two paths that produce it (the run
     * deadline below and a failed `listRepos`), because every field on it is a claim about
     * "we got nowhere" and the two copies could only ever drift apart.
     */
    const noWindowCovered = (): ProviderFetchResult => ({
        commits: allCommits,
        prs: allPRs,
        reviewComments: allReviewComments,
        prRecords: allPRRecords,
        errors,
        stateKey,
        identifier,
        // Nothing was imported, so don't claim a synced-back-to floor even on a first sync.
        firstSyncFloor: null,
        // Unused on this path (`complete: false` means no cursor advances), but the window
        // this run would have covered is still the honest value to report.
        forwardCursorTarget: until,
        // No repo was reached, so nothing could have been dropped.
        droppedAdvisories: [],
        // No commit was fetched, so no fallback diff request could have failed.
        diffLossAdvisories: [],
        // No commit was fetched, so no commit's churn could have gone unobserved.
        churnUnknownAdvisories: [],
        // The window was not covered at all — hold the cursor so it retries (#231).
        complete: false,
    });

    // The run's wall clock is spent before this provider has issued a single request (#283).
    // Providers are fetched sequentially out of one shared deadline, so this is the shape
    // EVERY provider after the one that ran long sees — and it must not be reported as
    // "Failed to list repos", which describes the provider rather than the run and would send
    // an operator to check a healthy provider's credentials.
    if (runBudget.deadline.remainingMs() <= 0) {
        errors.push(providerNotReachedLine(providerType));
        return noWindowCovered();
    }

    report?.((p) => {
        p.stage = 'listing_repos';
        p.current_repo = null;
    });
    // Retried in-run out of the FULL budget (#272 review cycle 2, SO-4): this is the single
    // highest-leverage request in the run, because its failure returns `complete: false`
    // immediately and discards the provider's whole window before any repo is even attempted.
    // It is also the first request a first sync makes, so on the incident's shape a 503 here
    // defers hours of import by a full cron day.
    const repoList = await fetchRepoWithRetry(
        () => provider.listRepos(),
        () =>
            report?.((p) => {
                p.stage = 'listing_repos';
                p.current_repo = null;
            }),
        GIT_RUN_RETRY_SLEEP_BUDGET_MS,
        `[${providerType}] listing repos`,
    );
    let repoNames: string[] = [];
    if (repoList.error === null) {
        repoNames = repoList.value.filter((r) => !r.isArchived).map((r) => r.name);
    } else {
        // A wall-clock stop during the LISTING gets the deadline line too, not just the bare
        // fetch failure (#283 review, SO-3/SEC-2). This return is BEFORE the post-loop block
        // that normally turns `deadlineStopped` into an outcome, so without this the flag was
        // set and then discarded — leaving an unlabelled wall-clock shape that reads as a
        // provider-health failure, which is exactly what `providerNotReachedLine` exists to
        // prevent.
        //
        // `providerNotReachedLine`, not `runDeadlineLine(type, 0, 0)`: no repo was reached
        // here either, so it is the same "0 of 0 reads as 'this provider has no
        // repositories'" trap (#283 review cycle 3, SO-3). The two paths differ only in
        // whether a request was issued, which the accompanying `Failed to list repos` line
        // already says.
        if (deadlineStopped) errors.push(providerNotReachedLine(providerType));
        errors.push(`[${providerType}] Failed to list repos: ${repoList.error}`);
        return noWindowCovered();
    }

    const reposToSync = applyRepoFilter(
        repoNames,
        includeRepos.length > 0 ? includeRepos : undefined,
        allExclude.length > 0 ? allExclude : undefined,
    );

    // Accumulate (+=) rather than assign, matching the other counters' cumulative
    // semantics. Today the only listener-bearing caller is the single-provider
    // sync-now trigger (so this reads as that provider's repo count); a future
    // multi-provider listener would also see the stage revisit 'listing_repos'
    // per provider — design that presentation when such a caller exists.
    report?.((p) => {
        p.stage = 'fetching';
        p.repos_total = (p.repos_total ?? 0) + reposToSync.length;
    });

    // Cleared the moment any repo's commit fetch throws: a single failed repo leaves
    // the provider's [since, until] window incompletely covered, so runSync must hold
    // the whole provider's cursor and drop its partial snapshots (#231).
    let commitsComplete = true;

    // Commits each repo's provider LISTED but could not return (#275), staged rather than
    // reported inline. The advisory calls the loss PERMANENT, and that is only true if this
    // run's data is kept: if a LATER repo's commit fetch fails, `commitsComplete` goes false
    // and #231 discards this whole provider's window, so the "dropped" commits are re-asked
    // next run like everything else. Reporting them inline would therefore describe a state
    // that does not exist — the same reason `allUnmatched` and the auto-create advisories are
    // staged and cleared on rollback rather than pushed as they are discovered.
    const droppedByRepo: Array<{repo: string; drops: GitCommitDrop[]}> = [];

    // Shas each repo's provider RETURNED with `churnObserved === false` (#288), staged on
    // exactly the same terms and for exactly the same reason as `droppedByRepo` above: the
    // advisory calls the understatement permanent, and a later repo's failure discards this
    // whole provider's window and re-asks everything next run.
    //
    // Per repo, not per provider — unlike the fallback-diff counters below. This is a property
    // of the DATA (which commits the provider described without line counts), not of the
    // provider implementation, so naming the repo is what tells an operator where to look.
    //
    // No per-ATTEMPT reset, unlike `droppedCommits` below, and the difference is real rather
    // than an oversight: this is derived from the returned array, which `fetchRepoWithRetry`
    // ASSIGNS rather than appends to, so a retry that re-pages the same window replaces the
    // previous attempt's commits and can never double-count.
    const churnUnknownByRepo: Array<{repo: string; shas: string[]}> = [];

    // How many commits this provider returned WITHOUT `GitCommit.diffs`, forcing the diff pass
    // below into its `getCommitDiff` fallback (#280), and which repos they came from. Counted
    // for the whole provider rather than staged per repo, unlike `droppedByRepo` above: this is
    // a property of the PROVIDER IMPLEMENTATION, not of any repo's data, so a diff-less provider
    // hits every repo and a per-repo line would print the same sentence N times. The repo SET is
    // kept anyway because it is the one number that separates "one repo behaves oddly" from
    // "this provider never supplies diffs".
    //
    // These two feed the REQUEST-VOLUME line, which is reported unconditionally rather than
    // staged-and-discarded like the drop advisories: those describe DATA whose loss a rollback
    // un-does, whereas these requests were really made, and a run that both took the slow path
    // and was then discarded is if anything more worth saying, not less.
    let fallbackDiffCommits = 0;
    const fallbackDiffRepos = new Set<string>();
    // The subset of the above whose fallback request FAILED, so the commit was kept with empty
    // diffs. Tracked separately because it is the only one of the three counts that carries a
    // claim about PERSISTED state: whether those zeros are permanent depends on this run's
    // window being recorded as covered, which is why the sentence it feeds is staged into
    // `diffLossAdvisories` and discarded on all three discard paths — unlike the two counters
    // above, which are honest whatever happens next. See {@link DIFFS_NOT_SUPPLIED_PREFIX}.
    let fallbackDiffFailures = 0;

    // The ONE place the within-repo indicator is written (#270) — every producer
    // below routes through it, so the four fields have a single source of truth.
    // (A listener that throws cannot break the run; that is enforced once, where the
    // listener is actually invoked — see the `report` closure in syncProviders.)
    //
    // `scanned` defaults to null and is WRITTEN on every report rather than left alone
    // (#276): every one of these fields describes the step named in the same call, so a
    // producer that does not distinguish scanned from kept must clear a previous
    // producer's value, not inherit it. Only the provider listener below ever passes one.
    const reportStep = (
        step: GitSyncRepoStep,
        done: number,
        total: number | null,
        scanned: number | null = null,
    ): void => {
        report?.((p) => {
            p.repo_step = step;
            p.repo_step_done = done;
            p.repo_step_scanned = scanned;
            p.repo_step_total = total;
        });
    };

    // Undefined when nobody is observing, so the observer-free scheduled path hands
    // the providers no listener at all and their `onProgress?.(…)` short-circuits —
    // not one progress object allocated across a full sync (#270). Hoisted out of the
    // repo loop: neither closure captures the repo.
    //
    // `scanned` is optional on the provider seam and nullable on the wire — absent and
    // null mean the same thing there ("no distinction to draw"), so this is a null-coalesce
    // rather than a translation of vocabularies.
    const stepListener = (step: GitSyncRepoStep): GitFetchProgressListener | undefined =>
        report
            ? ({done, total, scanned}): void => reportStep(step, done, total, scanned ?? null)
            : undefined;
    const onCommitProgress = stepListener('commits');
    const onPRProgress = stepListener('prs');

    // Repos this provider actually attempted, so the deadline line below can say how far the
    // run got — the one number that tells an operator whether the provider is slow or the
    // window is simply too wide for one run.
    let reposAttempted = 0;

    for (const repoName of reposToSync) {
        // Stop at the run's wall clock rather than letting every remaining repo issue a
        // request that `assertRunTimeRemaining` rejects and push its own "Failed to fetch
        // commits" (#283). The reporting is done ONCE after the loop, by the block that also
        // catches a deadline landing on the last repo — see `deadlineStopped`.
        if (runBudget.deadline.remainingMs() <= 0) {
            deadlineStopped = true;
            break;
        }
        reposAttempted++;
        report?.((p) => {
            p.current_repo = repoName;
        });
        // Enter the commits step BEFORE the list request, symmetric with the PR step
        // below: the first page request can sleep until the rate-limit reset, and
        // during that window the label would otherwise carry no within-repo segment at
        // all. Total is null — the commit count is not known yet. This also supersedes
        // the previous explicit clear here, since it overwrites all four fields.
        reportStep('commits', 0, null);
        // getCommits pages the commit list AND does the per-commit detail/diff fetch
        // internally; its onProgress reports both so the indicator advances during that work
        // instead of jumping only once the repo returns (#270). Since #271 that internal fetch
        // is the ONLY per-commit diff request a run makes — the loop below reuses its result
        // off `GitCommit.diffs`.
        //
        // Retried in-run on a healable fault (#272). The result is ASSIGNED, never appended
        // to, so a retry that re-pages the same window replaces the previous attempt's partial
        // list rather than doubling it — and nothing has been pushed into `allCommits` yet.
        //
        // Commits this repo's provider LISTED but could not return (#275). Reset at the top of
        // EVERY attempt, not once per repo: `fetchRepoWithRetry` re-runs the whole call, which
        // re-pages the same window and re-reports the same drops, so a per-repo list would
        // multiply the count by the number of attempts. Same reasoning as the ASSIGNED (never
        // appended) commit result above — a retry replaces the previous attempt, it does not
        // add to it.
        const droppedCommits: GitCommitDrop[] = [];
        const commitFetch = await fetchRepoWithRetry(
            () => {
                droppedCommits.length = 0;
                return provider.getCommits(
                    repoName,
                    since,
                    until,
                    onCommitProgress,
                    // Unconditional, unlike `onCommitProgress` — the drop report is not
                    // observability, it is the only record that data was lost, so it must exist
                    // on the observer-free scheduled path too (that path is where nearly every
                    // real sync runs).
                    (drop) => droppedCommits.push(drop),
                );
            },
            () => reportStep('commits', 0, null),
            GIT_RUN_RETRY_SLEEP_BUDGET_MS,
            `[${providerType}/${repoName}] commit fetch`,
        );
        if (commitFetch.error !== null) {
            errors.push(`[${providerType}/${repoName}] Failed to fetch commits: ${commitFetch.error}`);
            // This repo's commit window is now un-covered — hold the provider's cursor
            // back so the whole window is re-fetched next run rather than skipped (#231).
            commitsComplete = false;
            // A failed repo still counts as processed so the N/M counter reaches M.
            report?.((p) => {
                p.repos_processed += 1;
                p.current_repo = null;
                Object.assign(p, NO_REPO_STEP);
            });
            continue;
        }
        const rawCommits = commitFetch.value;
        // STAGED, not reported yet — see the emit site after the repo loop. Only the SUCCESS
        // path stages: the `continue` above means a failed commit fetch contributes nothing,
        // because its window is about to be re-covered.
        if (droppedCommits.length > 0) {
            droppedByRepo.push({repo: repoName, drops: [...droppedCommits]});
        }
        // Staged on the success path only, exactly like the drops above (#288). `=== false`,
        // not `!churnObserved`: the field is OPTIONAL and absent means observed, so a
        // truthiness test would report every commit from every provider that never sets it.
        const churnUnobserved = rawCommits.filter((c) => c.churnObserved === false);
        if (churnUnobserved.length > 0) {
            churnUnknownByRepo.push({repo: repoName, shas: churnUnobserved.map((c) => c.sha)});
        }
        report?.((p) => {
            p.commits_fetched += rawCommits.length;
        });

        // The per-commit diff pass — normally NOT a second network fan-out (#271): the
        // provider already fetched each commit's diff to compute its additions/deletions
        // and hands it back on `GitCommit.diffs`. See `GitSyncProgress.repo_step` for what
        // that does to this step's observability.
        reportStep('diffs', 0, rawCommits.length);
        for (const [i, rawCommit] of rawCommits.entries()) {
            // An ARRAY — including an empty one — is an answer and is reused; anything
            // else falls back (see `GitCommit.diffs` for why `[]` must NOT fall back).
            // A shape test rather than `!== undefined` so a non-array from a provider
            // adapter is fetched properly instead of silently reading as "no detail". It
            // checks the CONTAINER only: element shapes are trusted here exactly as
            // `getCommitDiff`'s return is trusted on the fallback path, so this is not a
            // validation boundary and does not pretend to be one.
            let diffs: GitFileDiff[];
            if (Array.isArray(rawCommit.diffs)) {
                diffs = rawCommit.diffs;
            } else {
                // Counted BEFORE the request, and counted whether or not it succeeds: what the
                // advisory reports is that this run took the second-fetch path at all, which is
                // true regardless of the outcome. Counting only successes would make a provider
                // that is both diff-less AND failing look conformant (#280).
                fallbackDiffCommits += 1;
                fallbackDiffRepos.add(repoName);
                diffs = [];
                try {
                    diffs = await provider.getCommitDiff(repoName, rawCommit.sha);
                } catch (err) {
                    // A spent wall clock is NOT one of the faults this swallows (#283 review,
                    // SEC-3). Everything else here is "one commit's diff is unavailable", which
                    // #271 deliberately tolerates; a spent deadline is a statement about the
                    // RUN. Unreachable today — every in-tree provider supplies `diffs`, so this
                    // branch needs a future diff-less one — which is exactly why it is worth
                    // closing before that provider exists.
                    //
                    // RECORDED, not re-thrown (#283 review cycle 3, TST-1). This call is not
                    // inside `fetchRepoWithRetry`, so a throw escaped `fetchProviderData`
                    // entirely — past the post-loop block — and landed in the outer per-provider
                    // catch, which reports `Skipped — this provider could not be used`. That is
                    // the CONFIG-error seam: it told the operator to go check a healthy
                    // provider's credentials, carried no RUN_DEADLINE_PREFIX, and skipped the
                    // #235 stall counter. Setting the flag routes this through the same exit as
                    // every other expiry; the remaining commits then cost one rejected
                    // `assertRunTimeRemaining` each, with no network at all.
                    if (err instanceof GitRunDeadlineError && err.kind === 'clock-passed') {
                        deadlineStopped = true;
                    }
                    // Diff fetch failed — use empty diffs; commit still counts. Swallowing the
                    // fault is #271's preserved semantics (one bad diff must not fail the repo),
                    // but the commit's file-level metrics are now computed from nothing and the
                    // cursor will advance past it, so the count is REPORTED rather than left as
                    // the silent zero it used to be (#280).
                    fallbackDiffFailures += 1;
                }
                // NOT ratcheted (#273). The diffstat cache lives inside each provider, at the
                // single per-commit fetch site #271 consolidated; this is the fallback for a
                // provider that supplied no `diffs` at all, which no in-tree provider does.
                // Caching here would need the sync loop to know the provider's container and
                // to duplicate the "which faults are cacheable" rule that `providers/diffstat.ts`
                // owns — a second source of truth for one unreachable branch. If a real
                // diff-less provider ever lands, give IT the cache rather than instrumenting
                // this site.
            }
            // Namespace file paths by repo to prevent false churn collisions
            const namespacedDiffs = diffs.map((d) => ({...d, path: `${repoName}/${d.path}`}));
            allCommits.push(toAnalysisCommit(rawCommit, namespacedDiffs));
            // No iteration is skipped, so the loop index IS the processed count.
            reportStep('diffs', i + 1, rawCommits.length);
        }

        // Enter the PR step BEFORE the list request, not after it. Without this the
        // completed `diff N/N` from the loop above would stay on the label for the
        // whole PR-list fetch — which under a rate-limit backoff is minutes of a
        // finished counter, i.e. exactly the "reads as hung" symptom #270 exists to
        // remove (#270 review SO-3). Total is null: the list size is not known yet.
        reportStep('prs', 0, null);
        // Retried in-run on the same terms and out of the same run budget as the commit fetch
        // above (#272) — see fetchRepoWithRetry for why retrying only commits would have made
        // the PR path WORSE than before. Still best-effort on exhaustion: a failed PR list does
        // NOT clear `commitsComplete`, because holding the cursor for it would force an
        // additive commit re-fetch, which #231 weighed and rejected (see the note on
        // `ProviderFetchResult.complete`). The retry narrows the window in which that
        // best-effort answer is reached; it does not change what happens when it is.
        const prFetch = await fetchRepoWithRetry(
            () => provider.getPullRequests(repoName, 'all', since, onPRProgress),
            () => reportStep('prs', 0, null),
            GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS,
            `[${providerType}/${repoName}] PR list fetch`,
        );
        // Discriminant first, same as the commit site — one way of asking "did it fail".
        if (prFetch.error !== null) {
            errors.push(`[${providerType}/${repoName}] Failed to fetch PRs: ${prFetch.error}`);
        }
        const rawPRs: GitPR[] = prFetch.value ?? [];
        report?.((p) => {
            p.prs_fetched += rawPRs.length;
        });
        // The list is in hand (or the fetch failed and it is empty), so the total is
        // now real — switch from "N seen" to done/total for the per-PR fan-out below.
        // A failed fetch lands here too, which retracts any partial listing count
        // rather than leaving it frozen; an empty total renders as no counter at all.
        reportStep('prs', 0, rawPRs.length);

        let commentFetchFailures = 0;
        let reviewFetchFailures = 0;
        for (const [prIndex, pr] of rawPRs.entries()) {
            // EVERY listed PR feeds allPRs / prRecords unconditionally — the list row is
            // already in hand and cheap, and the per-day open/merge aggregate is combined
            // across runs with max() (remergeStoredSnapshot), which is only idempotent if
            // each run delivers the FULL per-day set. Dropping list rows here would
            // partition a single day's PRs across catch-up chunks and make max(partial,
            // partial) silently undercount prs_opened/prs_merged (#247 review SO-1; the
            // additive/idempotent-merge rule from #205/#192).
            allPRs.push(toAnalysisPR(pr));

            // Bound ONLY the expensive per-PR review fan-out (getReviewComments +
            // getPRReviews, 2 API calls each) to the run's [since, until] window (#247).
            // getPullRequests takes no upper bound, so a held cursor would otherwise
            // re-fan an ever-widening span; gating the fan-out on `updatedAt <= until`
            // fans each PR out in exactly one chunk (its updatedAt lands in exactly one
            // contiguous [since, until]) — collapsing the recovery amplification to ~1x.
            // Lossless: a deferred PR re-lists next chunk (since' === until) and is fanned
            // out then. On a normal uncapped run (until === now) nothing is deferred.
            const fanOut = prWithinFetchWindow(pr.updatedAt, until);

            // A deferred fan-out is "not observed this run" — exactly like a failed fetch,
            // so commentsOk/reviewsOk are false and upsertPRRecord carries forward the
            // previously-observed review counts instead of clobbering them with zeros. It
            // is NOT a fetch FAILURE, so it is not counted toward the error advisories.
            // Retried in-run out of the best-effort reserve (#272 review cycle 2, SO-2). This is
            // the LARGEST request population in a run — 2 calls per PR — and it was the last
            // fetch still on a bare catch. Leaving it there while the commit fetch gained 20
            // minutes of healing is what would have made the diff a net regression here: the
            // commit fetch heals, `complete` stays true, the cursor advances, and because the
            // fan-out is gated by `prWithinFetchWindow` a PR touched only during the outage is
            // never fanned out again. `upsertPRRecord` then carries forward a count that was
            // never observed — i.e. zero — permanently.
            let prCommentCount = 0;
            let commentsOk = fanOut;
            if (fanOut) {
                const fetched = await fetchRepoWithRetry(
                    () => provider.getReviewComments(repoName, pr.id),
                    () => reportStep('prs', prIndex, rawPRs.length),
                    GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS,
                    `[${providerType}/${repoName}] review comments for PR ${pr.id}`,
                );
                if (fetched.error !== null) {
                    // Review comment fetch failed — counted and surfaced below
                    commentsOk = false;
                    commentFetchFailures++;
                } else {
                    prCommentCount = fetched.value.length;
                    for (const c of fetched.value) {
                        allReviewComments.push(toAnalysisReviewComment(c));
                    }
                }
            }

            // Review verdict events (Task 5.2). Best-effort like comments: a
            // failed (or deferred) fetch still records the PR, flagged so the upsert
            // preserves previously-observed verdict data.
            let changesRequestedCount = 0;
            let reviewEventCount = 0;
            let reviewsOk = fanOut;
            if (fanOut) {
                const fetched = await fetchRepoWithRetry(
                    () => provider.getPRReviews(repoName, pr.id),
                    () => reportStep('prs', prIndex, rawPRs.length),
                    GIT_RUN_BEST_EFFORT_RETRY_SLEEP_BUDGET_MS,
                    `[${providerType}/${repoName}] review verdicts for PR ${pr.id}`,
                );
                if (fetched.error !== null) {
                    reviewsOk = false;
                    reviewFetchFailures++;
                } else {
                    reviewEventCount = fetched.value.length;
                    changesRequestedCount = fetched.value.filter(
                        (r) => r.state === 'changes_requested',
                    ).length;
                }
            }

            allPRRecords.push({
                provider: providerType,
                container: identifier,
                repo: repoName,
                prId: pr.id,
                authorLogin: pr.author.username || null,
                authorEmail: pr.author.email || null,
                state: pr.state,
                createdAt: pr.createdAt,
                mergedAt: pr.mergedAt,
                closedAt: pr.closedAt,
                reviewCommentCount: prCommentCount,
                changesRequestedCount,
                reviewEventCount,
                commentsOk,
                reviewsOk,
            });

            // The comment/verdict fetches above are 2 API calls per PR — the O(PRs)
            // cost of this repo. Counts PRs PROCESSED (no iteration is skipped, so the
            // loop index is that count), which means it also advances over a PR whose
            // fan-out was deferred by prWithinFetchWindow — no network work, so such a
            // run completes near-instantly.
            reportStep('prs', prIndex + 1, rawPRs.length);
        }

        // Surface fetch failures (aggregated per repo so a rate-limited run
        // doesn't produce one error per PR). A silent failure here would be
        // indistinguishable from a clean review history downstream.
        if (commentFetchFailures > 0) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch review comments for ${commentFetchFailures} PR(s)`,
            );
        }
        if (reviewFetchFailures > 0) {
            errors.push(
                `[${providerType}/${repoName}] Failed to fetch review verdicts for ${reviewFetchFailures} PR(s)`,
            );
        }

        report?.((p) => {
            p.repos_processed += 1;
            p.current_repo = null;
            // This repo is done — clear its indicator so a later stage (or the final
            // snapshot) never displays a finished repo's stale "PR 40/40" (#270).
            Object.assign(p, NO_REPO_STEP);
        });
    }

    // The ONE place a wall-clock stop is turned into an outcome (#283). After the loop, not
    // inside it, because that is the only position from which every expiry is visible: the
    // loop-top break sees a deadline with another repo left to run, and this sees the ones
    // that landed on the LAST repo — including inside the best-effort PR/review fan-out, which
    // does not clear `commitsComplete` on its own and would otherwise have advanced the cursor
    // past a PR window it never fetched (#283 review, SO-1/SEC-5).
    //
    // Keyed on `deadlineStopped` — "a deadline actually ended a fetch" — rather than on
    // `remainingMs() <= 0`. A run whose last repo finishes everything just as the clock runs
    // out covered its window, and holding that cursor would re-fetch a window this run is
    // about to record, for nothing.
    if (deadlineStopped) {
        commitsComplete = false;
        errors.push(runDeadlineLine(providerType, reposAttempted, reposToSync.length));
    }

    // FORMATTED here, EMITTED by the caller — see `ProviderFetchResult.droppedAdvisories` for
    // why the truth of these lines is not decidable at this point. Unconditional here: the
    // caller's gate is the cursor advance itself.
    //
    // One line per affected repo, with a count, like the review-comment/verdict failures above
    // and for the same reason: a systemic shape problem hits thousands of commits, and an
    // `errors` list that long is unreadable wherever it lands. A bounded SAMPLE of shas is
    // included so the operator can go look one up — not the full set, so the line stays
    // readable; the count is the complete figure.
    const droppedAdvisories = droppedByRepo.map(({repo: droppedRepo, drops}) => {
        // Shas grouped UNDER their reason by the SHARED renderer (#302) rather than the copy
        // that used to live here — the two reasons exist only because the operator's next step
        // differs, and that argument, the per-group sample cap and the join now have one home.
        const groups = formatLossGroups(
            drops.map((drop) => ({
                reason: sanitizeDropReason(drop.reason),
                label: sanitizeSha(drop.sha),
            })),
            'because',
        );
        return (
            `${COMMITS_DROPPED_PREFIX} [${providerType}/${droppedRepo}] ${drops.length} ` +
            `commit(s) the provider listed could not be imported by this run, whose window is ` +
            `now recorded as covered. There is no targeted re-fetch: ` +
            `"sync older history" only extends STRICTLY older than the earliest synced ` +
            `instant, so it cannot reach a forward window. ${groups}.`
        );
    });

    // FORMATTED here, EMITTED by the caller, on the same gate and for the same reason as the
    // drop advisories directly above (#288). One line per affected repo with a count and a
    // bounded sha sample — the same shape, because an operator reading both in one `errors`
    // list should not have to learn two layouts.
    //
    // NO per-reason grouping, unlike the drop advisory above. That map exists there because two
    // drop reasons with DIFFERENT operator next-steps can appear in one repo; there is exactly
    // one way to fail to observe churn, so a map here would always yield one group and the
    // generality would be for a case that cannot occur.
    //
    // WHICH METRICS IT NAMES IS A CLAIM ABOUT THE CODE, not reassurance — the operator sizes a
    // DESTRUCTIVE repair against this sentence, so an over-broad "unaffected" is worse than
    // saying nothing (#288 review cycles 1 and 2). Verified against the analyzer rather than
    // copied from the sibling #280 line, whose scoping is correct there and wrong here because
    // there the line counts are known and only the file list is missing:
    //   - `commits` counts rows, and PR metrics come from a different fetch: genuinely
    //     unaffected.
    //   - `avg_commit_size` divides total lines by commit count: the commit is in the
    //     denominator with a zero numerator, so it is dragged down whatever else the body had.
    //   - `ai_signature_score` is UNCONDITIONAL too, which is the correction: three of its five
    //     signals gate on `additions`/`deletions` (`ai-signature.ts` signals 1, 3 and 4), so a
    //     zero-churn commit cannot score them even when `files` arrived intact, and the day's
    //     score is a MEAN over commits.
    //   - `files_changed` and `code_churn_rate` read only `fileDiffs`, so those two — and only
    //     those two — are conditional on the response having also omitted the file list.
    const churnUnknownAdvisories = churnUnknownByRepo.map(({repo: affectedRepo, shas}) => {
        return (
            `${COMMIT_CHURN_UNKNOWN_PREFIX} [${providerType}/${affectedRepo}] ${shas.length} ` +
            'commit(s) were imported with their line counts recorded as zero because the ' +
            'provider never observed them, and this run has recorded its window as covered — ' +
            'so lines_added, lines_removed, avg_commit_size and ai_signature_score on those ' +
            'developer-days are PERMANENTLY wrong by whatever those commits changed (at most, ' +
            'though — a commit whose author resolves to no registered developer produced no row ' +
            'to understate). Where the same response also carried no file list — the usual ' +
            'shape — files_changed and code_churn_rate are understated too. Commit counts and ' +
            'PR metrics are unaffected. Nothing was memoized for these commits, so a re-import ' +
            're-asks the endpoint rather than replaying this run\'s zero — but that is not a ' +
            'promise of a different answer: if the provider omits the counts as a property of ' +
            'the commit, every re-fetch returns the same body, which is exactly why this run ' +
            'did not fail and retry. Run the repair below only where you have reason to think ' +
            `the omission was transient. ${permanentSpanRepair()}. ` +
            `Affected: ${formatBoundedSample(shas.map(sanitizeSha))}.`
        );
    });

    // The cache never throws, so this line is the ONLY trace a broken one leaves. An advisory,
    // not a failure — see DIFFSTAT_CACHE_DEGRADED_PREFIX. Reported once per provider with a
    // count rather than per commit: a dead cache fails on every one of thousands of commits,
    // and an error list that long is unreadable in the sync log and in the admin UI alike.
    if (diffstatCache.faults() > 0) {
        errors.push(
            `${DIFFSTAT_CACHE_DEGRADED_PREFIX} [${providerType}] ${diffstatCache.faults()} commit ` +
                'diffstat cache operation(s) hit a database error and were skipped. No data was ' +
                'lost — every commit was fetched from the provider and every metric is complete ' +
                '— but the ratchet did not fully apply, so this run may have re-fetched commits ' +
                'it already had and a later failure may re-fetch these again. A count comparable ' +
                'to the commit total means the cache is unusable (check disk space and database ' +
                'permissions); one or two means transient lock contention.',
        );
    }

    // The ONLY trace the fallback path leaves (#280). One line per provider with a count, for
    // the same reason as the diffstat-cache line above: the condition is systemic, so a per-repo
    // or per-commit line would be thousands of copies of one sentence.
    //
    // REQUEST VOLUME only. Everything below is true the moment the requests are made, so it is
    // pushed here regardless of what the caller later does with this run's window. The claim that
    // a failed fallback's understatement is PERMANENT is not — it is staged into
    // `diffLossAdvisories` and emitted only from the cursor advance. See
    // DIFFS_NOT_SUPPLIED_PREFIX for why splitting at that seam is the whole point.
    const diffLossAdvisories: string[] = [];
    if (fallbackDiffCommits > 0) {
        errors.push(
            `${DIFFS_NOT_SUPPLIED_PREFIX} [${providerType}] ${fallbackDiffCommits} commit(s) ` +
                `across ${fallbackDiffRepos.size} repo(s) arrived without GitCommit.diffs, so ` +
                'this run made a SECOND per-commit diff request for each of them — the request ' +
                'volume and wall time of the slowest phase of a sync, paid twice, and rate ' +
                'limit burned for it. Every in-tree provider supplies the field, so a non-zero ' +
                'count means a provider implementation is not honouring the GitCommit.diffs ' +
                'contract on GitProvider.getCommits (#271/#280). ' +
                (fallbackDiffFailures === 0
                    ? 'No data is missing and no metric is wrong — every fallback request ' +
                      'succeeded and fetched the same diff the provider should have supplied.'
                    : `${fallbackDiffFailures} of those requests FAILED, so those commits ` +
                      'carry no file-level detail: IF this run\'s window is recorded as ' +
                      'covered, their contribution to files_changed, code_churn_rate and ' +
                      'ai_signature_score lands as zero rather than absent, and a companion ' +
                      'line below says so. If it is not — a held, rolled-back or ' +
                      'deleted-container run — this window is re-fetched intact next run and ' +
                      'nothing is lost.'),
        );

        // The permanence claim and its remedy, staged. True only if this run's window is
        // recorded as covered — on the three discard paths the commits are re-asked next run
        // and these zeros never land, so making the claim there would send an operator to
        // rebuild an intact span. The remedy names the delete cascade rather than a bare cursor
        // purge, which would re-import over surviving raw rows and double every commit metric
        // in the span (#262).
        if (fallbackDiffFailures > 0) {
            diffLossAdvisories.push(
                `${DIFFS_NOT_SUPPLIED_PREFIX} [${providerType}] the ${fallbackDiffFailures} ` +
                    'commit(s) whose fallback diff request failed are now recorded as covered, ' +
                    'so nothing re-asks them and the understatement of files_changed, ' +
                    'code_churn_rate and ai_signature_score on their developer-days is ' +
                    'PERMANENT (at most — a commit whose author resolves to no registered ' +
                    `developer produced no row to understate). ${permanentSpanRepair()} and ` +
                    'fix the provider\'s getCommits to supply GitCommit.diffs.',
            );
        }
    }

    return {
        commits: allCommits,
        prs: allPRs,
        reviewComments: allReviewComments,
        prRecords: allPRRecords,
        errors,
        stateKey,
        identifier,
        firstSyncFloor,
        forwardCursorTarget: until,
        droppedAdvisories,
        diffLossAdvisories,
        churnUnknownAdvisories,
        complete: commitsComplete,
    };
}

/**
 * Review cycles for a PR: 0 when it never saw any review activity; otherwise
 * one initial review round plus one more per "changes requested" send-back.
 */
function computeReviewRounds(
    reviewEventCount: number,
    reviewCommentCount: number,
    changesRequestedCount: number,
): number {
    if (reviewEventCount === 0 && reviewCommentCount === 0) return 0;
    return 1 + changesRequestedCount;
}

/**
 * Delegates to {@link prMergeDurationHours} rather than restating the rule (#302). The two used
 * to be independent copies, and they disagreed: for one `created_at: '+033658-…'` PR this wrote
 * `pr_records.time_to_merge_hours = NULL` while `analyzer.ts` wrote
 * `raw_author_daily.avg_time_to_merge_hours = -277304070` from the very same timestamps.
 */
function timeToMergeHours(record: PRRecordInput): number | null {
    if (!record.mergedAt) return null;
    return prMergeDurationHours(record.createdAt, record.mergedAt);
}

/**
 * Project constraint: all timestamps in UTC ISO. Bitbucket/GitLab can emit
 * offset timestamps (+02:00-style); normalize so the day-attribution in the
 * coaching engine (substr of the date part) is a UTC day, not a local one.
 * Unparseable input passes through untouched rather than becoming garbage.
 */
function toUtcIso(timestamp: string): string;
function toUtcIso(timestamp: string | null): string | null;
function toUtcIso(timestamp: string | null): string | null {
    if (timestamp === null) return null;
    const ms = Date.parse(timestamp);
    return Number.isNaN(ms) ? timestamp : new Date(ms).toISOString();
}

interface PRRecordExistingRow {
    review_comment_count: number;
    review_rounds: number;
    changes_requested_count: number;
}

export function upsertPRRecord(
    db: Database.Database,
    record: PRRecordInput,
    developerId: string,
    syncedAt: string,
): void {
    // A failed comment/verdict fetch yields zeros by absence, not observation.
    // Carry forward the previously-observed values for the failed dimension so
    // one bad sync can't rewrite real review history as "clean reviews".
    let commentCount = record.reviewCommentCount;
    let crCount = record.changesRequestedCount;
    let rounds = computeReviewRounds(record.reviewEventCount, commentCount, crCount);
    if (!record.commentsOk || !record.reviewsOk) {
        const existing = db
            .prepare(
                `SELECT review_comment_count, review_rounds, changes_requested_count
                 FROM pr_records WHERE provider = ? AND container = ? AND repo = ? AND pr_id = ?`,
            )
            .get(record.provider, record.container, record.repo, record.prId) as
            | PRRecordExistingRow
            | undefined;
        if (existing) {
            if (!record.commentsOk) commentCount = existing.review_comment_count;
            if (!record.reviewsOk) {
                // Verdict events weren't observed this sync — restore the last
                // verdict-derived round count and changes-requested count as a
                // unit. Recomputing rounds from a fresh comment count alone
                // (which can't raise rounds past 1) would blend stale and fresh
                // state into a row that never matched any single observation.
                crCount = existing.changes_requested_count;
                rounds = existing.review_rounds;
            } else {
                // Verdicts observed; only comments are stale — recompute from
                // the authoritative fresh verdict data.
                rounds = computeReviewRounds(record.reviewEventCount, commentCount, crCount);
            }
        }
    }

    db.prepare(
        `INSERT INTO pr_records
         (id, developer_id, provider, container, repo, pr_id, state, created_at, merged_at, closed_at,
          review_comment_count, review_rounds, changes_requested_count, time_to_merge_hours, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, container, repo, pr_id) DO UPDATE SET
           developer_id = excluded.developer_id,
           state = excluded.state,
           created_at = excluded.created_at,
           -- Freeze the merge timestamp once observed: a PR merges exactly once,
           -- and Bitbucket approximates it with updated_on, which post-merge
           -- activity inflates on every re-sync. COALESCE keeps the first
           -- non-null value so merged_at and time_to_merge_hours stay consistent.
           merged_at = COALESCE(pr_records.merged_at, excluded.merged_at),
           closed_at = excluded.closed_at,
           review_comment_count = excluded.review_comment_count,
           review_rounds = excluded.review_rounds,
           changes_requested_count = excluded.changes_requested_count,
           -- Keep the FIRST observed time-to-merge: it never legitimately
           -- changes after merge, and Bitbucket's merge timestamp is
           -- approximated by updated_on, which post-merge activity inflates.
           time_to_merge_hours = COALESCE(pr_records.time_to_merge_hours, excluded.time_to_merge_hours),
           synced_at = excluded.synced_at`,
    ).run(
        randomUUID(),
        developerId,
        record.provider,
        record.container,
        record.repo,
        record.prId,
        record.state,
        toUtcIso(record.createdAt),
        toUtcIso(record.mergedAt),
        toUtcIso(record.closedAt),
        commentCount,
        rounds,
        crCount,
        timeToMergeHours(record),
        syncedAt,
    );
}

/**
 * The newest forward CURSOR across an already-resolved provider set — the instant git
 * data has been synced UP TO. Factored out of {@link GitSync.getLastSyncTime} so a
 * caller that has already resolved its providers once (e.g. `toprope status`, #246) can
 * reuse the identical scan without resolving them a second time, keeping the read and
 * the writer of `git_last_sync:<type>:<container>` cursors from drifting apart.
 * Returns null when no resolved provider has a cursor yet.
 */
export function latestProviderCursor(
    db: Database.Database,
    providerConfigs: GitProviderConfig[],
): string | null {
    let latest: string | null = null;
    let latestMs = -Infinity;
    for (const pc of providerConfigs) {
        const key = syncStateKey(pc.type, providerIdentifier(pc));
        const row = db
            .prepare('SELECT value FROM sync_state WHERE key = ?')
            .get(key) as SyncStateRow | undefined;
        const t = row?.value ?? null;
        if (!t) continue;
        // Compare by parsed instant, not lexically, and drop an unparseable value —
        // matching loadGitSyncHealth's totality. A garbage row must not sort high,
        // win the max, and render as "connected (just now)" via formatTimeAgo(NaN).
        const ms = Date.parse(t);
        if (Number.isNaN(ms)) continue;
        if (ms > latestMs) {
            latestMs = ms;
            latest = t;
        }
    }
    return latest;
}

export class GitSync implements ConnectorInterface {
    private readonly config: GitConnectorConfig;

    constructor(config: GitConnectorConfig) {
        this.config = config;
    }

    getName(): string {
        return CONNECTOR_NAME;
    }

    /**
     * The newest forward CURSOR across this connector's providers — the instant git
     * data has been synced UP TO, not the instant a run last happened.
     *
     * Those were the same thing until #235: a complete run always advanced the cursor
     * to `now`. With the catch-up cap they diverge — a provider recovering from a long
     * stall syncs successfully every night while this still reports an instant weeks
     * back, because that is genuinely how far the data reaches. That is the honest
     * answer for a freshness/staleness question and the wrong one for "did the sync
     * run?"; a caller wanting the latter must not use this. This method has no direct
     * caller in `src/` (it satisfies ConnectorInterface); the shared scan it delegates
     * to, {@link latestProviderCursor}, is what `toprope status` calls to render the
     * Git connector's "last sync" line (#246).
     */
    getLastSyncTime(db: Database.Database): string | null {
        return latestProviderCursor(db, this.getProviderConfigs(db));
    }

    async sync(db: Database.Database, providerFilter?: string): Promise<SyncResult> {
        const providerConfigs = this.getProviderConfigs(db).filter(
            (pc) => !providerFilter || pc.type === providerFilter,
        );

        if (providerConfigs.length === 0) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: providerFilter
                    ? [`No provider of type '${providerFilter}' configured`]
                    : ['No git providers configured'],
                lastSyncTime: new Date().toISOString(),
            };
        }

        return this.runSync(db, providerConfigs);
    }

    /**
     * Run the sync pipeline over an EXPLICIT provider set — the seam the
     * per-provider "sync now" API (GC1.7 / #199) triggers with a single provider.
     * It reuses the exact fetch → merge → upsert path {@link sync} runs (no cloned
     * sync logic): the ONLY difference is the caller supplies the provider configs
     * instead of them being resolved from DB + config here. An empty list yields
     * the same "nothing configured" shape rather than throwing.
     *
     * `onProgress` (optional, GC#209) receives a {@link GitSyncProgress} snapshot
     * as the run advances — the sync-now API stores the latest one so the admin
     * UI can poll live progress. Omitted on the scheduled path (no observer).
     */
    async syncProviders(
        db: Database.Database,
        providerConfigs: GitProviderConfig[],
        onProgress?: GitSyncProgressListener,
        options?: SyncRunOptions,
    ): Promise<SyncResult> {
        if (providerConfigs.length === 0) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: ['No git providers configured'],
                lastSyncTime: new Date().toISOString(),
            };
        }
        return this.runSync(db, providerConfigs, onProgress, options);
    }

    // The shared pipeline body for both entry points above. Assumes a non-empty,
    // already-resolved provider set (callers own resolution + the empty case) so
    // the fetch/merge/upsert logic lives in exactly one place.
    private async runSync(
        db: Database.Database,
        providerConfigs: GitProviderConfig[],
        onProgress?: GitSyncProgressListener,
        options?: SyncRunOptions,
    ): Promise<SyncResult> {
        const errors: string[] = [];
        let snapshotsWritten = 0;
        let snapshotsSkipped = 0;
        // Kept SEPARATE from `snapshotsSkipped` since #306, which folded unwritable rows into
        // that field. This one still counts only what the LEGACY_CELLS_SKIPPED_PREFIX advisory
        // is about — projection cells left untouched because they hold pre-upgrade totals — so
        // that line keeps naming its own number instead of a sum of three unrelated grains.
        let legacyCellsSkipped = 0;
        const now = new Date().toISOString();
        const allUnmatched = new Set<string>();

        // Narrow + validate the auto-create config BEFORE any network work (#256). This is
        // the second of the feature's two trust boundaries — `loadConfig` is the first, but
        // a `GitConnectorConfig` also reaches here assembled programmatically (tests, the
        // admin sync-now path, an embedder), and the boundary that must never be bypassed
        // is the one next to the write. An invalid config aborts the run rather than
        // syncing with the feature silently off: the operator asked for hands-off
        // onboarding, and "ran fine, created nobody" is the failure mode this rejects.
        let autoCreate: AutoCreateSettings;
        try {
            autoCreate = resolveAutoCreateSettings(this.config);
        } catch (err) {
            return {
                connector: CONNECTOR_NAME,
                snapshotsWritten: 0,
                snapshotsSkipped: 0,
                errors: [`Invalid auto-create config: ${err instanceof Error ? err.message : String(err)}`],
                lastSyncTime: now,
            };
        }

        // One mutable progress state for the whole run; every report merges into
        // it and emits a copy, so the listener always sees cumulative counters.
        const progressState: GitSyncProgress = {
            stage: 'listing_repos',
            repos_total: null,
            repos_processed: 0,
            current_repo: null,
            commits_fetched: 0,
            prs_fetched: 0,
            developers_matched: 0,
            ...NO_REPO_STEP,
        };
        const report: ProgressReporter | undefined = onProgress
            ? (mutate): void => {
                  mutate(progressState);
                  // Guard the LISTENER call — and only it. `mutate` is our own code, so
                  // a throw there is a real bug and stays loud.
                  //
                  // A listener fault must never become a data-completeness decision.
                  // Since #270 these reports fire from inside provider.getCommits /
                  // getPullRequests, whose per-repo catch would read an escaping throw
                  // as a failed fetch — holding the provider's forward cursor and
                  // dropping its snapshots (#231) — and from fetchProviderData's other
                  // report sites, where the provider-level handler would discard the
                  // whole provider's results. This is the single place the listener is
                  // invoked, so guarding here covers every report site (including the
                  // #209 ones) rather than the subset a per-call guard would reach.
                  // A throwing listener loses its update and nothing else.
                  try {
                      onProgress({...progressState});
                  } catch {
                      // Listener fault — the run is unaffected by design (see above).
                  }
              }
            : undefined;
        // Distinct developers resolved anywhere in the run (snapshots or PR
        // records) — the developers_matched counter's source.
        const matchedDevelopers = new Set<string>();

        const devLookup = buildDevLookupMap(db);
        const churnWindowHours = this.config.analysis?.churn_window_hours ?? 48;

        // ─── Mid-run-delete ownership gate (#264 review SO-1/SEC-1, SEC-2) ────────────────
        //
        // WHO owned each of this run's containers before the fetch started. The write boundary
        // re-checks and refuses to write for a container whose owner CHANGED meanwhile.
        //
        // Why a start snapshot rather than "require an owner at write time": that targets the
        // actual hazard, a DELETE landing mid-run. A container that was never owned is a caller
        // passing an ad-hoc config (an embedder, a test) — the run was never predicated on a row,
        // so nothing can have been retracted underneath it, and it is left exactly as before.
        //
        // Why the owner's IDENTITY rather than a boolean: see {@link containerOwner}. Delete +
        // re-add of the same container during one run leaves a DIFFERENT row occupying the pair,
        // and writing the pre-delete window under it both undoes half the delete and resurrects
        // the forward cursor.
        const configOwnedKeys = new Set(resolveGitProviderConfigs(this.config).map(containerKey));
        const ownerAtStart = new Map<string, string>();
        for (const pc of providerConfigs) {
            const key = containerKey(pc);
            // A config-file provider's ownership cannot change mid-run (no row to delete, and the
            // config is immutable at runtime), so it is excluded rather than tracked — an absent
            // entry already means "writable" below.
            if (configOwnedKeys.has(key)) continue;
            const owner = containerOwner(db, pc.type, providerIdentifier(pc));
            if (owner !== null) ownerAtStart.set(key, owner);
        }
        // Containers the WRITE PATH found orphaned — i.e. `isWritable` refused them, so a
        // provider's fetched window was discarded. This is the REPORTING set only (it is
        // deliberately cleared on rollback, where nothing was discarded because nothing was
        // written); the diffstat purge below uses `containerLostOwner` directly so it is not
        // hostage to which write closures happened to run.
        const orphanedContainers = new Set<string>();
        // Memoized per container: one owner lookup each, however many rows reference it.
        const ownerNow = new Map<string, string | null>();
        /**
         * Did `(providerType, container)`'s owning `git_providers` row change since this run
         * started fetching?
         *
         * `false` for a container that had no owner at start — a config-file provider (excluded
         * from `ownerAtStart` by design; its ownership cannot change mid-process) or an ad-hoc
         * config from an embedder or a test. Neither was predicated on a row, so nothing can
         * have been retracted underneath it.
         *
         * Split out of {@link isWritable} so the post-transaction cache tidy-up can ask the same
         * question — off the same memo, with the same normalization — WITHOUT recording a
         * reporting-set entry. The two readers must not be one function: the report describes
         * discarded writes, the purge describes rows to retract, and a rolled-back run has the
         * second without the first.
         */
        const containerLostOwner = (providerType: GitProviderType, container: string): boolean => {
            const key = containerKeyOf(providerType, container);
            const startOwner = ownerAtStart.get(key);
            if (startOwner === undefined) return false;
            let current = ownerNow.get(key);
            if (current === undefined) {
                current = containerOwner(db, providerType, container);
                ownerNow.set(key, current);
            }
            return current !== startOwner;
        };
        /**
         * May this run write for `(providerType, container)`?
         *
         * Called from INSIDE the write transaction, which is what makes it sound: on this
         * process's single connection this read and the writes are one unit, and across
         * connections SQLite orders the two transactions — so either the owner is unchanged (a
         * concurrent cascade has not committed, and will remove whatever we write when it does)
         * or it is not (it committed, and we discard).
         *
         * Hoisted above the fetch loop so the deferred cursor/stall closures can self-guard
         * rather than being restructured into tagged objects; it closes over nothing that
         * requires the transaction, only over where it is *invoked*.
         */
        const isWritable = (providerType: GitProviderType, container: string): boolean => {
            if (!containerLostOwner(providerType, container)) return true;
            orphanedContainers.add(containerKeyOf(providerType, container));
            return false;
        };

        // Fetch data from all providers separately (for per-provider sync state),
        // then merge before analysis so multi-provider contributions to the same
        // (developer_id, date) are accumulated rather than overwritten.
        const fetchResults: Array<{result: ProviderFetchResult; providerType: GitProviderType}> = [];

        // ONE retry-sleep counter and ONE wall-clock deadline for the whole run, shared across
        // providers — see the declaration comment in `fetchProviderData` for why neither is
        // per-provider (#272, #283). The deadline starts here, at the first fetch, rather than
        // at `runSync`'s entry: the migrations and config resolution before this point are
        // bounded local work, and starting the clock over them would silently shrink the
        // network budget the constant names.
        const runBudget: GitRunBudget = {
            retrySleepMs: 0,
            deadline: createRunDeadline(GIT_RUN_WALL_CLOCK_BUDGET_MS),
        };

        for (const pc of providerConfigs) {
            let result: ProviderFetchResult;
            try {
                result = await fetchProviderData(
                    pc,
                    now,
                    db,
                    runBudget,
                    report,
                    options?.firstSyncWindowMonths,
                    options?.backfill,
                );
            } catch (err) {
                // One unusable provider must not sink the run (the resolver's own contract).
                // `fetchProviderData` reaches `createGitProvider` — and with it the CANONICAL
                // `validateGitProviderConfig` seam — before it issues a single request, so this
                // catches a missing org/workspace/group, a missing token and a malformed GitLab
                // url alike, rather than re-implementing one of those checks here. (The two
                // statements that precede it, `providerContainer` and the diffstat cache
                // constructor, are both TOTAL by design, so nothing else can land here.) A
                // genuine error, not an advisory: the operator configured a provider that
                // cannot be synced at all.
                errors.push(
                    `[${pc.type}] Skipped — this provider could not be used: ` +
                        `${err instanceof Error ? err.message : String(err)}`,
                );
                continue;
            }
            errors.push(...result.errors);
            fetchResults.push({result, providerType: pc.type});
        }

        report?.((p) => {
            p.stage = 'analyzing';
            p.current_repo = null;
            // Leaving the fetching stage — clear the within-repo indicator here too, so
            // the "no stage past fetching carries a stale step" invariant is owned by
            // the producer. The repo loop clears on both of its exits, but a throw from
            // fetchProviderData outside those two guarded awaits skips them, and the
            // outer handler just continues to the next provider (#270 review SEC-3).
            Object.assign(p, NO_REPO_STEP);
        });

        // Every author's daily facts this run observed, matched AND unmatched, ready to
        // be RETAINED under their immutable raw identity (#253). This — not
        // git_snapshots — is now the run's primary write: git_snapshots is derived from
        // it by projection below, so an author with no developer record is no longer
        // dropped but simply not yet projected.
        // Keyed by the FULL store key — `(container, raw_author_key, date)` — so two provider
        // INSTANCES of the same family contributing to one author-day stay SEPARATE rows rather
        // than being folded together (see the accumulation below). Insertion-ordered, so the
        // write pass stays deterministic.
        const rawWrites = new Map<string, RawAuthorDailyInput>();
        // The raw author keys THIS run retained — the scope auto-create (#256) acts on.
        // Deliberately not "every current candidate": a hands-off run onboards the
        // authorship it just observed, and must not silently sweep up candidates an
        // operator left unpromoted in the review queue on purpose.
        const retainedKeys = new Set<string>();
        // The (developer_id, date) cells this run's raw writes resolve to — exactly the
        // cells the projection must rebuild. Deduped by composite key so a developer
        // reached under two identities (a github login and a bitbucket login) yields one
        // cell, not two rebuilds of the same one.
        const touchedCells = new Map<string, SnapshotCell>();
        // Per-PR records (Task 5.2), written after the snapshot pass. Keyed naturally by
        // (provider, repo, pr_id), so no cross-provider merging is needed.
        //
        // Collected UNRESOLVED and resolved inside the write transaction against the same
        // post-auto-create lookup the snapshot projection uses. Resolving here would use
        // the pre-fetch map, so a developer created during the run — by auto-create (#256),
        // or by an admin during the minutes of network fetch — would have their PRs
        // silently dropped. That loss is PERMANENT: providers re-fetch PRs by `updated_at`,
        // so a PR that is already merged and never touched again is never re-delivered.
        const fetchedPRRecords: Array<{record: PRRecordInput; providerType: GitProviderType}> = [];
        // Deferred sync-state advances (#231). Each entry is applied INSIDE the write
        // transaction below, so a provider's cursor/watermark commits atomically with
        // — and only if — its data is persisted. Populated only for providers whose
        // fetch was complete; an incomplete provider contributes nothing this run.
        // Each closure self-guards with `isWritable` (hoisted above the fetch loop), so a
        // container that lost its owner mid-run advances nothing.
        const cursorAdvances: Array<() => void> = [];
        // Auto-create's summary/failure lines (#256). Staged rather than pushed straight
        // into `errors` because they are produced INSIDE the write transaction: on a
        // rollback no developer was created, so reporting that any were would be a lie.
        // Appended only after the transaction commits, and discarded on failure.
        const autoCreateAdvisories: string[] = [];
        // Drop advisories (#275), staged for exactly the reason `autoCreateAdvisories` is:
        // they are produced inside the write transaction and are only true if it commits.
        // Filled by the `cursorAdvances` closure — see there for why that is the one honest
        // gate — and discarded on rollback below.
        const droppedAdvisories: string[] = [];
        // Permanent-diff-loss advisories (#280), staged for exactly the reason the two above
        // are: the line claims the loss can no longer be re-asked, which is only true once this
        // run's window is recorded as covered. Same closure, same discard semantics.
        const diffLossAdvisories: string[] = [];
        // Unobserved-churn advisories (#288), staged for exactly the reason the two above are:
        // the line claims the understatement can no longer be re-asked, which is only true once
        // this run's window is recorded as covered. Same closure, same discard semantics.
        const churnUnknownAdvisories: string[] = [];
        // Unwritable-row advisories (#302), staged for exactly the reason the three above are:
        // the line claims the skipped row can no longer be re-asked, which is only true once this
        // run's window is recorded as covered. Same closure, same discard semantics.
        const skippedRowAdvisories: string[] = [];
        // Systemic-refusal ERRORS (#306) — the escalation of the line above, staged on the same
        // closure and consumed on the same terms. Not advisories: they carry
        // SYSTEMIC_ROW_REFUSAL_PREFIX, which `isAdvisoryError` deliberately does not match, so a
        // run that lands one settles as `status: 'error'` rather than as a green run over a
        // window it wrote nothing into.
        const systemicRefusalErrors: string[] = [];
        // Rows this run REFUSED, across every provider instance whose window was recorded as
        // covered — accumulated by the same closure, for the same reason, and only read after
        // the transaction commits. This is what moves `sync_logs.records_skipped` off 0 (#306):
        // before it, `snapshotsSkipped` carried only legacy projection cells, so the one numeric
        // field meaning "rows we did not write" never moved for an unwritable row.
        let committedRowsSkipped = 0;
        // Per-container skip/retain accounting (#307). Both writes now decide their skip AT the
        // write, inside `insertMany` — which iterates every provider's rows together — so the
        // counts can no longer be per-fetch-iteration locals; they are keyed by the provider
        // instance's `containerKeyOf(type, container)` and read back by each cursor-advance closure
        // (which runs after both write passes complete). A row/PR is counted here only when the
        // store's own typed refusal is caught; `retainedRowCountByContainer` is the accepted-row
        // denominator `isSystemicRowRefusal` weighs the refusals against.
        const skippedRowsByContainer = new Map<string, SkippedAuthorDay[]>();
        const skippedPRRecordsByContainer = new Map<string, SkippedPRRecord[]>();
        const retainedRowCountByContainer = new Map<string, number>();
        const pushByContainer = <T>(map: Map<string, T[]>, key: string, value: T): void => {
            const list = map.get(key);
            if (list) list.push(value);
            else map.set(key, [value]);
        };
        // Deferred stall-counter updates (#235), applied in the SAME transaction as
        // the cursor advances so the counter and the cursor can never disagree about
        // whether this run moved the provider forward. Unlike `cursorAdvances` this
        // covers EVERY provider in the run — a complete one clears its streak, an
        // incomplete one extends it.
        const stallUpdates: Array<() => void> = [];

        for (const {result, providerType} of fetchResults) {
            const {commits, prs, reviewComments, prRecords, stateKey, identifier} = result;

            // Stall accounting (#235) — FORWARD runs only. A backfill deliberately
            // leaves the forward cursor untouched (it walks older history), so its
            // outcome says nothing about whether the cursor is stuck; counting a failed
            // backfill would raise a stall alert for a provider syncing perfectly, and
            // a successful one would clear a real stall that is still stuck.
            if (!options?.backfill) {
                stallUpdates.push((): void => {
                    // Skipped for a container whose owner changed mid-run: the stall key is one
                    // of the three the cascade purged, so writing it would leave `sync_state`
                    // carrying a row for a provider that no longer exists.
                    if (!isWritable(providerType, identifier)) return;
                    if (result.complete) clearProviderStall(db, providerType, identifier);
                    else recordProviderStallRun(db, providerType, identifier, now);
                });
            }

            // A provider whose commit fetch was incomplete (listRepos or any repo's
            // getCommits threw) must not advance its cursor OR write its additive
            // snapshots (#231). Commit counts are ADDED across runs, so writing this
            // run's partial data and re-fetching the same window next run would
            // double-count; discarding the partial data and re-covering the whole
            // window next run is the only gap-free option. Skip the provider entirely
            // — its errors are already surfaced, so the failure is loud, not silent.
            // (Trade-off: a permanently-failing repo stalls the provider until it is
            // fixed or excluded via config — a visible stall, preferred over a silent,
            // permanent snapshot gap.)
            if (!result.complete) {
                continue;
            }

            // Defer this provider's sync-state advance into the write transaction.
            // Backfill (#229) LOWERS the earliest watermark to the (older) slice it
            // just imported and leaves the forward cursor untouched, so normal "Sync
            // now" keeps resuming from now; every other run advances the forward cursor
            // to `now`. Written per-provider even on an empty fetch (a complete run
            // that found nothing legitimately covered its window), so a backfill can
            // only ever widen backward and never re-covers a slice.
            // This provider instance's unwritable rows and accepted-row count are decided at the
            // WRITE now (#302/#307), inside `insertMany`, not here — so they live in the run-wide
            // per-container maps declared above, keyed by this instance's container key.
            const instanceKey = containerKeyOf(providerType, identifier);

            cursorAdvances.push((): void => {
                // Advancing a cursor the cascade just purged is exactly what re-arms the #262
                // double-count, so a container whose owner changed mid-run advances nothing.
                if (!isWritable(providerType, identifier)) return;
                // THIS instance's write-time accounting, finished by the time this closure runs
                // (inside the write transaction, after both write passes). `retainedRowCount` is
                // the accepted-row denominator `isSystemicRowRefusal` weighs the refusals against.
                const skippedRows = skippedRowsByContainer.get(instanceKey) ?? [];
                const skippedPRRecords = skippedPRRecordsByContainer.get(instanceKey) ?? [];
                const retainedRowCount = retainedRowCountByContainer.get(instanceKey) ?? 0;
                // This provider's window IS being recorded as covered, which is the exact
                // premise of its drop advisories (#275). Staged, not pushed: this closure runs
                // INSIDE the write transaction, so on a rollback nothing was recorded and the
                // lines must not be reported — same reasoning, and the same staging, as
                // `autoCreateAdvisories`. Reaching this line is the one condition that is true
                // on every keep path and false on all three discard paths.
                droppedAdvisories.push(...result.droppedAdvisories);
                // Same premise, same gate (#280): the failed-fallback commits are only
                // unreachable-forever once this advance makes their window covered.
                diffLossAdvisories.push(...result.diffLossAdvisories);
                // Same premise, same gate (#288): a commit whose churn was never observed is
                // only permanently understated once this advance makes its window covered.
                churnUnknownAdvisories.push(...result.churnUnknownAdvisories);
                // Same premise, same gate (#302): a row this run refused to write is only beyond
                // recovery once this advance records its window as covered. Rendered HERE rather
                // than staged as a finished string like the three above — those are built in
                // `fetchProviderData` because that is where their data lives, not to keep work
                // out of the write lock, and the grouping this does is a regex-replace per
                // skipped row against a transaction already upserting every row of the run.
                skippedRowAdvisories.push(
                    ...formatSkippedAuthorDays(providerType, identifier, skippedRows),
                    ...formatSkippedPRRecords(providerType, identifier, skippedPRRecords),
                );
                // Both grains, because the field they feed answers "how many rows did this run
                // not write", and both are rows it did not write. Which is which stays legible
                // on the two advisory lines just staged; the number is the coarse signal that
                // reaches `sync_logs.records_skipped` and `toprope sync`'s summary (#306).
                //
                // IT NO LONGER PARTITIONS WITH `snapshotsWritten`, and that is worth stating
                // rather than leaving for a reader to discover from "100 written, 40 skipped".
                // `snapshotsWritten` counts git_snapshots CELLS; this counts legacy cells plus
                // refused raw_author_daily rows plus refused pr_records rows. The two are not
                // slices of one attempted population and their sum is not an attempt count: a
                // cell folds several raw authors, and a raw row for an unmatched author produces
                // no cell at all. The alternative — a fourth SyncResult field — would be a wire
                // change across all five connectors to carry a number only the git one can ever
                // be non-zero for, so the coarse field plus per-grain advisory lines is the
                // trade. Read the advisory lines for the breakdown; read this for "how much did
                // this run fail to write", which is the question the surfaces actually ask.
                committedRowsSkipped += skippedRows.length + skippedPRRecords.length;
                if (options?.backfill) {
                    setProviderEarliestSyncTime(db, providerType, identifier, options.backfill.since);
                } else {
                    // THE ESCALATION (#306). The skip itself is unchanged — re-asking an
                    // immutable refusal cannot help — but a provider that refused most of what
                    // it built must not settle as `ok`. Two channels, because neither alone
                    // survives every path: the error line turns the admin sync-now surface red
                    // and makes the CLI exit non-zero, and the durable record is what `doctor`
                    // and `status` read on the scheduled path, which records no outcome at all
                    // (see `recordRowRefusal`).
                    //
                    // ON THE FORWARD ARM, deliberately — the same exclusion the stall accounting
                    // above applies and for the same reason. A backfill walks a strictly OLDER
                    // span and leaves the forward cursor untouched (the sibling branch above is
                    // exactly that), so neither its refusals nor its successes say anything
                    // about the forward window this record is about. Counting a backfill's
                    // refusals would raise an alert against a provider syncing forward
                    // perfectly, and — the direction that actually bites — a healthy backfill
                    // would CLEAR a record of a forward-window loss that is still unrepaired, on
                    // the one command an operator runs precisely because they were told data is
                    // missing. Living on this arm rather than behind its own `!backfill` test is
                    // what makes that a property of the structure instead of a second condition
                    // someone could later change independently of the cursor advance it is about.
                    if (skippedRows.length > 0) {
                        const refusal = recordRowRefusal(
                            db,
                            providerType,
                            identifier,
                            skippedRows.length,
                            retainedRowCount,
                            now,
                        );
                        if (isEscalatedRefusal(refusal)) {
                            systemicRefusalErrors.push(
                                formatSystemicRowRefusal(providerType, identifier, refusal),
                            );
                        }
                    } else if (retainedRowCount > 0) {
                        clearRowRefusal(db, providerType, identifier);
                    }
                    // On the FIRST forward sync, ALSO record the true earliest-synced
                    // floor (#229) so the "sync older history" backfill's default is
                    // exact, not the too-recent lazy guess. Guard on an unset
                    // watermark: a first sync should never clobber a lower value a
                    // prior direct-API backfill may have written (the UI can't reach
                    // that ordering, but the route doesn't forbid it). The read runs
                    // inside the write transaction, so this check-then-set is atomic.
                    if (
                        result.firstSyncFloor !== null &&
                        getProviderEarliestSyncTime(db, providerType, identifier) === null
                    ) {
                        setProviderEarliestSyncTime(db, providerType, identifier, result.firstSyncFloor);
                    }
                    // The instant actually COVERED, not `now`: a catch-up run capped by
                    // GIT_CATCHUP_WINDOW_MAX_DAYS (#235) fetched only [since, until], so
                    // advancing to `now` would silently skip the rest. Equal to `now` on
                    // every uncapped run, which is all of them for a healthy provider.
                    setSyncStateValue(db, stateKey, result.forwardCursorTarget);
                }
            });

            for (const record of prRecords) {
                // THE SECOND WRITE IN THE SHARED TRANSACTION (#302/#307). `upsertPRRecord` binds
                // `repo`/`pr_id`/`state`/`created_at` — all `NOT NULL`, all cast rather than
                // validated out of a response body — so a `created_at: null` threw `NOT NULL
                // constraint failed` from inside `insertMany` and rolled back every other
                // provider's window: the identical geometry the raw-row skip closes, one write
                // over. #307 collapsed the old `findPRRecordDefect` pre-check into a catch AT the
                // write (see the `insertMany` PR loop) — which covers a new NOT NULL column the
                // day it is added and counts exactly the PRs actually lost, since the skip now
                // lives after author resolution. So every record is queued here unconditionally.
                fetchedPRRecords.push({record, providerType});
                // Progress counter only — the authoritative resolution happens in the
                // write transaction (see `fetchedPRRecords`).
                const developerId = resolveDeveloperId(
                    devLookup,
                    providerType,
                    record.authorLogin,
                    record.authorEmail,
                );
                if (developerId) matchedDevelopers.add(developerId);
            }

            if (commits.length === 0 && prs.length === 0 && reviewComments.length === 0) {
                // Cursor advance was already queued above for this complete provider.
                continue;
            }

            const metricsMap = aggregateDailyMetrics(commits, prs, churnWindowHours, reviewComments);

            for (const [login, byDate] of metricsMap) {
                // The first commit under this analysis login carries the identity fields
                // the raw row is keyed and pre-filled by. A PR-only author has no commit,
                // so both stay null and the row is keyed by the login alone — the same
                // identity the resolver would have used for them before #253.
                const sampleCommit = commits.find((c) => c.authorLogin === login);
                const emailForLogin = sampleCommit?.authorEmail ?? null;
                const rawAuthorKey = retentionKeyFor(providerType, login, emailForLogin);
                // No stable identity (no login, no email) — nothing to retain it under.
                if (!rawAuthorKey) continue;

                for (const [, metrics] of byDate) {
                    const row: RawAuthorDailyInput = {
                        provider: providerType,
                        // The provider INSTANCE this row is attributed to (#264). `identifier`
                        // is `providerContainer(pc)` — the exact same value this provider's
                        // sync-state keys are built from, so data and cursors now share one
                        // grain and a delete can retract both together.
                        container: identifier,
                        raw_author_key: rawAuthorKey,
                        author_login: login,
                        author_email: emailForLogin,
                        author_display_name: sampleCommit?.authorName ?? null,
                        date: metrics.date,
                        commits: metrics.commits,
                        lines_added: metrics.lines_added,
                        lines_removed: metrics.lines_removed,
                        files_changed: metrics.files_changed,
                        prs_opened: metrics.prs_opened,
                        prs_merged: metrics.prs_merged,
                        review_comments_given: metrics.review_comments_given,
                        avg_time_to_merge_hours: metrics.avg_time_to_merge_hours,
                        code_churn_rate: metrics.code_churn_rate,
                        ai_signature_score: metrics.ai_signature_score,
                        avg_commit_size: metrics.avg_commit_size,
                        commit_burst_count: metrics.commit_burst_count,
                    };
                    // QUEUED FOR THE WRITE PASS, which is where its refusal is now decided
                    // (#302/#307). `upsertRawAuthorDaily` validates fail-closed and THROWS, and it
                    // runs inside this run's single all-providers write transaction — so a row it
                    // will not accept does not cost one row, it rolls back every provider's window,
                    // moves no cursor, and does it again identically on every subsequent run. Three
                    // PR and review-comment dates (`pr.createdAt`, `pr.mergedAt`,
                    // `comment.createdAt`) reach `metrics.date` verbatim with no provider gate
                    // between them and here, and `avg_time_to_merge_hours` is NaN whenever the
                    // first two are unparseable. #307 replaced the pre-check that used to live here
                    // (`findRawAuthorDailyDefect`) with a CATCH of the store's own throw in the
                    // `insertMany` raw loop: one validator, run once, with no twin to keep in step
                    // — and `retainedKeys`/`retainedRowCount` are recorded THERE, on a successful
                    // upsert, so the set means exactly "keys this run wrote". Only a ROW_LEVEL
                    // refusal is skipped there; a run/provider-level one rethrows and rolls back.
                    //
                    // Accumulate WITHIN the run before the store ever sees it, keyed by the
                    // FULL store key — container included (#264).
                    //
                    // Two provider instances of one family (two GitHub orgs, two Bitbucket
                    // workspaces) sharing an author no longer collide here at all: they are
                    // separate rows in the store, so their genuinely-different PRs are never
                    // handed to the across-runs `max()` rule that would have kept only the
                    // larger org's count, permanently, once the cursor advanced past the window.
                    //
                    // The branch is RETAINED as defence-in-depth for a caller that reaches
                    // `syncProviders(db, configs)` with the SAME container twice. Both routes that
                    // build the list are now closed to it — `UNIQUE(type, container)` for DB rows,
                    // and `resolveAllGitProviders` de-dupes config-against-DB *and*
                    // config-against-config (#264) — so this is unreachable through either, and
                    // only a direct programmatic caller bypassing the resolver can produce it.
                    // Summing is the right rule for the shape it was written for (two genuinely
                    // different orgs on one author-day); for a literally-duplicated container it
                    // would double-count, which is exactly why the de-dupe belongs upstream.
                    //
                    // NUL-separated on BOTH joins: a container is free-form text and may
                    // contain spaces, so a space separator would let ('a b', 'key') and
                    // ('a', 'b key') produce the same composite key.
                    const dedupeKey = `${identifier}\u0000${rawAuthorKey}\u0000${metrics.date}`;
                    const prior = rawWrites.get(dedupeKey);
                    rawWrites.set(
                        dedupeKey,
                        prior ? {...prior, ...mergeDailyDisjoint(prior, row)} : row,
                    );
                }

                // Progress counter only — a live estimate for the UI, resolved against the
                // pre-fetch map. The AUTHORITATIVE resolution (which cells to project, and
                // who goes in the unmatched advisory) happens inside the write transaction
                // below against a freshly-read map, because minutes of network fetch sit
                // between the two and a developer created in that gap must not be missed.
                const developerId = resolveRawAuthor(
                    devLookup,
                    providerType,
                    rawAuthorKey,
                    login,
                    emailForLogin,
                );
                if (developerId) matchedDevelopers.add(developerId);
            }
        }

        report?.((p) => {
            p.stage = 'writing';
            p.developers_matched = matchedDevelopers.size;
        });

        // Retain every author's daily facts, PROJECT the touched cells of git_snapshots
        // from them, write the per-PR records AND advance every complete provider's
        // cursor/watermark in a SINGLE transaction (#231/#253). The cursor advances live
        // inside the same tx as the data write, so on any write failure the whole
        // transaction rolls back — no cursor moves past a window whose data was never
        // persisted, no raw row is retained for it either, and the next run re-covers it.
        // `snapshotsWritten` / `snapshotsSkipped` are staged locally and only committed to
        // the run counters after the tx succeeds, so a rolled-back run never reports
        // phantom writes.
        const insertMany = db.transaction(() => {
            // Every write below is gated by `isWritable` (defined above the fetch loop): a
            // provider deleted during this run's minutes of network fetch has had its data
            // retracted and its cursors purged, and re-creating them here would leave rows no
            // delete can retract plus a resurrected cursor. The gate is INVOKED here, inside
            // the transaction, which is what makes it sound.

            // RETAIN FIRST, in a pass of its own. Auto-create below derives its candidates
            // from `raw_author_daily`, and the replay it performs re-projects every date a
            // new developer's retained rows touch — so every row of this run must already
            // be in the store before either happens, or a freshly-created developer's
            // current-window activity would be invisible to their own replay. Splitting the
            // former single loop is exactly what buys "no second pass, no re-fetch".
            for (const row of rawWrites.values()) {
                if (!isWritable(row.provider, row.container)) continue;
                const ck = containerKeyOf(row.provider, row.container);
                try {
                    upsertRawAuthorDaily(db, row, now);
                } catch (e) {
                    // THE SKIP, DECIDED AT THE WRITE (#307). Catch ONLY the store's own typed
                    // refusal, and ONLY a ROW_LEVEL one: those describe a value THIS row alone
                    // carries and that re-fetching returns unchanged, so skipping costs one
                    // author-day and the cursor may still advance. Everything else — a
                    // run/provider-level RawAuthorDailyError (a corrupt clock, a bad provider),
                    // or any other throw (SQLITE_BUSY, a trigger, a bug) — RETHROWS, rolling the
                    // whole transaction back and holding every cursor, which is the fail-closed
                    // behaviour a bare `catch {}` would silently invert.
                    if (e instanceof RawAuthorDailyError && ROW_LEVEL_REFUSALS.includes(e.code)) {
                        pushByContainer(skippedRowsByContainer, ck, {
                            raw_author_key: row.raw_author_key,
                            date: row.date,
                            code: e.code,
                        });
                        continue;
                    }
                    throw e;
                }
                // Recorded only once the store ACCEPTED the row, so `retainedKeys` means exactly
                // "the raw author keys this run wrote" — the allowlist auto-create acts on — and
                // `retainedRowCount` is the accepted-row denominator the refusal ratio weighs the
                // skips against (#306/#307). An author every one of whose days was refused
                // retains nothing and is not offered to the hands-off onboarding.
                retainedKeys.add(row.raw_author_key);
                retainedRowCountByContainer.set(ck, (retainedRowCountByContainer.get(ck) ?? 0) + 1);
            }

            // Opt-in hands-off onboarding (#256), between retention and projection.
            if (autoCreate.enabled && autoCreate.team !== null) {
                autoCreateAdvisories.push(...this.runAutoCreate(db, autoCreate.team, autoCreate, retainedKeys));
            }

            // Read the identity map INSIDE the transaction, and AFTER auto-create: it must
            // see the developers this run just minted, or their rows would be retained but
            // their cells never projected while the cursor advanced past the window that
            // produced them. (The same reason it is re-read at all: `devLookup` was built
            // before minutes of network fetch, during which a developer may have been added.)
            const writeLookup = buildDevLookupMap(db);
            for (const row of rawWrites.values()) {
                if (!isWritable(row.provider, row.container)) continue;
                const developerId = resolveRawAuthor(
                    writeLookup,
                    row.provider,
                    row.raw_author_key,
                    row.author_login,
                    row.author_email,
                );
                if (developerId) {
                    touchedCells.set(`${developerId}:${row.date}`, {developer_id: developerId, date: row.date});
                } else {
                    // The advisory is sourced from the RETAINED rows: exactly the authors
                    // whose day was kept but could not be attributed — precisely the set the
                    // onboarding review queue (DO1.4/DO1.5) will offer to promote.
                    allUnmatched.add(`${row.provider}:${row.author_login ?? row.author_email ?? 'unknown'}`);
                }
            }
            // Rebuild EXACTLY the cells this run touched. Each is recomputed from every
            // retained raw row on that day — including identities this run never fetched —
            // so a scoped single-provider run still yields the full multi-provider total
            // rather than dropping the other provider's same-day contribution (#192/#205).
            const projection = projectSnapshots(db, {cells: [...touchedCells.values()]});
            const written = projection.cellsWritten;
            // A touched cell is skipped ONLY when its stored row is legacy (`is_projected
            // = 0`, pre-#253) and the projection refuses to overwrite an accumulated total
            // it cannot reconstruct. That is real, operator-visible data: on an upgraded
            // deployment the day straddling the upgrade is legacy, so this run's newly
            // retained commits for that day are NOT written while the cursor advances past
            // them. Reporting 0 here would make an incomplete run read as a clean one —
            // exactly the "completion signal is not a currency claim" failure. Surfaced as
            // an advisory below as well, since `records_skipped` alone doesn't say why.
            const skipped = projection.cellsSkippedLegacy;
            // Resolved HERE, against the post-auto-create map — see `fetchedPRRecords`.
            for (const {record, providerType} of fetchedPRRecords) {
                if (!isWritable(providerType, record.container)) continue;
                const developerId = resolveDeveloperId(
                    writeLookup,
                    providerType,
                    record.authorLogin,
                    record.authorEmail,
                );
                if (!developerId) continue;
                // THE SKIP, DECIDED AT THE WRITE (#307), after author resolution — so the count is
                // exactly the PRs actually LOST, not every refused one. `upsertPRRecord` binds
                // `repo`/`pr_id`/`state`/`created_at` (all NOT NULL) from cast response fields, so
                // an unstorable value throws from inside the shared transaction. Catch ONLY that
                // shape (see `isUnstorablePRFieldError`) and skip the one PR; anything else —
                // SQLITE_BUSY, a FK violation, a trigger, a bug — rethrows and rolls back.
                try {
                    upsertPRRecord(db, record, developerId, now);
                } catch (e) {
                    if (isUnstorablePRFieldError(e)) {
                        pushByContainer(skippedPRRecordsByContainer, containerKeyOf(providerType, record.container), {
                            repo: record.repo,
                            prId: record.prId,
                        });
                        continue;
                    }
                    throw e;
                }
            }
            // Advance cursors LAST, still inside the tx: they persist iff every write
            // above committed. Collected only for complete providers, and each closure
            // self-guards on `isWritable` (see where they are pushed).
            for (const advance of cursorAdvances) {
                advance();
            }
            // Stall counters move with the cursors, in the same tx and on the same
            // all-or-nothing terms (#235). A rolled-back run therefore records no stall
            // either — correct, because nothing about it persisted: no cursor moved, and
            // the next run re-covers the window and accounts for itself. Its failure is
            // still loud via the rollback error pushed below.
            for (const update of stallUpdates) {
                update();
            }
            snapshotsWritten = written;
            legacyCellsSkipped = skipped;
        });

        try {
            insertMany();
            // `records_skipped` now means every row this run did not write, not just the legacy
            // projection cells it used to mean (#306) — see `committedRowsSkipped`. Summed only
            // on the commit path, and left at 0 on the rollback path below, for the same reason
            // the advisories are: a rolled-back run wrote nothing AND lost nothing.
            snapshotsSkipped = legacyCellsSkipped + committedRowsSkipped;
            // Committed — only now is the auto-create summary true.
            errors.push(...autoCreateAdvisories);
            // …and only now has any window actually been recorded as covered, which is what
            // the drop advisories claim (#275), the permanent-diff-loss advisories claim (#280),
            // the unobserved-churn advisories claim (#288) and the skipped-author-day advisories
            // claim (#302). All four are cleared by construction on the rollback path below —
            // never pushed there — for the same reason.
            errors.push(...droppedAdvisories);
            errors.push(...diffLossAdvisories);
            errors.push(...churnUnknownAdvisories);
            errors.push(...skippedRowAdvisories);
            // The escalation of the line above (#306), pushed on the same gate. NOT an advisory:
            // this is what stops a provider that refused its whole window settling as `ok`.
            errors.push(...systemicRefusalErrors);
        } catch (err) {
            // Hard failure: the tx rolled back, so NO snapshots were written, NO developer
            // was auto-created and NO cursor advanced — the window is intact and will be
            // re-fetched next run. Surface it clearly rather than swallowing it into a
            // "successful" result.
            snapshotsWritten = 0;
            snapshotsSkipped = 0;
            // Reset alongside them, and NOT redundant with `snapshotsSkipped = 0` since #306:
            // the legacy-cell advisory below now reads this variable, so a run whose transaction
            // threw after the projection pass would otherwise report cells it never skipped —
            // they were rolled back with everything else.
            legacyCellsSkipped = 0;
            autoCreateAdvisories.length = 0;
            // Derived from writes that were discarded, so reporting it would describe a
            // state that does not exist — same reason the auto-create advisories are
            // cleared. The rollback error below is the honest signal.
            allUnmatched.clear();
            // Same reason: the gate's findings describe a discarded transaction. Whether the
            // provider is really gone is re-established by the next run's own gate.
            orphanedContainers.clear();
            // NOTHING to clear for the drop advisories (#275), deliberately: they are pushed
            // only after `insertMany()` returns, so on this path they were never pushed. That
            // is the whole reason they are staged rather than emitted where they are formatted
            // — a rollback advances no cursor, so "nothing re-asks them" would be false, and a
            // structure that needs no retraction cannot forget one.
            errors.push(
                `Failed to write sync data (transaction rolled back — no cursor advanced, window will be re-fetched next run): ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (allUnmatched.size > 0) {
            errors.push(`${UNMATCHED_AUTHORS_PREFIX} ${[...allUnmatched].join(', ')}`);
        }

        // Retract the diffstat rows this run wrote for a container whose owning provider was
        // deleted while we were fetching (#273). The cascade cleared the table for that
        // container when it ran, but the fetch loop kept writing through for minutes
        // afterwards, so without this a delete + re-add leaves the new provider inheriting
        // file-level detail its credentials may no longer justify.
        //
        // Driven off `containerLostOwner` over the run's OWN provider set, not off
        // `orphanedContainers`: the reporting set is populated only by write closures that
        // actually ran, and three reachable paths skip every one of them — a rolled-back
        // transaction (which clears it), a provider whose `fetchProviderData` threw outright,
        // and a BACKFILL run with an incomplete fetch (no stall update, no cursor advance).
        // Those are precisely the failing runs whose partial diffstats the ratchet preserves,
        // i.e. the cases that leave the MOST rows behind.
        //
        // Runs AFTER the transaction and deliberately outside it: correctness never depended
        // on this (the rows are an immutable memo of a remote read), so a failure to tidy a
        // cache must neither roll back a committed sync nor — via the guard — replace a
        // successful `SyncResult` with a throw.
        //
        // Retracts the container's WHOLE cache, not just this run's rows. Equivalent today —
        // the cascade emptied the table for this container, so everything present was written
        // after it by this run — and that equivalence is the reason, not an accident: if a
        // second concurrent writer for one container ever becomes possible, this would discard
        // its work too and would need scoping to the shas this run fetched.
        for (const pc of providerConfigs) {
            const container = providerIdentifier(pc);
            if (!containerLostOwner(pc.type, container)) continue;
            try {
                deleteContainerDiffstats(db, pc.type, container);
            } catch {
                // Best-effort by construction; see above.
            }
        }

        // Say that a whole provider's window was discarded, and why. Silent would be the
        // wrong choice twice over: the operator's own delete caused it (so it is not a
        // failure), but a run that fetched a provider and wrote none of it must not read as a
        // clean full run.
        if (orphanedContainers.size > 0) {
            errors.push(
                `${PROVIDER_DELETED_MID_RUN_PREFIX} ${[...orphanedContainers].sort().join(', ')} — ` +
                    'their fetched activity was discarded and no cursor advanced, because the provider ' +
                    'that owned them (and its imported data) was removed while this run was fetching. ' +
                    'If the container was re-added, sync it again to import it under the new provider.',
            );
        }

        // Say WHY cells were skipped, not just how many. `records_skipped` is a bare
        // number on the sync log; without this an operator sees a "complete" run whose
        // count silently disagrees with the data, and has nothing to search for. It is now a
        // SUM of three grains (#306), which makes naming this one's own count here load-bearing
        // rather than cosmetic: `records_skipped` no longer equals the number in this sentence.
        if (legacyCellsSkipped > 0) {
            errors.push(
                `${LEGACY_CELLS_SKIPPED_PREFIX} ${legacyCellsSkipped} cell(s) were left untouched because they hold pre-upgrade totals the projection cannot reconstruct. Their raw authorship IS retained; re-run "sync older history" for the affected window if those days matter.`,
            );
        }

        return {connector: CONNECTOR_NAME, snapshotsWritten, snapshotsSkipped, errors, lastSyncTime: now};
    }

    /**
     * Opt-in auto-create (#256): turn this run's unmatched HUMAN authors into developers,
     * attributed in the same run. Returns the lines to surface on the SyncResult.
     *
     * MUST be called from inside the sync write transaction, between retention and
     * projection. That placement is what makes the epic's atomicity criterion hold —
     * creation, projection and the cursor advance commit together, so a rolled-back run
     * creates nobody — and what makes "no second pass, no re-fetch" true: the new
     * developer's own replay sees this run's rows because they are already retained.
     *
     * Everything below the team check is DELEGATED, not re-implemented. `promoteAllCandidates`
     * already derives candidates from the raw store, hard-skips bots via the shared
     * classifier, and creates each developer through `createDeveloperWithReplay` — which
     * carries the identity-uniqueness guard and the replay. Re-deriving any of that here
     * would be a second definition of who a bot is, or of what a duplicate is, and the two
     * would drift. Auto-create's only additions are the run scope, the operator denylist,
     * and `unreviewed` — the flag that keeps a self-asserted commit email from becoming an
     * attribution claim when nobody is vouching for the row — all passed as options.
     *
     * Cost note: the creations are batched into ONE whole-day rebuild, not one replay each
     * (`promoteAllCandidates` defers the per-create replay and issues a single
     * `replayDevelopers` over the union of their dates). That matters because this runs
     * inside the run's write transaction: a `dates`-mode projection rebuilds every cell on
     * the days it covers regardless of whose replay asked for it, so the per-creation shape
     * re-did almost the same rebuild once per author and held the SQLite write lock for the
     * duration. Batching is exact rather than approximate — the projection is idempotent
     * and order-independent, so one pass over the union writes what N passes converge to.
     * It also does NOT fork the create path: `createDeveloperWithReplay` is still the single
     * write boundary; only the projection call is hoisted out of the loop.
     */
    private runAutoCreate(
        db: Database.Database,
        team: string,
        settings: AutoCreateSettings,
        retainedKeys: ReadonlySet<string>,
    ): string[] {
        // FAIL CLOSED on an unusable team: create it when absent (parity with GitHub-org
        // discovery's default team), but refuse an ARCHIVED one. A developer created into
        // an archived team is absent from every team aggregate — the write "succeeds" and
        // the person never appears, which is the silent hole this epic exists to close.
        // Reported as a genuine error (no advisory prefix) so it turns the provider red
        // rather than reading as a run that simply had nobody to onboard.
        if (!ensureTeam(db, team)) {
            return [
                `Auto-create is enabled but team '${team}' is archived — no developers were created. Un-archive it or change connectors.git.auto_create_team.`,
            ];
        }
        if (retainedKeys.size === 0) return [];

        const result = promoteAllCandidates(db, team, {
            onlyKeys: retainedKeys,
            exclusions: settings.exclude,
            // No human is reviewing these rows, so only provider-verified logins are
            // onboarded and the created developers claim no self-asserted commit email.
            unreviewed: true,
        });
        // Nothing observed and nothing skipped — stay silent rather than emit a line every
        // run reporting that a steady-state sync onboarded nobody.
        if (result.promoted === 0 && result.skippedBots === 0 && result.failed === 0) return [];

        const lines = [
            `${AUTO_CREATE_SUMMARY_PREFIX} ${result.promoted} developers (${result.skippedBots} bot authors skipped) into team '${team}'`,
        ];
        if (result.failed > 0) {
            // Deliberately NOT advisory-prefixed. A candidate that could not be promoted is
            // authorship that stays unattributed, and the operator has to see it. The most
            // common cause is benign-but-worth-knowing: two raw keys for one person, the
            // second colliding with the developer the first just created.
            const detail = result.entries
                .filter((e): e is Extract<typeof e, {status: 'failed'}> => e.status === 'failed')
                .map((e) => `${e.candidate.raw_author_key} (${e.reason}: ${e.message})`)
                .join('; ');
            lines.push(autoCreateFailureLine(result.failed, detail));
        }
        return lines;
    }

    // Resolve the providers this sync run should cover: DB-connected providers
    // (via the store) merged with config-file providers, DB winning on overlap.
    // Loads the server key here (fail-closed) so a UI-connected provider's token
    // can be decrypted; a config-only setup with no key is unaffected.
    private getProviderConfigs(db: Database.Database): GitProviderConfig[] {
        return resolveAllGitProviders(db, loadServerKey(), this.config);
    }
}
