import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../../dashboard/fixtures';
import {insertCapture} from '../../../src/capture/store';
import {buildCapturePayload} from '../../../src/capture/client';
import {generateDeveloperKey} from '../../../src/capture/encryption';
import {insertLoopEvent} from '../../../src/coaching/realtime/store';
import {generateImprovementReview, ImprovementError, type ImprovementAnalyzers} from '../../../src/coaching/improvement/generator';
import {
    LocalHeuristicImprovementAnalyzer,
    type ImprovementAnalyzer,
    type ImprovementResult,
    type SessionAnalysisInput,
} from '../../../src/coaching/improvement/analyzer';

const NOW = '2026-06-15T00:00:00.000Z';
const SESSION = 'sess-1';
const SECRET = 'SUPERSECRETMARKER refactor the billing code in src/billing.ts';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, team, NOW);
}

function seedCapture(db: Database.Database, developerId: string, key: Buffer, plaintext: string): void {
    const payload = buildCapturePayload(
        {key, keyId: 'k1', mechanism: 'local_agent'},
        {sessionId: SESSION, plaintext, capturedAt: NOW, tool: 'claude_code', promptCount: 1},
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

/** A fake cloud analyser that records whether — and on what plaintext — it was invoked. */
function fakeCloud(): ImprovementAnalyzer & {called: boolean; lastPlaintext: string} {
    return {
        location: 'cloud' as const,
        model: 'cloud-test-model',
        called: false,
        lastPlaintext: '',
        analyze(input: SessionAnalysisInput): ImprovementResult {
            this.called = true;
            this.lastPlaintext = input.plaintext;
            return {reviewText: 'cloud review', suggestions: [{category: 'specificity', suggestion: 'cloud: be specific in 1 prompt'}]};
        },
    };
}

function localOnly(): ImprovementAnalyzers {
    return {local: new LocalHeuristicImprovementAnalyzer()};
}

describe('Improvement review generator (Task 6.5)', () => {
    let db: Database.Database;
    let key: Buffer;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', NOW);
        seedDeveloper(db, 'alice', 'eng');
        key = generateDeveloperKey();
    });

    afterEach(() => db.close());

    it('generates an improvement review from a captured conversation, defaulting to local', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const review = await generateImprovementReview(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(review.analysisLocation).toBe('local');
        expect(review.analysisModel).toBe('local-default');
        expect(review.reviewText.length).toBeGreaterThan(0);
        expect(review.suggestions.length).toBeGreaterThan(0);
        expect(review.analyzedCaptureCount).toBe(1);
    });

    it('records how many captures the review was derived from (provenance)', async () => {
        seedCapture(db, 'alice', key, 'prompt: first');
        seedCapture(db, 'alice', key, 'prompt: second');
        const review = await generateImprovementReview(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(review.analyzedCaptureCount).toBe(2);
    });

    it('NEVER persists or exposes the decrypted plaintext or the key (verified)', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const review = await generateImprovementReview(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(JSON.stringify(review)).not.toContain('SUPERSECRETMARKER');
        const rows = db.prepare('SELECT * FROM improvement_reviews').all() as Record<string, unknown>[];
        expect(rows.length).toBe(1);
        expect(JSON.stringify(rows)).not.toContain('SUPERSECRETMARKER');
        expect(JSON.stringify(rows)).not.toContain(key.toString('base64'));
    });

    it('incorporates the conversation’s loop metadata (Task 5.6) into the analysis', async () => {
        seedCapture(db, 'alice', key, 'prompt: a well specified request with plenty of words here');
        insertLoopEvent(db, 'alice', {sessionId: SESSION, detectedAt: NOW, similarPromptCount: 3});
        const review = await generateImprovementReview(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'local',
            cloudAllowed: false,
            analyzers: localOnly(),
        });
        expect(review.suggestions.map((s) => s.suggestion).join(' ')).toMatch(/loop/i);
    });

    it('refuses cloud analysis when not allowed (Phase 5 opt-in gate) — and never decrypts', async () => {
        const cloud = fakeCloud();
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        await expect(
            generateImprovementReview(db, {
                developerId: 'alice',
                sessionId: SESSION,
                key,
                requestedLocation: 'cloud',
                cloudAllowed: false,
                analyzers: {local: new LocalHeuristicImprovementAnalyzer(), cloud},
            }),
        ).rejects.toMatchObject({code: 'cloud_not_allowed'} satisfies Partial<ImprovementError>);
        // The cloud analyser never ran, so no plaintext was produced for a forbidden request.
        expect(cloud.called).toBe(false);
        expect(cloud.lastPlaintext).toBe('');
    });

    it('checks the cloud gate STRICTLY BEFORE decrypt — a forbidden cloud request with a WRONG key is still cloud_not_allowed, not decrypt_failed', async () => {
        // The strongest proof of ordering: if the code decrypted before gating, the
        // wrong key would surface as decrypt_failed (422). Because the gate runs first,
        // a forbidden cloud request short-circuits with cloud_not_allowed and the wrong
        // key is never even tried — so plaintext is never produced for a denied request.
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const wrongKey = generateDeveloperKey();
        await expect(
            generateImprovementReview(db, {
                developerId: 'alice',
                sessionId: SESSION,
                key: wrongKey,
                requestedLocation: 'cloud',
                cloudAllowed: false,
                analyzers: {local: new LocalHeuristicImprovementAnalyzer(), cloud: fakeCloud()},
            }),
        ).rejects.toMatchObject({code: 'cloud_not_allowed'});
    });

    it('runs cloud analysis ONLY when allowed AND a cloud analyser is configured', async () => {
        const cloud = fakeCloud();
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const review = await generateImprovementReview(db, {
            developerId: 'alice',
            sessionId: SESSION,
            key,
            requestedLocation: 'cloud',
            cloudAllowed: true,
            analyzers: {local: new LocalHeuristicImprovementAnalyzer(), cloud},
        });
        expect(cloud.called).toBe(true);
        expect(review.analysisLocation).toBe('cloud');
        expect(review.analysisModel).toBe('cloud-test-model');
    });

    it('reports cloud_not_configured when allowed but no cloud analyser exists', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        await expect(
            generateImprovementReview(db, {
                developerId: 'alice',
                sessionId: SESSION,
                key,
                requestedLocation: 'cloud',
                cloudAllowed: true,
                analyzers: localOnly(),
            }),
        ).rejects.toMatchObject({code: 'cloud_not_configured'});
    });

    it('reports no_captures when the conversation has nothing to analyze', async () => {
        await expect(
            generateImprovementReview(db, {
                developerId: 'alice',
                sessionId: 'missing',
                key,
                requestedLocation: 'local',
                cloudAllowed: false,
                analyzers: localOnly(),
            }),
        ).rejects.toMatchObject({code: 'no_captures'});
    });

    it('reports decrypt_failed for a wrong key on an allowed local run (and leaks nothing)', async () => {
        seedCapture(db, 'alice', key, `prompt: ${SECRET}`);
        const wrongKey = generateDeveloperKey();
        await expect(
            generateImprovementReview(db, {
                developerId: 'alice',
                sessionId: SESSION,
                key: wrongKey,
                requestedLocation: 'local',
                cloudAllowed: false,
                analyzers: localOnly(),
            }),
        ).rejects.toMatchObject({code: 'decrypt_failed'});
    });
});
