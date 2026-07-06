import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
    createContribution,
    getContribution,
    listContributionVersions,
    listReviewEvents,
} from '../../src/contributions/store';
import type {PrePublishContext} from '../../src/contributions/stateMachine';
import {
    approveAsDeveloper,
    draftSelfPublish,
    publishShowcase,
    submitForReview,
} from '../../src/showcase/publishPaths';
import {
    assembleReviewPanel,
    confirmManualReview,
    manualReviewGate,
    ManualReviewError,
    redactForReview,
} from '../../src/showcase/manualReview';
import {addScrubFlag, listScrubFlags} from '../../src/showcase/unitsStore';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const DEV = 'dev1';
const CURATOR = 'mgr1';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        id,
        `${id}@test.com`,
        'eng',
        '2026-06-20T00:00:00.000Z',
    );
}

function eventTypes(db: Database.Database, contributionId: string): string[] {
    return listReviewEvents(db, contributionId).map((e) => e.event);
}

const CONVERSATION = '[{"id":"t0","role":"user","text":"my key is sk-abc1234567890abcdef"}]';

/** Draft a self-publish showcase and drive it to `submitted` + developer-approved. */
function draftSubmitApprove(
    db: Database.Database,
    overrides: {conversation?: string; curatorsNote?: string} = {},
): string {
    const {contribution} = draftSelfPublish(db, {
        developerId: DEV,
        title: 'a great session',
        conversation: overrides.conversation ?? CONVERSATION,
        curatorsNote: overrides.curatorsNote ?? 'shows test-first prompting',
    });
    submitForReview(db, {contributionId: contribution.id, actorId: DEV});
    approveAsDeveloper(db, {contributionId: contribution.id, developerId: DEV, visibilityScope: 'org'});
    return contribution.id;
}

