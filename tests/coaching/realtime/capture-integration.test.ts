import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../../dashboard/fixtures';
import {createLocalAgent} from '../../../src/capture/local-agent';
import {createEditorExtension} from '../../../src/capture/editor-extension';
import {generateDeveloperKey} from '../../../src/capture/encryption';
import type {CaptureClient} from '../../../src/capture/client';
import {RealtimeCoach} from '../../../src/coaching/realtime/coach';
import {insertLoopEvent, insertNudgeEvent, listLoopEventsForDeveloper, listNudgeEventsForDeveloper} from '../../../src/coaching/realtime/store';

/**
 * End-to-end proof that the local real-time coach actually RUNS at the capture
 * layer for BOTH mechanisms (deliverable: "loop detector running locally at the
 * agent + extension"), and that the privacy contract holds across the whole local
 * → metadata → persistence boundary: a prompt fed to a capture client's `observe`
 * produces only syncable METADATA, which persists as metadata, with the prompt
 * text never appearing on any event or stored row.
 */

const SECRET = 'SUPERSECRETMARKER why does the deploy keep timing out on staging';
const NOW = '2026-06-15T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(`team-${id}`, NOW);
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} Dev`, `${id}@test.com`, `team-${id}`, NOW);
}

function buildClient(kind: 'agent' | 'extension', coach: RealtimeCoach): CaptureClient {
    const config = {key: generateDeveloperKey(), keyId: 'k1', coach};
    const noopTransport = async (): Promise<void> => {};
    return kind === 'agent' ? createLocalAgent(config, noopTransport) : createEditorExtension(config, noopTransport);
}

describe('capture-layer realtime integration (Task 5.6)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        seedDeveloper(db, 'alice');
    });

    afterEach(() => db.close());

    it.each(['agent', 'extension'] as const)(
        'the %s runs the local coach via client.observe and emits only metadata (no prompt text)',
        (kind) => {
            const coach = new RealtimeCoach({
                settings: {enabled: true, frequency: 'high', dismissible: true},
                sessionId: 'sess-1',
                loop: {similarityThreshold: 0.6, minSimilar: 3, windowSize: 10},
            });
            const client = buildClient(kind, coach);

            // Feed the same prompt three times → a loop of 3 + a repeated_prompt nudge.
            client.observe(SECRET);
            client.observe(SECRET);
            const result = client.observe(SECRET);
            expect(result).not.toBeNull();
            expect(result!.loopEvent?.similarPromptCount).toBe(3);
            expect(result!.nudges.map((n) => n.type)).toContain('repeated_prompt');

            // The local-only result carries NO prompt text — only metadata.
            expect(JSON.stringify(result)).not.toContain('SUPERSECRETMARKER');

            // Persist the synced metadata and read it back: still no content anywhere.
            insertLoopEvent(db, 'alice', result!.loopEvent!);
            for (const ev of result!.nudgeEvents) {
                insertNudgeEvent(db, 'alice', ev);
            }
            const loops = listLoopEventsForDeveloper(db, 'alice');
            const nudges = listNudgeEventsForDeveloper(db, 'alice');
            expect(loops[0].similarPromptCount).toBe(3);
            expect(nudges.some((n) => n.nudgeType === 'repeated_prompt')).toBe(true);

            // The raw stored rows (full table dump) contain no fragment of the prompt.
            const dump = JSON.stringify([
                ...db.prepare('SELECT * FROM loop_events').all(),
                ...db.prepare('SELECT * FROM nudge_events').all(),
            ]);
            expect(dump).not.toContain('SUPERSECRETMARKER');
            expect(dump).not.toContain('deploy');
        },
    );

    it('a coach-less client returns null from observe (coaching is opt-in plumbing)', () => {
        const config = {key: generateDeveloperKey(), keyId: 'k1'};
        const agent = createLocalAgent(config, async () => {});
        expect(agent.observe(SECRET)).toBeNull();
    });
});
