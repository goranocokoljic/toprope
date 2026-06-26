import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {runMigrations} from '../../src/storage/migrator';
import {setGlobalSetting, setTeamSetting} from '../../src/settings/store';
import {draftSelfPublish} from '../../src/showcase/publishPaths';
import {assembleCuratedUnit} from '../../src/showcase/curation';
import {getShowcaseUnit} from '../../src/showcase/unitsStore';
import {isAiAnnotationEnabledForTeam} from '../../src/showcase/gate';
import type {SummaryModelClient, SummaryModelResult} from '../../src/summaries/model-client';
import {
    AI_ANNOTATION_LABEL,
    SILENT_SENTINEL,
    annotateShowcaseUnit,
    buildAnnotationPrompt,
    createAnnotationClient,
    filterSpecificOrSilent,
    generateAnnotation,
    renderAiAnnotation,
    resolveAnnotationModel,
} from '../../src/showcase/aiAnnotation';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../src/storage/migrations');

const DEV = 'dev1';
const CONVERSATION = '[{"id":"t0","role":"user","text":"Implement parseRange(s: string): Range"}]';

function seedDeveloper(db: Database.Database, id: string, team = 'eng'): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        id,
        `${id}@test.com`,
        team,
        '2026-06-20T00:00:00.000Z',
    );
}

function seedTeam(db: Database.Database, name: string): void {
    db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run(
        name,
        '2026-06-20T00:00:00.000Z',
    );
}

/** A stub client returning a fixed result and counting how many times it was called. */
function stubClient(result: SummaryModelResult): {client: SummaryModelClient; calls: () => number} {
    let calls = 0;
    const client = {
        generate: async (_prompt: string): Promise<SummaryModelResult> => {
            calls += 1;
            return result;
        },
    } as unknown as SummaryModelClient;
    return {client, calls: () => calls};
}

