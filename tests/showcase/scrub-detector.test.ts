import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {detectSensitiveContent, scrubContribution} from '../../src/showcase/scrubDetector';
import {listScrubFlags} from '../../src/showcase/unitsStore';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

function seedContribution(db: Database.Database, id: string): void {
    db.prepare(
        `INSERT INTO contributions
         (id, content_type, title, author_id, scope, scope_target, state, current_version, created_at, updated_at)
         VALUES (?, 'showcase_example', 't', 'dev1', 'org', NULL, 'draft', 1, 'now', 'now')`,
    ).run(id);
}

describe('scrubDetector — detectSensitiveContent (#168)', () => {
    // --- secret_high corpus: each well-known shape is reliably flagged firmly -----

    const SECRET_CORPUS: Array<[string, string]> = [
        ['AWS access key', 'creds AKIAIOSFODNN7EXAMPLE end'],
        ['AWS temp key', 'token ASIAIOSFODNN7EXAMPLE end'],
        ['GitHub PAT', 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here'],
        ['GitHub fine-grained', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsT here'],
        ['Slack token', 'xoxb-123456789012-abcdefABCDEF here'],
        ['Google API key', 'AIzaSyA0123456789abcdefghijklmnopqrstuv key'],
        ['Stripe key', 'sk_live_abcdefghijklmnop1234567890 here'],
        ['OpenAI-style key', 'sk-abcdefghijklmnopqrstuvwxyz12 here'],
        ['Anthropic-style key', 'sk-ant-api03-abcdefghijklmnop here'],
        [
            'JWT',
            'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw',
        ],
        ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
        ['credential assignment', 'config: password = "h0rs3-batt3ry-staple"'],
    ];

    it.each(SECRET_CORPUS)('flags %s at secret_high', (_label, content) => {
        const findings = detectSensitiveContent(content);
        expect(findings.length).toBeGreaterThanOrEqual(1);
        expect(findings.every((f) => f.tier === 'secret_high')).toBe(true);
    });

    it('does NOT store the raw secret verbatim — the finding value is masked', () => {
        const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
        const [finding] = detectSensitiveContent(`token ${secret}`);
        expect(finding.tier).toBe('secret_high');
        expect(finding.finding).not.toContain(secret);
        expect(finding.finding).toContain('…');
        expect(finding.finding).toContain('line 1');
    });

    it('does not raise a high flag on an obvious placeholder credential', () => {
        for (const placeholder of [
            'password = "your_password_here"',
            'api_key = "<your-key>"',
            'secret = "CHANGEME"',
            'token = "xxxxxxxx"',
        ]) {
            const findings = detectSensitiveContent(placeholder);
            expect(findings.filter((f) => f.tier === 'secret_high')).toHaveLength(0);
        }
    });

    it('still flags a real credential whose value merely CONTAINS a stand-in word', () => {
        // Substring suppression would wrongly drop these — they are real secrets.
        for (const real of [
            'api_key = "secretSauce4242XX"', // contains "secret"
            'password = "mytoken99887766"', // contains "token"
            'client_secret = "examplePr0dPass99"', // contains "example"
        ]) {
            const findings = detectSensitiveContent(real);
            expect(findings.filter((f) => f.tier === 'secret_high')).toHaveLength(1);
        }
    });

    // --- pii_hint_low corpus: softer PII, surfaced as fallible hints --------------

    const PII_CORPUS: Array<[string, string]> = [
        ['email', 'reach me at jane.doe@example.com please'],
        ['SSN', 'ssn 123-45-6789 on file'],
        ['phone', 'call 415-555-0132 today'],
        ['IP address', 'host 192.168.10.42 responded'],
        ['customer id', 'customer_id: CUST-90817'],
    ];

    it.each(PII_CORPUS)('flags %s at pii_hint_low and marks it a non-asserted hint', (_label, content) => {
        const findings = detectSensitiveContent(content);
        expect(findings.length).toBeGreaterThanOrEqual(1);
        expect(findings.every((f) => f.tier === 'pii_hint_low')).toBe(true);
        // The hint is explicitly fallible — never asserted as fact.
        expect(findings.every((f) => /hint, verify manually/.test(f.finding))).toBe(true);
    });

    it('is false-positive-tolerant for the PII tier by design (example email still hinted)', () => {
        // An obviously-fake example address is STILL surfaced — we would rather over-hint
        // than miss a real address, because the human review is the real gate.
        const findings = detectSensitiveContent('e.g. foo@example.org in the docs');
        expect(findings).toHaveLength(1);
        expect(findings[0].tier).toBe('pii_hint_low');
    });

    // --- tier separation: the two tiers are produced distinctly, never blurred ----

    it('keeps the two tiers distinct when both are present', () => {
        const content = 'key sk_live_abcdefghijklmnop1234567890 and email bob@corp.com';
        const findings = detectSensitiveContent(content);
        const tiers = findings.map((f) => f.tier);
        expect(tiers).toContain('secret_high');
        expect(tiers).toContain('pii_hint_low');
        // secret-before-hint where positions differ; ordering is deterministic.
        expect(findings[0].tier).toBe('secret_high');
    });

    // --- edge / degenerate inputs -------------------------------------------------

    it('returns no findings for clean content', () => {
        expect(detectSensitiveContent('a perfectly ordinary sentence about code')).toEqual([]);
    });

    it('returns [] for empty or non-string content', () => {
        expect(detectSensitiveContent('')).toEqual([]);
        // @ts-expect-error exercising the defensive runtime guard
        expect(detectSensitiveContent(undefined)).toEqual([]);
    });

    it('flags every occurrence and orders findings deterministically by position', () => {
        const content = 'a@b.com then AKIAIOSFODNN7EXAMPLE then c@d.com';
        const first = detectSensitiveContent(content);
        const second = detectSensitiveContent(content);
        expect(first).toEqual(second); // deterministic
        expect(first.map((f) => f.tier)).toEqual(['pii_hint_low', 'secret_high', 'pii_hint_low']);
        // positions strictly non-decreasing
        for (let i = 1; i < first.length; i++) {
            expect(first[i].index).toBeGreaterThanOrEqual(first[i - 1].index);
        }
    });

    it('reports the correct line number for a multi-line match', () => {
        const [finding] = detectSensitiveContent('line one\nline two\ntoken AKIAIOSFODNN7EXAMPLE');
        expect(finding.finding).toContain('line 3');
    });
});

describe('scrubDetector — scrubContribution persistence (#168)', () => {
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
        seedContribution(db, 'sc1');
    });

    afterEach(() => {
        db.close();
    });

    it('writes a scrub_flags row per finding, both tiers, all unresolved (non-blocking)', () => {
        const content = 'token sk_live_abcdefghijklmnop1234567890 mailto bob@corp.com';
        const written = scrubContribution(db, 'sc1', content);
        expect(written.length).toBe(2);
        // Flag-only: every flag starts UNRESOLVED — the detector blocks nothing.
        expect(written.every((f) => f.resolved === false)).toBe(true);

        const stored = listScrubFlags(db, 'sc1');
        expect(stored.map((f) => f.tier).sort()).toEqual(['pii_hint_low', 'secret_high']);
    });

    it('persists nothing when content is clean', () => {
        const written = scrubContribution(db, 'sc1', 'nothing sensitive here at all');
        expect(written).toEqual([]);
        expect(listScrubFlags(db, 'sc1')).toEqual([]);
    });

    it('does not mutate the contribution content (flag-only, no auto-redaction)', () => {
        const content = 'secret AKIAIOSFODNN7EXAMPLE stays put';
        scrubContribution(db, 'sc1', content);
        // No showcase_units row is created/altered by scrubbing — the detector only
        // writes scrub_flags; the conversation column is untouched.
        const unit = db.prepare('SELECT * FROM showcase_units WHERE contribution_id = ?').get('sc1');
        expect(unit).toBeUndefined();
    });
});
