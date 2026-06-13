import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../../dashboard/fixtures';
import {insertCapture} from '../../../src/capture/store';
import {buildCapturePayload} from '../../../src/capture/client';
import {generateDeveloperKey} from '../../../src/capture/encryption';
import {insertLoopEvent} from '../../../src/coaching/realtime/store';
import {
    generateRetrospective,
    answerFollowUp,
    RetrospectiveError,
    type RetrospectiveAnalyzers,
} from '../../../src/coaching/retrospective/generator';
import {LocalHeuristicAnalyzer, type AnalysisResult, type RetrospectiveAnalyzer, type SessionAnalysisInput} from '../../../src/coaching/retrospective/analyzer';

const NOW = '2026-06-15T00:00:00.000Z';
const SESSION = 'sess-1';
const SECRET = 'SUPERSECRETMARKER refactor the billing code in src/billing.ts';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

/** Insert one capture encrypted with `key` for the session, as the blind store would hold it. */
function seedCapture(db: Database.Database, developerId: string, key: Buffer, plaintext: string, capturedAt = NOW): void {
    const payload = buildCapturePayload(
        {key, keyId: 'k1', mechanism: 'local_agent'},
        {sessionId: SESSION, plaintext, capturedAt, tool: 'claude_code', promptCount: 1},
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

/** A fake cloud analyser that records whether it was invoked. */
function fakeCloud(): RetrospectiveAnalyzer & {called: boolean; lastPlaintext: string} {
    const a = {
        location: 'cloud' as const,
        model: 'cloud-test-model',
        called: false,
        lastPlaintext: '',
        analyze(input: SessionAnalysisInput): AnalysisResult {
            this.called = true;
            this.lastPlaintext = input.plaintext;
            return {retrospectiveText: 'cloud narrative', highlights: {worked: ['w'], improve: ['i']}};
        },
        followUp(_input: SessionAnalysisInput, _retro: string, _q: string): string {
            return 'cloud follow-up answer';
        },
    };
    return a;
}

function localOnly(): RetrospectiveAnalyzers {
    return {local: new LocalHeuristicAnalyzer()};
}

describe('Retrospective generator (Task 5.7)', () => {
    let db: Database.Database;
    let key: Buffer;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        key = generateDeveloperKey();
    });

    afterEach(() => {
        db.close();
    });

    it('generates a retrospective from a captured session, defaulting to local', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const retro = await generateRetrospective(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(retro.analysisLocation).toBe('local');
        expect(retro.analysisModel).toBe('local-default');
        expect(retro.retrospectiveText.length).toBeGreaterThan(0);
        // Provenance: the single seeded capture is recorded as what was analyzed.
        expect(retro.analyzedCaptureCount).toBe(1);
    });

    it('records how many captures the retrospective was derived from (provenance)', async () => {
        seedCapture(db, 'alice', key, 'prompt: first');
        seedCapture(db, 'alice', key, 'prompt: second');
        const retro = await generateRetrospective(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(retro.analyzedCaptureCount).toBe(2);
    });

    it('NEVER persists or exposes the decrypted plaintext (verified)', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const retro = await generateRetrospective(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        // The returned output carries no plaintext.
        expect(JSON.stringify(retro)).not.toContain('SUPERSECRETMARKER');
        // No row in the retrospectives table contains the plaintext marker anywhere.
        const rows = db.prepare('SELECT * FROM retrospectives').all() as Record<string, unknown>[];
        expect(rows.length).toBe(1);
        expect(JSON.stringify(rows)).not.toContain('SUPERSECRETMARKER');
        // And the key never landed in the stored row either.
        expect(JSON.stringify(rows)).not.toContain(key.toString('base64'));
    });

    it('incorporates the session’s loop metadata (Task 5.6) into the analysis', async () => {
        seedCapture(db, 'alice', key, 'prompt: fix\nprompt: fix again');
        insertLoopEvent(db, 'alice', {sessionId: SESSION, detectedAt: NOW, similarPromptCount: 3});
        const retro = await generateRetrospective(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(retro.highlights!.improve.join(' ')).toMatch(/loop/i);
    });

    it('refuses cloud analysis when not allowed (org/opt-in gate) — and never decrypts', async () => {
        const cloud = fakeCloud();
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        await expect(
            generateRetrospective(db, {
                developerId: 'alice',
                sessionId: SESSION,
                key,
                requestedLocation: 'cloud',
                cloudAllowed: false,
                analyzers: {local: new LocalHeuristicAnalyzer(), cloud},
            }),
        ).rejects.toMatchObject({code: 'cloud_not_allowed'} satisfies Partial<RetrospectiveError>);
        // Gate is checked BEFORE decrypt: the cloud analyser never ran, so plaintext
        // was never produced for a forbidden cloud request.
        expect(cloud.called).toBe(false);
        expect(cloud.lastPlaintext).toBe('');
    });

    it('runs cloud analysis ONLY when allowed AND a cloud analyser is configured', async () => {
        const cloud = fakeCloud();
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const retro = await generateRetrospective(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'cloud',
            cloudAllowed: true,
            analyzers: {local: new LocalHeuristicAnalyzer(), cloud},
        });
        expect(cloud.called).toBe(true);
        expect(retro.analysisLocation).toBe('cloud');
        expect(retro.analysisModel).toBe('cloud-test-model');
    });

    it('reports cloud_not_configured when allowed but no cloud analyser exists', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        await expect(
            generateRetrospective(db, {
                developerId: 'alice',
                sessionId: SESSION,
                key,
                requestedLocation: 'cloud',
                cloudAllowed: true,
                analyzers: localOnly(),
            }),
        ).rejects.toMatchObject({code: 'cloud_not_configured'});
    });

    it('reports no_captures when the session has nothing to analyze', async () => {
        await expect(
            generateRetrospective(db, {
                developerId: 'alice',
                sessionId: 'missing',
                key,
                requestedLocation: 'local',
                cloudAllowed: false,
                analyzers: localOnly(),
            }),
        ).rejects.toMatchObject({code: 'no_captures'});
    });

    it('reports decrypt_failed for a wrong key (and leaks nothing)', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const wrongKey = generateDeveloperKey();
        await expect(
            generateRetrospective(db, {
                developerId: 'alice',
                sessionId: SESSION,
                key: wrongKey,
                requestedLocation: 'local',
                cloudAllowed: false,
                analyzers: localOnly(),
            }),
        ).rejects.toMatchObject({code: 'decrypt_failed'});
        expect(db.prepare('SELECT COUNT(*) AS n FROM retrospectives').get()).toMatchObject({n: 0});
    });

    it('answers a follow-up using the same location the retrospective ran at', async () => {
        seedCapture(db, 'alice', key, 'prompt: fix\nprompt: fix again');
        insertLoopEvent(db, 'alice', {sessionId: SESSION, detectedAt: NOW, similarPromptCount: 4});
        const retro = await generateRetrospective(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        const answer = await answerFollowUp(db, {
            developerId: 'alice',
            retrospective: retro,
            key,
            question: 'why was the looping flagged?',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(answer).toMatch(/loop/i);
    });

    it('blocks a cloud follow-up once cloud permission is revoked', async () => {
        const cloud = fakeCloud();
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const retro = await generateRetrospective(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'cloud',
            cloudAllowed: true,
            analyzers: {local: new LocalHeuristicAnalyzer(), cloud},
        });
        // Org turned cloud off / developer opted out before the follow-up.
        await expect(
            answerFollowUp(db, {
                developerId: 'alice',
                retrospective: retro,
                key,
                question: 'why?',
                cloudAllowed: false,
                analyzers: {local: new LocalHeuristicAnalyzer(), cloud},
            }),
        ).rejects.toMatchObject({code: 'cloud_not_allowed'});
    });
});
