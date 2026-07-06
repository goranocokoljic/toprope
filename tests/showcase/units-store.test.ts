import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {
    addAnnotation,
    addScrubFlag,
    deleteScrubFlags,
    getConsent,
    getShowcaseUnit,
    linkPractice,
    listAnnotations,
    listConsent,
    listLinkedPractices,
    listLinkingShowcases,
    listScrubFlags,
    recordConsent,
    resolveScrubFlag,
    unlinkPractice,
    upsertShowcaseUnit,
} from '../../src/showcase/unitsStore';
import {isValidOutcomeLink} from '../../src/showcase/unitsTypes';

describe('isValidOutcomeLink (#189, SEC-1)', () => {
    it('accepts http and https absolute URLs', () => {
        expect(isValidOutcomeLink('https://example.com/pr/1')).toBe(true);
        expect(isValidOutcomeLink('http://example.com')).toBe(true);
        // Surrounding whitespace is tolerated (the store trims before storing).
        expect(isValidOutcomeLink('  https://example.com  ')).toBe(true);
    });

    it('rejects dangerous schemes, non-URL strings, blanks, and non-strings', () => {
        // eslint-disable-next-line no-script-url
        expect(isValidOutcomeLink('javascript:alert(1)')).toBe(false);
        expect(isValidOutcomeLink('data:text/html,<script>alert(1)</script>')).toBe(false);
        expect(isValidOutcomeLink('ftp://host/x')).toBe(false);
        expect(isValidOutcomeLink('PR#1')).toBe(false);
        expect(isValidOutcomeLink('not a url')).toBe(false);
        expect(isValidOutcomeLink('')).toBe(false);
        expect(isValidOutcomeLink('   ')).toBe(false);
        expect(isValidOutcomeLink(null)).toBe(false);
        expect(isValidOutcomeLink(undefined)).toBe(false);
        expect(isValidOutcomeLink(42)).toBe(false);
    });
});

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function seedContribution(db: Database.Database, id: string, contentType: string): void {
    db.prepare(
        `INSERT INTO contributions
         (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
         VALUES (?, ?, 't', 'dev1', 'org', NULL, 'draft', 1, 'now', 'now')`,
    ).run(id, contentType);
}