/** A fake `fetch` that records the URL it was hit with and returns a canned Ollama body. */
function ollamaFetch(text: string, recorder?: {url?: string}): typeof fetch {
    return (async (url: string): Promise<Response> => {
        if (recorder) recorder.url = url;
        return {
            ok: true,
            status: 200,
            json: async () => ({response: text}),
            text: async () => JSON.stringify({response: text}),
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** A fake `fetch` that fails with a 5xx so the model client returns a retryable failure. */
function failingFetch(): typeof fetch {
    return (async (): Promise<Response> => {
        return {ok: false, status: 503, text: async () => 'unavailable'} as unknown as Response;
    }) as unknown as typeof fetch;
}

function draftUnit(db: Database.Database, opts: {conversation?: string; team?: string | null; scope?: 'team' | 'org'} = {}): string {
    const {contribution} = draftSelfPublish(db, {
        developerId: DEV,
        title: 'a great session',
        conversation: opts.conversation ?? CONVERSATION,
        curatorsNote: 'shows type-signature-first prompting',
        scope: opts.scope ?? 'team',
        scopeTarget: opts.team ?? null,
    });
    return contribution.id;
}

describe('showcase AI annotation — specific-or-silent filter (#170)', () => {
    it('keeps a specific technique annotation, trimmed', () => {
        expect(
            filterSpecificOrSilent('  Provides the full type signature up front, so the model does not guess the interface.  '),
        ).toBe('Provides the full type signature up front, so the model does not guess the interface.');
    });

    it('is silent on the NONE sentinel in its various forms', () => {
        expect(filterSpecificOrSilent('NONE')).toBeNull();
        expect(filterSpecificOrSilent('None.')).toBeNull();
        expect(filterSpecificOrSilent('  none — nothing specific here  ')).toBeNull();
    });

    it('is silent on empty / whitespace / non-string output', () => {
        expect(filterSpecificOrSilent('')).toBeNull();
        expect(filterSpecificOrSilent('   \n  ')).toBeNull();
        expect(filterSpecificOrSilent(undefined as unknown as string)).toBeNull();
    });

    it('SUPPRESSES generic praise (the core rule) rather than emitting it', () => {
        for (const praise of [
            'Great prompt!',
            'Clear and effective.',
            'Well done.',
            'Nice work, very clear and concise.',
            'Good prompt engineering.',
            'A really thoughtful and effective example.',
        ]) {
            expect(filterSpecificOrSilent(praise)).toBeNull();
        }
    });

    it('SUPPRESSES praise built from adjectives outside any fixed allowlist', () => {
        // The universal substantive-token floor must catch these even though they use
        // praise words a hand-written allowlist would likely miss (SEC-1).
        for (const praise of [
            'Perfect prompt.',
            'Smart approach.',
            'Brilliant prompting.',
            'Beautiful question.',
            'Elegant and clever.',
            'Superb, outstanding work!',
        ]) {
            expect(filterSpecificOrSilent(praise)).toBeNull();
        }
    });

    it('keeps a specific note that merely opens with the word "None"', () => {
        // Only the exact NONE sentinel is silent — a specific sentence that happens to
        // start with "None of..." is kept (SEC-3).
        const specific = 'None of the usual tricks — pastes the failing assertion first to anchor the model.';
        expect(filterSpecificOrSilent(specific)).toBe(specific);
    });

    it('keeps SPECIFIC content even when it opens with a praise word', () => {
        const specific =
            'Great use of pasting the failing test first, anchoring the model to the exact expected behavior before any code.';
        expect(filterSpecificOrSilent(specific)).toBe(specific);
    });

    it('caps a pathologically long annotation to one secondary footnote', () => {
        const long = `Anchors with an explicit interface ${'and many concrete details '.repeat(40)}`.trim();
        const out = filterSpecificOrSilent(long);
        expect(out).not.toBeNull();
        expect(out!.length).toBeLessThanOrEqual(401); // 400 + the ellipsis char
        expect(out!.endsWith('…')).toBe(true);
    });

    it('builds a prompt that demands the sentinel and forbids generic praise', () => {
        const prompt = buildAnnotationPrompt(CONVERSATION);
        expect(prompt).toContain(SILENT_SENTINEL);
        expect(prompt).toContain(CONVERSATION);
        expect(prompt.toLowerCase()).toContain('generic praise');
    });
});

describe('showcase AI annotation — local-by-default model (#170)', () => {
    it('resolves to a LOCAL ollama model by default (nothing leaves the network)', () => {
        const model = resolveAnnotationModel();
        expect(model.type).toBe('ollama');
        expect(model.endpoint).toBe('http://localhost:11434');
        expect(model.model_name).toBe('llama3.1:8b');
    });

    it('honors an override but reuses the canonical endpoint validation', () => {
        const overridden = resolveAnnotationModel({type: 'ollama', endpoint: 'http://my-gpu-box:11434'});
        expect(overridden.endpoint).toBe('http://my-gpu-box:11434');
        // A non-http scheme is rejected by the reused resolver, not silently accepted.
        expect(() => resolveAnnotationModel({endpoint: 'ftp://nope'})).toThrow();
    });

    it('the default client posts to localhost only', async () => {
        const recorder: {url?: string} = {};
        const client = createAnnotationClient(undefined, {fetchImpl: ollamaFetch('NONE', recorder)});
        await generateAnnotation(client, CONVERSATION);
        expect(recorder.url).toContain('http://localhost:11434');
    });
});

describe('showcase AI annotation — generate over the real client (#170)', () => {
    it('returns a specific annotation when the model names a concrete technique', async () => {
        const client = createAnnotationClient(undefined, {
            fetchImpl: ollamaFetch('Pins the exact error output first, so the model debugs the real failure not a guess.'),
        });
        const outcome = await generateAnnotation(client, CONVERSATION);
        expect(outcome).toEqual({
            status: 'specific',
            annotation: 'Pins the exact error output first, so the model debugs the real failure not a guess.',
        });
    });

    it('is silent when the model emits the sentinel', async () => {
        const client = createAnnotationClient(undefined, {fetchImpl: ollamaFetch('NONE')});
        expect(await generateAnnotation(client, CONVERSATION)).toEqual({status: 'silent'});
    });

    it('is silent when the model emits generic praise', async () => {
        const client = createAnnotationClient(undefined, {fetchImpl: ollamaFetch('Great prompt, very clear and effective!')});
        expect(await generateAnnotation(client, CONVERSATION)).toEqual({status: 'silent'});
    });

    it('maps an operational model failure to a retryable failure (never throws)', async () => {
        const client = createAnnotationClient(undefined, {fetchImpl: failingFetch()});
        const outcome = await generateAnnotation(client, CONVERSATION);
        expect(outcome.status).toBe('failed');
        if (outcome.status === 'failed') {
            expect(outcome.retryable).toBe(true);
        }
    });
});

describe('showcase AI annotation — annotate service: gate + store (#170)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seedTeam(db, 'eng');
        seedDeveloper(db, DEV, 'eng');
    });

    afterEach(() => {
        db.close();
    });

    it('is DISABLED by default — the model is never called and nothing is stored', async () => {
        const id = draftUnit(db, {team: 'eng'});
        const {client, calls} = stubClient({ok: true, text: 'Pins the failing test first.', model: 'm'});
        const outcome = await annotateShowcaseUnit(db, {contributionId: id, client});
        expect(outcome).toEqual({status: 'disabled'});
        expect(calls()).toBe(0); // gate short-circuits before any generation
        expect(getShowcaseUnit(db, id)?.aiAnnotation).toBeNull();
    });

    it('stores a SPECIFIC annotation once enabled', async () => {
        setGlobalSetting(db, 'showcase_ai_annotation_enabled', true);
        const id = draftUnit(db, {team: 'eng'});
        const {client} = stubClient({
            ok: true,
            text: 'Provides the type signature up front, so the model does not guess the interface.',
            model: 'm',
        });
        const outcome = await annotateShowcaseUnit(db, {contributionId: id, client});
        expect(outcome.status).toBe('specific');
        expect(getShowcaseUnit(db, id)?.aiAnnotation).toBe(
            'Provides the type signature up front, so the model does not guess the interface.',
        );
    });

    it('stores NOTHING on a silent generation (no generic praise lands in the column)', async () => {
        setGlobalSetting(db, 'showcase_ai_annotation_enabled', true);
        const id = draftUnit(db, {team: 'eng'});
        const {client} = stubClient({ok: true, text: 'Great work, clear and effective!', model: 'm'});
        const outcome = await annotateShowcaseUnit(db, {contributionId: id, client});
        expect(outcome).toEqual({status: 'silent'});
        expect(getShowcaseUnit(db, id)?.aiAnnotation).toBeNull();
    });

    it('a later silent generation does NOT clobber a prior specific annotation', async () => {
        setGlobalSetting(db, 'showcase_ai_annotation_enabled', true);
        const id = draftUnit(db, {team: 'eng'});
        const first = stubClient({ok: true, text: 'Anchors with the exact failing assertion.', model: 'm'});
        await annotateShowcaseUnit(db, {contributionId: id, client: first.client});
        const second = stubClient({ok: true, text: 'NONE', model: 'm'});
        const outcome = await annotateShowcaseUnit(db, {contributionId: id, client: second.client});
        expect(outcome).toEqual({status: 'silent'});
        expect(getShowcaseUnit(db, id)?.aiAnnotation).toBe('Anchors with the exact failing assertion.');
    });

    it('returns failed and stores nothing when the model is unreachable', async () => {
        setGlobalSetting(db, 'showcase_ai_annotation_enabled', true);
        const id = draftUnit(db, {team: 'eng'});
        const client = createAnnotationClient(undefined, {fetchImpl: failingFetch()});
        const outcome = await annotateShowcaseUnit(db, {contributionId: id, client});
        expect(outcome.status).toBe('failed');
        expect(getShowcaseUnit(db, id)?.aiAnnotation).toBeNull();
    });

    it('returns not_found for an id that is not a showcase', async () => {
        const {client, calls} = stubClient({ok: true, text: 'whatever', model: 'm'});
        const outcome = await annotateShowcaseUnit(db, {contributionId: 'ghost', client});
        expect(outcome).toEqual({status: 'not_found'});
        expect(calls()).toBe(0);
    });

    it('honors a per-team enable override (gate resolved for the showcase team)', async () => {
        // Org default stays OFF; enable only for team 'eng' via an admin-permitted override.
        setGlobalSetting(db, 'coaching_managers_can_override', true);
        setTeamSetting(db, 'eng', 'showcase_ai_annotation_enabled', true);
        expect(isAiAnnotationEnabledForTeam(db, 'eng')).toBe(true);
        expect(isAiAnnotationEnabledForTeam(db, null)).toBe(false);

        const id = draftUnit(db, {team: 'eng', scope: 'team'});
        const {client} = stubClient({ok: true, text: 'Splits the task into a numbered plan first.', model: 'm'});
        const outcome = await annotateShowcaseUnit(db, {contributionId: id, client});
        expect(outcome.status).toBe('specific');
        expect(getShowcaseUnit(db, id)?.aiAnnotation).toBe('Splits the task into a numbered plan first.');
    });
});

describe('showcase AI annotation — rendering as clearly-AI + secondary (#170)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db, MIGRATIONS_DIR);
        seedTeam(db, 'eng');
        seedDeveloper(db, DEV, 'eng');
    });

    afterEach(() => {
        db.close();
    });

    it('renders a present annotation as AI-attributed and secondary', () => {
        const rendered = renderAiAnnotation('  Pins the failing test first.  ');
        expect(rendered).toEqual({
            present: true,
            source: 'ai_generated',
            prominence: 'secondary',
            label: AI_ANNOTATION_LABEL,
            text: 'Pins the failing test first.',
        });
    });

    it('renders an absent/blank annotation as not-present with null text', () => {
        for (const blank of [null, undefined, '', '   ']) {
            const rendered = renderAiAnnotation(blank as string | null);
            expect(rendered.present).toBe(false);
            expect(rendered.text).toBeNull();
            // Even when absent it is unambiguously flagged AI + secondary.
            expect(rendered.source).toBe('ai_generated');
            expect(rendered.prominence).toBe('secondary');
        }
    });

    it('the curated unit view surfaces the annotation as a clearly-AI secondary footnote', async () => {
        setGlobalSetting(db, 'showcase_ai_annotation_enabled', true);
        const id = draftUnit(db, {team: 'eng'});
        const {client} = stubClient({ok: true, text: 'Asks for three approaches before committing to one.', model: 'm'});
        await annotateShowcaseUnit(db, {contributionId: id, client});

        const view = assembleCuratedUnit(db, id);
        expect(view).toBeDefined();
        // The human voice is still the prominent header...
        expect(view!.curatorsNote).toBe('shows type-signature-first prompting');
        // ...and the AI note is present, attributed to AI, and marked secondary.
        expect(view!.aiAnnotation).toEqual({
            present: true,
            source: 'ai_generated',
            prominence: 'secondary',
            label: AI_ANNOTATION_LABEL,
            text: 'Asks for three approaches before committing to one.',
        });
    });

    it('the curated unit view shows no AI footnote when none was generated', async () => {
        const id = draftUnit(db, {team: 'eng'});
        const view = assembleCuratedUnit(db, id);
        expect(view!.aiAnnotation.present).toBe(false);
        expect(view!.aiAnnotation.text).toBeNull();
    });
});
