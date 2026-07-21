/**
 * The trust boundary for opt-in auto-create-during-sync (DO1.6 / #256, Epic DO1 / #250).
 *
 * `connectors.git.auto_create_developers` is the one config flag in this product that
 * MANUFACTURES identity records without a human in the loop. Everything about how it is
 * read here follows from that:
 *
 *  - **Default OFF, and off means off.** An absent flag, an explicit `false`, or anything
 *    that is not the boolean `true` yields `{enabled: false}`. There is no truthiness
 *    coercion — see the runtime-narrowing note below.
 *  - **Fail closed, never silent no-op.** `enabled: true` with no usable team is a THROWN
 *    config error, not a run that quietly creates nobody. A silent no-op is the worst
 *    outcome available: the operator believes onboarding is automatic, sees no developers,
 *    and has nothing to read that explains why.
 *  - **Validated at RUNTIME, not by the TypeScript union.** `GitConnectorConfig` declares
 *    these three keys `unknown` deliberately. The config is YAML run through `${ENV}`
 *    expansion, so `auto_create_developers: "${ONBOARD}"` reaches this function as the
 *    STRING `"false"` — truthy under `if (cfg.auto_create_developers)`, and a compile-time
 *    `boolean` annotation would have asserted a shape the data does not enforce. Every
 *    field is narrowed with a `typeof` check and rejected if it does not match.
 *
 * Called from BOTH boundaries on purpose: `loadConfig` (so a bad file fails at startup,
 * loudly, before any sync) and `GitSync.syncProviders` (so a config assembled
 * programmatically — tests, an embedder, a future admin-written config — cannot reach the
 * create path unvalidated). One definition, two entry points; a validator only the loader
 * calls is a validator the write path does not have.
 */

import type {GitConnectorConfig} from './types';

/** Longest accepted `auto_create_team`. Matches the developer-name clamp in onboarding. */
export const AUTO_CREATE_TEAM_MAX_LENGTH = 100;

/**
 * Bounds on `auto_create_exclude`. These are upper bounds on a value an operator controls
 * that is compiled into regular expressions and evaluated once per candidate author — the
 * "range-validate on BOTH bounds" rule. Unbounded, a pathological config could make a
 * first sync's classification pass arbitrarily expensive.
 */
export const AUTO_CREATE_EXCLUDE_MAX_PATTERNS = 200;
export const AUTO_CREATE_EXCLUDE_MAX_PATTERN_LENGTH = 200;
/**
 * Wildcards allowed in ONE pattern. `*` compiles to `.*`, and backtracking cost on a
 * NON-matching subject is superlinear in the wildcard count: `^.*a.*b.*c$` against an
 * n-character subject explores O(n³) split points. The subject is `author_login` /
 * `author_email` — provider-supplied, and in the email's case set by whoever made the
 * commit — so an attacker chooses n, and the match runs inside the sync write transaction
 * while it holds a SQLite write lock.
 *
 * So the bound is set by what makes the class unreachable, not by what a config might
 * plausibly want: 2 covers every real denylist shape (`svc-*`, `*@bots.corp.example`,
 * `*-deploy-*`) and keeps the exponent at a level the subject clamp in `classifyAuthor`
 * finishes instantly. Raising this without also revisiting that clamp reopens the hang.
 */
export const AUTO_CREATE_EXCLUDE_MAX_WILDCARDS = 2;

/** Thrown for any violation below. Distinct type so callers can report it as a CONFIG fault. */
export class GitAutoCreateConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GitAutoCreateConfigError';
    }
}

/**
 * The narrowed, validated settings. When `enabled` is false, `team` is `null` and `exclude`
 * is empty — the disabled shape cannot express a team, so no caller can accidentally use
 * one from a config whose flag is off.
 */
export interface AutoCreateSettings {
    enabled: boolean;
    /** Trimmed, non-empty — present IFF `enabled`. */
    team: string | null;
    /** Compiled operator exclusion patterns, anchored + case-insensitive. Possibly empty. */
    exclude: readonly RegExp[];
}

/** The settings a config with the flag off resolves to. */
const DISABLED: AutoCreateSettings = {enabled: false, team: null, exclude: []};

/**
 * Compile one operator pattern into an anchored, case-insensitive matcher.
 *
 * The pattern language is deliberately NOT regex: `*` (match any run of characters) is the
 * only metacharacter, everything else is literal. Accepting operator regex would mean
 * compiling an arbitrary expression and evaluating it against provider-supplied logins and
 * emails — the classic ReDoS shape — and would make `dependabot[bot]` (a character class!)
 * silently not mean what an operator typing it expects.
 *
 * Anchored at both ends so `renovate` excludes exactly `renovate`, not `renovate-fan`; an
 * operator who wants a prefix writes `renovate*`, which is explicit and readable.
 */
function compileExcludePattern(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
}