describe('showcase unitsStore (#164)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
            'dev1',
            'Author',
            'a@test.com',
            'eng',
            '2026-06-20T00:00:00.000Z',
        );
        seedContribution(db, 'sc1', 'showcase_example');
        seedContribution(db, 'bp1', 'best_practice');
    });

    afterEach(() => {
        db.close();
    });

    // --- showcase unit + curators'-note GATE --------------------------------

    it('upserts and reads back a showcase unit, defaulting optional fields to null', () => {
        const unit = upsertShowcaseUnit(db, {
            contributionId: 'sc1',
            conversation: '[{"role":"user"}]',
            curatorsNote: 'why this is good',
            publishPath: 'self_publish',
        });
        expect(unit.outcomeLink).toBeNull();
        expect(unit.aiAnnotation).toBeNull();

        const read = getShowcaseUnit(db, 'sc1');
        expect(read).toEqual({
            contributionId: 'sc1',
            conversation: '[{"role":"user"}]',
            outcomeLink: null,
            curatorsNote: 'why this is good',
            aiAnnotation: null,
            publishPath: 'self_publish',
        });
    });

    it('updates the 1:1 unit in place on a second upsert', () => {
        upsertShowcaseUnit(db, {
            contributionId: 'sc1',
            conversation: 'v1',
            curatorsNote: 'first',
            publishPath: 'self_publish',
            outcomeLink: 'https://example.com/pr/1',
        });
        upsertShowcaseUnit(db, {
            contributionId: 'sc1',
            conversation: 'v2',
            curatorsNote: 'second',
            publishPath: 'joint_curation',
            outcomeLink: 'https://example.com/pr/2',
            aiAnnotation: 'used few-shot prompting',
        });
        const read = getShowcaseUnit(db, 'sc1');
        expect(read?.conversation).toBe('v2');
        expect(read?.curatorsNote).toBe('second');
        expect(read?.publishPath).toBe('joint_curation');
        expect(read?.aiAnnotation).toBe('used few-shot prompting');
        const count = db.prepare('SELECT COUNT(*) AS n FROM showcase_units').get() as {n: number};
        expect(count.n).toBe(1);
    });

    it('GATES the mandatory curators note: rejects an empty string', () => {
        expect(() =>
            upsertShowcaseUnit(db, {
                contributionId: 'sc1',
                conversation: '[]',
                curatorsNote: '',
                publishPath: 'self_publish',
            }),
        ).toThrow(/curators_note is mandatory/);
        expect(getShowcaseUnit(db, 'sc1')).toBeUndefined();
    });

    it('GATES the mandatory curators note: rejects a whitespace-only string the DB NOT NULL would accept', () => {
        expect(() =>
            upsertShowcaseUnit(db, {
                contributionId: 'sc1',
                conversation: '[]',
                curatorsNote: '   \n\t  ',
                publishPath: 'self_publish',
            }),
        ).toThrow(/curators_note is mandatory/);
    });

    it('rejects an invalid publish_path at the trust boundary (runtime allowlist, fail-closed)', () => {
        expect(() =>
            upsertShowcaseUnit(db, {
                contributionId: 'sc1',
                conversation: '[]',
                curatorsNote: 'note',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                publishPath: 'surveillance' as any,
            }),
        ).toThrow(/invalid publish_path/);
        expect(getShowcaseUnit(db, 'sc1')).toBeUndefined();
    });

    it('returns undefined for a contribution with no unit', () => {
        expect(getShowcaseUnit(db, 'bp1')).toBeUndefined();
    });

    // --- outcome-link scheme GATE (#189, SEC-1) -----------------------------

    it('rejects a javascript: outcome link at the write boundary (stored-XSS fail-closed)', () => {
        expect(() =>
            upsertShowcaseUnit(db, {
                contributionId: 'sc1',
                conversation: '[]',
                curatorsNote: 'note',
                publishPath: 'self_publish',
                // eslint-disable-next-line no-script-url
                outcomeLink: 'javascript:alert(1)',
            }),
        ).toThrow(/outcome_link must be an http\(s\) URL/);
        expect(getShowcaseUnit(db, 'sc1')).toBeUndefined();
    });

    it('rejects a data: outcome link and a non-URL string at the write boundary', () => {
        for (const bad of ['data:text/html,<script>alert(1)</script>', 'PR#1', 'not a url', 'ftp://host/x']) {
            expect(() =>
                upsertShowcaseUnit(db, {
                    contributionId: 'sc1',
                    conversation: '[]',
                    curatorsNote: 'note',
                    publishPath: 'self_publish',
                    outcomeLink: bad,
                }),
            ).toThrow(/outcome_link must be an http\(s\) URL/);
        }
        expect(getShowcaseUnit(db, 'sc1')).toBeUndefined();
    });

    it('accepts http(s) outcome links and normalizes a blank one to null', () => {
        const withLink = upsertShowcaseUnit(db, {
            contributionId: 'sc1',
            conversation: '[]',
            curatorsNote: 'note',
            publishPath: 'self_publish',
            outcomeLink: '  https://example.com/pr/7  ',
        });
        // Trimmed and stored.
        expect(withLink.outcomeLink).toBe('https://example.com/pr/7');

        const blanked = upsertShowcaseUnit(db, {
            contributionId: 'sc1',
            conversation: '[]',
            curatorsNote: 'note',
            publishPath: 'self_publish',
            outcomeLink: '   ',
        });
        expect(blanked.outcomeLink).toBeNull();
    });

    // --- annotations --------------------------------------------------------

    it('records annotations and lists them oldest-first, stable within the same instant', () => {
        const t0 = '2026-06-20T00:00:00.000Z';
        const t1 = '2026-06-20T01:00:00.000Z';
        // Two rows at the SAME instant (t0), inserted in this order, then one later.
        addAnnotation(db, {contributionId: 'sc1', turnRef: 't2', authorId: 'dev1', body: 'second', createdAt: t0});
        addAnnotation(db, {contributionId: 'sc1', turnRef: 't1', authorId: 'dev1', body: 'first', createdAt: t0});
        addAnnotation(db, {contributionId: 'sc1', turnRef: 't3', authorId: 'dev1', body: 'later', createdAt: t1});
        const list = listAnnotations(db, 'sc1');
        // same-instant (t0) rows keep insertion order via the rowid tiebreak; t1 sorts last
        expect(list.map((a) => a.body)).toEqual(['second', 'first', 'later']);
    });

    it('scopes annotation listing to the contribution', () => {
        addAnnotation(db, {contributionId: 'sc1', turnRef: 't1', authorId: 'dev1', body: 'mine'});
        expect(listAnnotations(db, 'bp1')).toEqual([]);
    });

    // --- consent ------------------------------------------------------------

    it('records consent with an explicit visibility scope and defaults approved/approvedAt', () => {
        const consent = recordConsent(db, {
            contributionId: 'sc1',
            developerId: 'dev1',
            visibilityScope: 'team',
        });
        expect(consent.approved).toBe(false);
        expect(consent.approvedAt).toBeNull();
        expect(consent.visibilityScope).toBe('team');
    });

    it('stamps approvedAt when approved is true', () => {
        const consent = recordConsent(db, {
            contributionId: 'sc1',
            developerId: 'dev1',
            visibilityScope: 'org',
            approved: true,
        });
        expect(consent.approved).toBe(true);
        expect(typeof consent.approvedAt).toBe('string');
        expect(consent.approvedAt).not.toBeNull();
    });

    it('rejects an invalid visibility scope at the trust boundary (fail-closed, no silent default)', () => {
        expect(() =>
            recordConsent(db, {
                contributionId: 'sc1',
                developerId: 'dev1',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                visibilityScope: 'public' as any,
            }),
        ).toThrow(/invalid visibility_scope/);
        expect(listConsent(db, 'sc1')).toEqual([]);
    });

    it('getConsent returns the latest decision deterministically by insertion order', () => {
        recordConsent(db, {contributionId: 'sc1', developerId: 'dev1', visibilityScope: 'team', approvedAt: 'now'});
        recordConsent(db, {
            contributionId: 'sc1',
            developerId: 'dev1',
            visibilityScope: 'org',
            approved: true,
            approvedAt: 'now',
        });
        const latest = getConsent(db, 'sc1', 'dev1');
        expect(latest?.visibilityScope).toBe('org');
        expect(latest?.approved).toBe(true);
    });

    it('getConsent returns undefined when the developer has no consent record', () => {
        expect(getConsent(db, 'sc1', 'dev1')).toBeUndefined();
    });

    // --- scrub flags --------------------------------------------------------

    it('records both tiers, lists them, and resolves one', () => {
        const high = addScrubFlag(db, {contributionId: 'sc1', tier: 'secret_high', finding: 'AWS key at turn 3'});
        addScrubFlag(db, {contributionId: 'sc1', tier: 'pii_hint_low', finding: 'possible email'});
        expect(high.resolved).toBe(false);

        let flags = listScrubFlags(db, 'sc1');
        expect(flags.map((f) => f.tier)).toEqual(['secret_high', 'pii_hint_low']);

        expect(resolveScrubFlag(db, high.id)).toBe(true);
        flags = listScrubFlags(db, 'sc1');
        const resolvedFlag = flags.find((f) => f.id === high.id);
        expect(resolvedFlag?.resolved).toBe(true);
    });

    it('resolveScrubFlag returns false for an unknown id', () => {
        expect(resolveScrubFlag(db, 'nope')).toBe(false);
    });

    it('deleteScrubFlags removes only this contribution’s flags and reports the count (#189)', () => {
        addScrubFlag(db, {contributionId: 'sc1', tier: 'secret_high', finding: 'AWS key'});
        addScrubFlag(db, {contributionId: 'sc1', tier: 'pii_hint_low', finding: 'email'});
        seedContribution(db, 'sc2', 'showcase_example');
        addScrubFlag(db, {contributionId: 'sc2', tier: 'secret_high', finding: 'other'});

        expect(deleteScrubFlags(db, 'sc1')).toBe(2);
        expect(listScrubFlags(db, 'sc1')).toEqual([]);
        // A sibling contribution's flags are untouched.
        expect(listScrubFlags(db, 'sc2')).toHaveLength(1);
        // Deleting again is a no-op reporting zero rows removed.
        expect(deleteScrubFlags(db, 'sc1')).toBe(0);
    });

    it('rejects an invalid scrub tier at the trust boundary (fail-closed)', () => {
        expect(() =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            addScrubFlag(db, {contributionId: 'sc1', tier: 'whoops' as any, finding: 'x'}),
        ).toThrow(/invalid scrub tier/);
        expect(listScrubFlags(db, 'sc1')).toEqual([]);
    });

    // --- cross-links --------------------------------------------------------

    it('links a showcase to a practice both ways and is idempotent', () => {
        expect(linkPractice(db, 'sc1', 'bp1')).toBe(true);
        // re-linking the same pair is a no-op, not an error
        expect(linkPractice(db, 'sc1', 'bp1')).toBe(false);

        expect(listLinkedPractices(db, 'sc1')).toEqual(['bp1']);
        expect(listLinkingShowcases(db, 'bp1')).toEqual(['sc1']);
    });

    it('unlinks a cross-link and reports whether a row was removed', () => {
        linkPractice(db, 'sc1', 'bp1');
        expect(unlinkPractice(db, 'sc1', 'bp1')).toBe(true);
        expect(unlinkPractice(db, 'sc1', 'bp1')).toBe(false);
        expect(listLinkedPractices(db, 'sc1')).toEqual([]);
    });
});