describe('showcase mandatory manual-review flow (#169)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seedDeveloper(db, DEV);
        seedDeveloper(db, CURATOR);
    });

    afterEach(() => {
        db.close();
    });

    // --- AC#1: publish blocked until manual review is explicitly confirmed ---

    it('blocks publish until manual review is explicitly confirmed, then allows it', () => {
        const id = draftSubmitApprove(db);

        // Developer-approved but NOT yet reviewed → publish is blocked.
        let err: unknown;
        try {
            publishShowcase(db, {contributionId: id, actorId: DEV});
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(ManualReviewError);
        expect((err as ManualReviewError).code).toBe('review_not_confirmed');
        // Rolled back: still submitted, never published.
        expect(getContribution(db, id)?.state).toBe('submitted');
        expect(eventTypes(db, id)).not.toContain('published');

        // Confirm review → publish now succeeds.
        confirmManualReview(db, {contributionId: id, actorId: CURATOR});
        const published = publishShowcase(db, {contributionId: id, actorId: DEV});
        expect(published.state).toBe('published');
    });

    // --- AC#2: review is required EVEN WHEN auto-flag found nothing ----------

    it('requires manual review even when the auto-flag scrubber found nothing', () => {
        // A clean conversation with no scrub flags at all.
        const id = draftSubmitApprove(db, {conversation: '[{"id":"t0","role":"user","text":"hello"}]'});
        expect(listScrubFlags(db, id)).toHaveLength(0);

        // Zero flags does NOT mean "nothing to review" — the gate still blocks.
        expect(() => publishShowcase(db, {contributionId: id, actorId: DEV})).toThrow(ManualReviewError);
        expect(getContribution(db, id)?.state).toBe('submitted');

        confirmManualReview(db, {contributionId: id, actorId: CURATOR});
        expect(publishShowcase(db, {contributionId: id, actorId: DEV}).state).toBe('published');
    });

    // --- AC#3: curator can redact to resolve flags; redactions versioned ----

    it('redacts content to resolve flags and versions the redaction', () => {
        const id = draftSubmitApprove(db);
        const secret = addScrubFlag(db, {contributionId: id, tier: 'secret_high', finding: 'API secret key — sk…ef'});
        expect(listScrubFlags(db, id).every((f) => !f.resolved)).toBe(true);
        const versionsBefore = listContributionVersions(db, id).length;

        const redacted = '[{"id":"t0","role":"user","text":"my key is [REDACTED]"}]';
        const result = redactForReview(db, {
            contributionId: id,
            actorId: CURATOR,
            redactedConversation: redacted,
            resolvedFlagIds: [secret.id],
            note: 'removed leaked key',
        });

        // The flag is resolved.
        expect(result.resolvedFlagIds).toEqual([secret.id]);
        expect(listScrubFlags(db, id).find((f) => f.id === secret.id)?.resolved).toBe(true);

        // The redaction is versioned: a new version row, and the live unit/panel reflect it.
        const versionsAfter = listContributionVersions(db, id);
        expect(versionsAfter.length).toBe(versionsBefore + 1);
        expect(result.version).toBe(versionsAfter.length);
        expect(versionsAfter[versionsAfter.length - 1].body).toBe(redacted);
        expect(assembleReviewPanel(db, id)?.conversation).toBe(redacted);
        // And a `redacted` audit event was recorded.
        expect(eventTypes(db, id)).toContain('redacted');
    });

    it('rejects a redaction that names a flag not belonging to the showcase (fail-closed)', () => {
        const id = draftSubmitApprove(db);
        const other = draftSubmitApprove(db);
        const otherFlag = addScrubFlag(db, {contributionId: other, tier: 'secret_high', finding: 'x'});

        let err: unknown;
        try {
            redactForReview(db, {
                contributionId: id,
                actorId: CURATOR,
                redactedConversation: '[{"id":"t0","role":"user","text":"clean"}]',
                resolvedFlagIds: [otherFlag.id],
            });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(ManualReviewError);
        expect((err as ManualReviewError).code).toBe('unknown_flag');
        // Nothing was written for the target: no new version, no redacted event, flag untouched.
        expect(listContributionVersions(db, id)).toHaveLength(1);
        expect(eventTypes(db, id)).not.toContain('redacted');
        expect(listScrubFlags(db, other).find((f) => f.id === otherFlag.id)?.resolved).toBe(false);
    });

    it('a redaction AFTER confirmation invalidates the review — publish blocked until re-review (SEC-1)', () => {
        const id = draftSubmitApprove(db);
        const secret = addScrubFlag(db, {contributionId: id, tier: 'secret_high', finding: 's'});

        // Curator confirms review of the original content...
        confirmManualReview(db, {contributionId: id, actorId: CURATOR});
        expect(assembleReviewPanel(db, id)?.reviewConfirmed).toBe(true);

        // ...then redacts. The redaction mutates the content the curator attested to,
        // so the prior confirmation no longer applies.
        redactForReview(db, {
            contributionId: id,
            actorId: CURATOR,
            redactedConversation: '[{"id":"t0","role":"user","text":"my key is [REDACTED]"}]',
            resolvedFlagIds: [secret.id],
        });
        expect(assembleReviewPanel(db, id)?.reviewConfirmed).toBe(false);

        // Publishing the redacted-but-unreviewed content is blocked.
        expect(() => publishShowcase(db, {contributionId: id, actorId: DEV})).toThrow(ManualReviewError);
        expect(getContribution(db, id)?.state).toBe('submitted');

        // Re-confirming against the redacted content restores the gate.
        confirmManualReview(db, {contributionId: id, actorId: CURATOR});
        expect(assembleReviewPanel(db, id)?.reviewConfirmed).toBe(true);
        expect(publishShowcase(db, {contributionId: id, actorId: DEV}).state).toBe('published');
    });

    it('a redaction BEFORE confirmation is the normal flow — confirm then publish works', () => {
        const id = draftSubmitApprove(db);
        const secret = addScrubFlag(db, {contributionId: id, tier: 'secret_high', finding: 's'});
        redactForReview(db, {
            contributionId: id,
            actorId: CURATOR,
            redactedConversation: '[{"id":"t0","role":"user","text":"clean"}]',
            resolvedFlagIds: [secret.id],
        });
        confirmManualReview(db, {contributionId: id, actorId: CURATOR});
        expect(publishShowcase(db, {contributionId: id, actorId: DEV}).state).toBe('published');
    });

    it('rejects a blank redaction and a redaction on a published unit (fail-closed)', () => {
        const id = draftSubmitApprove(db);
        expect(() =>
            redactForReview(db, {contributionId: id, actorId: CURATOR, redactedConversation: '   '}),
        ).toThrow(ManualReviewError);

        // Publish it, then redaction is refused (content is already out).
        confirmManualReview(db, {contributionId: id, actorId: CURATOR});
        publishShowcase(db, {contributionId: id, actorId: DEV});
        let err: unknown;
        try {
            redactForReview(db, {
                contributionId: id,
                actorId: CURATOR,
                redactedConversation: '[{"id":"t0","role":"user","text":"x"}]',
            });
        } catch (e) {
            err = e;
        }
        expect((err as ManualReviewError).code).toBe('not_pre_publish');
    });

    // --- AC#4: both scrub tiers shown distinctly during review --------------

    it('assembles a review panel that separates the two scrub tiers distinctly', () => {
        const id = draftSubmitApprove(db);
        const secret = addScrubFlag(db, {contributionId: id, tier: 'secret_high', finding: 'GitHub token — gh…12'});
        addScrubFlag(db, {contributionId: id, tier: 'pii_hint_low', finding: 'possible email (hint) — a…m'});
        addScrubFlag(db, {contributionId: id, tier: 'pii_hint_low', finding: 'possible phone (hint) — 5…0'});

        const panel = assembleReviewPanel(db, id);
        expect(panel).toBeDefined();
        // The two tiers are in distinct buckets, never blurred together.
        expect(panel?.secretFlags.map((f) => f.id)).toEqual([secret.id]);
        expect(panel?.secretCount).toBe(1);
        expect(panel?.piiHintCount).toBe(2);
        expect(panel?.secretFlags.every((f) => f.tier === 'secret_high')).toBe(true);
        expect(panel?.piiHintFlags.every((f) => f.tier === 'pii_hint_low')).toBe(true);
        expect(panel?.unresolvedSecretCount).toBe(1);
        expect(panel?.unresolvedPiiHintCount).toBe(2);
        expect(panel?.reviewConfirmed).toBe(false);
    });

    it('review panel reflects confirmation and resolved counts; returns undefined for a non-showcase', () => {
        const id = draftSubmitApprove(db);
        const secret = addScrubFlag(db, {contributionId: id, tier: 'secret_high', finding: 's'});
        redactForReview(db, {
            contributionId: id,
            actorId: CURATOR,
            redactedConversation: '[{"id":"t0","role":"user","text":"clean"}]',
            resolvedFlagIds: [secret.id],
        });
        confirmManualReview(db, {contributionId: id, actorId: CURATOR});

        const panel = assembleReviewPanel(db, id);
        expect(panel?.secretCount).toBe(1);
        expect(panel?.unresolvedSecretCount).toBe(0);
        expect(panel?.reviewConfirmed).toBe(true);

        // A best practice (no showcase unit) → undefined, so a route can 404 uniformly.
        const bp = createContribution(db, {
            contentType: 'best_practice',
            title: 'not a showcase',
            authorId: DEV,
            scope: 'team',
            scopeTarget: 'eng',
            state: 'submitted',
            body: 'x',
            changeNote: 'init',
        });
        expect(assembleReviewPanel(db, bp.id)).toBeUndefined();
    });

    // --- AC#5: review confirmation recorded in the audit trail --------------

    it('records the manual-review confirmation in the audit trail as a `reviewed` event', () => {
        const id = draftSubmitApprove(db);
        const event = confirmManualReview(db, {contributionId: id, actorId: CURATOR, note: 'looked clean'});
        expect(event.event).toBe('reviewed');
        expect(event.actorId).toBe(CURATOR);
        expect(event.note).toBe('looked clean');
        expect(eventTypes(db, id)).toContain('reviewed');
    });

    it('a `reviewed` event does NOT satisfy the developer-consent gate (distinct controls)', () => {
        // Submit but DO NOT approve as developer; only confirm the manual review.
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'note',
        });
        submitForReview(db, {contributionId: contribution.id, actorId: CURATOR});
        confirmManualReview(db, {contributionId: contribution.id, actorId: CURATOR});

        // Review is confirmed, but developer consent (`approved`) is still missing →
        // publish must refuse on the consent gate, proving the two are independent.
        let err: unknown;
        try {
            publishShowcase(db, {contributionId: contribution.id, actorId: CURATOR});
        } catch (e) {
            err = e;
        }
        // The state machine's gate, not the manual-review gate.
        expect((err as {code?: string}).code).toBe('gate_not_satisfied');
        expect(getContribution(db, contribution.id)?.state).toBe('submitted');
    });

    // --- confirmManualReview state guards -----------------------------------

    it('refuses to confirm review for a non-showcase, a blank actor, or a non-submitted state', () => {
        // Non-showcase.
        const bp = createContribution(db, {
            contentType: 'best_practice',
            title: 't',
            authorId: DEV,
            scope: 'team',
            scopeTarget: 'eng',
            state: 'submitted',
            body: 'x',
            changeNote: 'init',
        });
        expect(() => confirmManualReview(db, {contributionId: bp.id, actorId: CURATOR})).toThrow(ManualReviewError);

        // Draft (not yet submitted) → not_submitted.
        const {contribution} = draftSelfPublish(db, {
            developerId: DEV,
            title: 't',
            conversation: CONVERSATION,
            curatorsNote: 'note',
        });
        let err: unknown;
        try {
            confirmManualReview(db, {contributionId: contribution.id, actorId: CURATOR});
        } catch (e) {
            err = e;
        }
        expect((err as ManualReviewError).code).toBe('not_submitted');

        // Blank actor.
        submitForReview(db, {contributionId: contribution.id, actorId: DEV});
        expect(() => confirmManualReview(db, {contributionId: contribution.id, actorId: '  '})).toThrow(
            ManualReviewError,
        );
    });

    // --- manualReviewGate as a unit (direct hook contract) ------------------

    it('manualReviewGate throws review_not_confirmed when no `reviewed` event exists', () => {
        const id = draftSubmitApprove(db);
        const ctx: PrePublishContext = {
            db,
            contribution: getContribution(db, id)!,
            actorId: DEV,
            timestamp: '2026-06-26T00:00:00.000Z',
        };
        expect(() => manualReviewGate(ctx)).toThrow(ManualReviewError);
        try {
            manualReviewGate(ctx);
        } catch (e) {
            expect((e as ManualReviewError).code).toBe('review_not_confirmed');
        }
    });

    it('manualReviewGate passes once review is confirmed for the current submission', () => {
        const id = draftSubmitApprove(db);
        confirmManualReview(db, {contributionId: id, actorId: CURATOR});
        const ctx: PrePublishContext = {
            db,
            contribution: getContribution(db, id)!,
            actorId: DEV,
            timestamp: '2026-06-26T00:00:00.000Z',
        };
        expect(() => manualReviewGate(ctx)).not.toThrow();
    });
});