/** `typeof x === 'string'` with the error message the caller wants, or throw. */
function requireString(value: unknown, what: string): string {
    if (typeof value !== 'string') {
        throw new GitAutoCreateConfigError(
            `connectors.git.${what} must be a string (got ${value === null ? 'null' : typeof value}).`,
        );
    }
    return value;
}

/**
 * Validate `auto_create_exclude` and compile it.
 *
 * Validated even when the flag is OFF. A typo'd denylist that only fails the day someone
 * flips the flag on is a config error stored up for exactly the moment it does the most
 * damage — the first hands-off run.
 */
function resolveExclude(raw: unknown): readonly RegExp[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        throw new GitAutoCreateConfigError(
            `connectors.git.auto_create_exclude must be an array of strings (got ${typeof raw}).`,
        );
    }
    if (raw.length > AUTO_CREATE_EXCLUDE_MAX_PATTERNS) {
        throw new GitAutoCreateConfigError(
            `connectors.git.auto_create_exclude has ${raw.length} patterns; the maximum is ${AUTO_CREATE_EXCLUDE_MAX_PATTERNS}.`,
        );
    }

    return raw.map((entry, i) => {
        const value = requireString(entry, `auto_create_exclude[${i}]`).trim();
        if (!value) {
            throw new GitAutoCreateConfigError(
                `connectors.git.auto_create_exclude[${i}] is blank; remove it rather than matching everything.`,
            );
        }
        if (value.length > AUTO_CREATE_EXCLUDE_MAX_PATTERN_LENGTH) {
            throw new GitAutoCreateConfigError(
                `connectors.git.auto_create_exclude[${i}] is ${value.length} characters; the maximum is ${AUTO_CREATE_EXCLUDE_MAX_PATTERN_LENGTH}.`,
            );
        }
        const wildcards = (value.match(/\*/g) ?? []).length;
        if (wildcards > AUTO_CREATE_EXCLUDE_MAX_WILDCARDS) {
            throw new GitAutoCreateConfigError(
                `connectors.git.auto_create_exclude[${i}] has ${wildcards} '*' wildcards; the maximum is ${AUTO_CREATE_EXCLUDE_MAX_WILDCARDS}.`,
            );
        }
        return compileExcludePattern(value);
    });
}

/**
 * Narrow and validate the git connector's auto-create settings, or throw.
 *
 * On the TEAM specifically. This function validates that a team name was SUPPLIED and is
 * usable as a name; it cannot check that the team EXISTS, because it has no database — and
 * pushing a DB read in here would make config validation depend on storage. Existence is
 * settled at the write boundary instead (`ensureTeam`, called from `GitSync.runAutoCreate`),
 * which creates the team when it is absent — the epic's "or be auto-created like
 * discovery's default team" — and
 * REFUSES when it exists but is archived. So the fail-closed guarantee is split across two
 * checks by necessity, and neither is a silent no-op:
 *   - here: flag on + missing/blank/non-string team  -> config error at startup;
 *   - there: flag on + archived team                 -> the run auto-creates nobody and
 *                                                       surfaces a loud error.
 */
export function resolveAutoCreateSettings(git: GitConnectorConfig | undefined): AutoCreateSettings {
    if (!git) return DISABLED;

    const flag = git.auto_create_developers;
    const exclude = resolveExclude(git.auto_create_exclude);

    // Strict boolean. `undefined`/absent is the default-off path; anything else that is
    // not a boolean is an operator mistake worth failing on rather than guessing at,
    // because BOTH guesses are wrong in a way that matters: coercing "false" to true
    // creates developers nobody asked for, coercing "true" to false silently disables the
    // feature the operator configured.
    if (flag === undefined || flag === null) return {...DISABLED, exclude};
    if (typeof flag !== 'boolean') {
        throw new GitAutoCreateConfigError(
            `connectors.git.auto_create_developers must be a boolean true or false (got ${typeof flag}: ${JSON.stringify(flag)}). ` +
                'Quoted YAML values and unexpanded ${ENV} references are not accepted.',
        );
    }
    if (!flag) return {...DISABLED, exclude};

    if (git.auto_create_team === undefined || git.auto_create_team === null) {
        throw new GitAutoCreateConfigError(
            'connectors.git.auto_create_team is required when connectors.git.auto_create_developers is true.',
        );
    }
    const team = requireString(git.auto_create_team, 'auto_create_team').trim();
    if (!team) {
        throw new GitAutoCreateConfigError(
            'connectors.git.auto_create_team is blank; auto-created developers must land in a named team.',
        );
    }
    if (team.length > AUTO_CREATE_TEAM_MAX_LENGTH) {
        throw new GitAutoCreateConfigError(
            `connectors.git.auto_create_team is ${team.length} characters; the maximum is ${AUTO_CREATE_TEAM_MAX_LENGTH}.`,
        );
    }

    return {enabled: true, team, exclude};
}
