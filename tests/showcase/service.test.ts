import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {setGlobalSetting} from '../../src/settings/store';
import {insertCapture} from '../../src/capture/store';
import {buildCapturePayload} from '../../src/capture/client';
import {generateDeveloperKey} from '../../src/capture/encryption';
import {
    draftFromSession,
    publishExample,
    ShowcaseError,
    type PublishExampleInput,
} from '../../src/showcase/service';

const NOW = '2026-06-13T00:00:00.000Z';
const SESSION = 'sess-1';
const SECRET = 'SUPERSECRETMARKER refactor src/billing.ts';

function seedDeveloper(db: Database.Database, id: string, team: string | null): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

function seedCapture(db: Database.Database, developerId: string, sessionId: string, key: Buffer, plaintext: string): void {
    const payload = buildCapturePayload(
        {key, keyId: 'k1', mechanism: 'local_agent'},
        {sessionId, plaintext, capturedAt: NOW, tool: 'claude_code', promptCount: 1},
    );
    insertCapture(db, {
        developerId,
        sessionId: payload.session_id,
        capturedAt: payload.captured_at,
        tool: payload.tool ?? null,
        ciphertext: Buffer.from(payload.ciphertext, 'base64'),
        encryptionMeta: payload.encryption_meta as unknown as Record<string, unknown>,
        mechanism: 'local_agent',
        promptCount: 1,
    });
}

function publishInput(overrides: Partial<PublishExampleInput> = {}): PublishExampleInput {
    return {
        authorDeveloperId: 'alice',
        team: 'eng',
        scope: 'team',
        title: 'A good session',
        content: 'redacted content',
        taskType: 'refactor',
        tool: 'claude_code',
        authorNote: null,
        redactionAcknowledged: true,
        ...overrides,
    };
}

describe('showcase service (Task 5.8)', () => {
    let db: Database.Database;
    let key: Buffer;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        key = generateDeveloperKey();
        seedCapture(db, 'alice', SESSION, key, `prompt: ${SECRET}`);
        // Showcasing enabled org-wide for the publish-path tests.
        setGlobalSetting(db, 'showcase_enabled', true);
    });

    afterEach(() => {
        db.close();
    });

    describe('draftFromSession (transient decrypt)', () => {
        it('decrypts the owner’s session into an editable draft', () => {
            const draft = draftFromSession(db, {developerId: 'alice', sessionId: SESSION, key});
            expect(draft.plaintext).toContain(SECRET);
            expect(draft.captureCount).toBe(1);
        });

        it('throws no_captures for an empty session', () => {
            expect(() => draftFromSession(db, {developerId: 'alice', sessionId: 'nope', key})).toThrow(ShowcaseError);
            try {
                draftFromSession(db, {developerId: 'alice', sessionId: 'nope', key});
            } catch (err) {
                expect((err as ShowcaseError).code).toBe('no_captures');
            }
        });

        it('throws decrypt_failed for a wrong key', () => {
            const wrong = generateDeveloperKey();
            try {
                draftFromSession(db, {developerId: 'alice', sessionId: SESSION, key: wrong});
                throw new Error('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ShowcaseError);
                expect((err as ShowcaseError).code).toBe('decrypt_failed');
            }
        });

        it('cannot reach another developer’s session (owner-scoped, treated as empty)', () => {
            seedDeveloper(db, 'bob', 'eng');
            try {
                draftFromSession(db, {developerId: 'bob', sessionId: SESSION, key});
                throw new Error('expected throw');
            } catch (err) {
                expect((err as ShowcaseError).code).toBe('no_captures');
            }
        });
    });

    describe('publishExample (owner-submitted redacted content)', () => {
        it('publishes a team-scoped example with scope_target set to the author’s own team', () => {
            const ex = publishExample(db, publishInput({scope: 'team'}));
            expect(ex.scope).toBe('team');
            expect(ex.scopeTarget).toBe('eng');
            expect(ex.content).toBe('redacted content');
        });

        it('persists ONLY the submitted content — the private capture is untouched', () => {
            const beforeCaptureRows = (db.prepare('SELECT COUNT(*) AS n FROM prompt_captures').get() as {n: number}).n;
            publishExample(db, publishInput());
            const afterCaptureRows = (db.prepare('SELECT COUNT(*) AS n FROM prompt_captures').get() as {n: number}).n;
            expect(afterCaptureRows).toBe(beforeCaptureRows);
            // The shared store never contains the secret unless the owner put it there.
            const stored = db.prepare('SELECT content FROM showcase_examples').get() as {content: string};
            expect(stored.content).toBe('redacted content');
            expect(stored.content).not.toContain(SECRET);
        });

        it('refuses to publish when the redaction step was not acknowledged', () => {
            try {
                publishExample(db, publishInput({redactionAcknowledged: false}));
                throw new Error('expected throw');
            } catch (err) {
                expect((err as ShowcaseError).code).toBe('redaction_required');
            }
            expect((db.prepare('SELECT COUNT(*) AS n FROM showcase_examples').get() as {n: number}).n).toBe(0);
        });

        it('refuses to publish when showcasing is disabled', () => {
            setGlobalSetting(db, 'showcase_enabled', false);
            try {
                publishExample(db, publishInput());
                throw new Error('expected throw');
            } catch (err) {
                expect((err as ShowcaseError).code).toBe('showcase_disabled');
            }
        });

        it('refuses org scope under the default team_only policy', () => {
            try {
                publishExample(db, publishInput({scope: 'org'}));
                throw new Error('expected throw');
            } catch (err) {
                expect((err as ShowcaseError).code).toBe('scope_not_permitted');
            }
        });

        it('allows org scope only when the org permits org_wide', () => {
            setGlobalSetting(db, 'showcase_scope_permitted', 'org_wide');
            const ex = publishExample(db, publishInput({scope: 'org'}));
            expect(ex.scope).toBe('org');
            expect(ex.scopeTarget).toBeNull();
        });

        it('rejects team scope for a developer with no team', () => {
            // The no-team guard fires before any DB write, so no developer row is needed.
            try {
                publishExample(db, publishInput({authorDeveloperId: 'nomad', team: null, scope: 'team'}));
                throw new Error('expected throw');
            } catch (err) {
                expect((err as ShowcaseError).code).toBe('scope_not_permitted');
            }
        });
    });
});
