import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import type Database from 'better-sqlite3';
import {makeTestDb} from '../dashboard/fixtures';
import {
    createContribution,
    addContributionTag,
    getContribution,
    getContributionTags,
    updateContributionState,
} from '../../src/contributions/store';
import {getVersionHistory} from '../../src/contributions/versioning';
import {getPracticeDetails} from '../../src/practices/store';
import {
    AuthoringError,
    createPractice,
    decodeContent,
    extractMetricRefs,
    getPracticeView,
    renderPractice,
    revertPractice,
    savePractice,
} from '../../src/practices/authoring';

const T1 = '2026-06-20T00:00:00.000Z';
const T2 = '2026-06-21T00:00:00.000Z';
const T3 = '2026-06-22T00:00:00.000Z';

function seedDeveloper(db: Database.Database, id: string, team: string): void {
    db.prepare('INSERT INTO developers (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        `${id} Dev`,
        `${id}@test.com`,
        team,
        T1,
    );
}

describe('best-practice rich authoring (Task 6.2.3)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        db.prepare('INSERT INTO teams (name, department, manager, created_at) VALUES (?, NULL, NULL, ?)').run('eng', T1);
        seedDeveloper(db, 'alice', 'eng');
        seedDeveloper(db, 'bob', 'eng');
    });

    afterEach(() => {
        db.close();
    });

    // --- AC: faithful render with code blocks -------------------------------
    describe('renderPractice — render fidelity', () => {
        it('renders headings, emphasis, lists and links faithfully', () => {
            const {html} = renderPractice('# Title\n\nUse **bold** and *italic* with a [link](https://example.com).\n\n- one\n- two');
            expect(html).toContain('<h1>Title</h1>');
            expect(html).toContain('<strong>bold</strong>');
            expect(html).toContain('<em>italic</em>');
            expect(html).toContain('<a href="https://example.com">link</a>');
            expect(html).toContain('<li>one</li>');
            expect(html).toContain('<li>two</li>');
        });

        it('preserves a fenced code block verbatim (critical for prompt/code examples)', () => {
            const {html} = renderPractice('```js\nconst x = 1 < 2 && 3 > 2;\n```');
            expect(html).toContain('<pre><code');
            // The code content is HTML-escaped but otherwise verbatim — not interpreted.
            expect(html).toContain('const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;');
        });
    });

    // --- AC: renders safely (no script injection) ---------------------------
    describe('renderPractice — sanitization', () => {
        it('strips a <script> tag and leaves no executable residue', () => {
            const {html} = renderPractice('Hello\n\n<script>alert(1)</script>\n\nWorld');
            expect(html).not.toContain('<script');
            expect(html).not.toContain('alert(1)');
            expect(html).toContain('Hello');
            expect(html).toContain('World');
        });

        it('drops a javascript: link href but keeps the link text harmless', () => {
            const {html} = renderPractice('[click](javascript:alert(1))');
            expect(html).not.toContain('javascript:');
            expect(html).not.toContain('alert(1)');
            // the anchor survives WITHOUT a dangerous href — not merely the substring gone
            expect(html).toContain('click');
            expect(html).not.toMatch(/href="javascript/i);
        });

        it('drops a data: URL scheme on a link', () => {
            const {html} = renderPractice('[x](data:text/html;base64,PHNjcmlwdD4=)');
            expect(html).not.toContain('data:text/html');
            expect(html).not.toMatch(/href="data:/i);
        });

        it('strips inline event-handler attributes from raw HTML', () => {
            const {html} = renderPractice('<img src="x" onerror="alert(1)">');
            expect(html).not.toContain('onerror');
            expect(html).not.toContain('alert(1)');
        });

        it('drops a disallowed iframe entirely', () => {
            const {html} = renderPractice('<iframe src="https://evil.test"></iframe>');
            expect(html).not.toContain('<iframe');
            expect(html).not.toContain('evil.test');
        });
    });

    // --- AC: metric references produce the matching tag ---------------------
    describe('metric references', () => {
        it('renders a recognised metric as a chip carrying data-metric', () => {
            const {html, metrics} = renderPractice('Watch your {{churn}}.');
            expect(html).toContain('<span class="metric-ref" data-metric="churn">churn</span>');
            expect(metrics).toEqual(['churn']);
        });

        it('extracts distinct, sorted metrics from prose', () => {
            expect(extractMetricRefs('{{cost_per_pr}} then {{acceptance_rate}} then {{churn}} and {{churn}} again'))
                .toEqual(['acceptance_rate', 'churn', 'cost_per_pr']);
        });

        it('leaves an unrecognised reference literal and does not tag it', () => {
            const {html, metrics} = renderPractice('See {{not_a_metric}} here.');
            expect(html).toContain('{{not_a_metric}}');
            expect(html).not.toContain('data-metric');
            expect(metrics).toEqual([]);
        });

        it('does NOT treat a reference inside a fenced code block as a metric', () => {
            const {html, metrics} = renderPractice('```\nexample: {{churn}}\n```');
            expect(metrics).toEqual([]);
            expect(html).not.toContain('data-metric');
            expect(html).toContain('{{churn}}');
        });

        it('does NOT treat a reference inside an inline code span as a metric', () => {
            const {metrics} = renderPractice('the token `{{churn}}` is literal');
            expect(metrics).toEqual([]);
        });

        it('does NOT mint a tag from a hand-written raw-HTML data-metric outside the vocabulary', () => {
            // marked passes raw HTML through; tags come from the token stream, not the
            // HTML, so a forged attribute cannot create an arbitrary tag.
            const {metrics} = renderPractice('Legit {{churn}} plus <span data-metric="totally_made_up">x</span>');
            expect(metrics).toEqual(['churn']); // only the real, prose-referenced metric
            expect(metrics).not.toContain('totally_made_up');
        });

        it('does NOT mint a tag from a raw-HTML data-metric even for a VALID metric with no prose reference', () => {
            // A valid-vocabulary name written only as raw HTML (never as {{churn}}) must
            // not become a tag — tags follow the metricRef token, not any data-metric.
            const {metrics} = renderPractice('No reference here, only raw <span data-metric="churn">x</span> and <code data-metric="acceptance_rate">y</code>.');
            expect(metrics).toEqual([]);
        });
    });

    // --- AC: saving creates a version (6.1.3) -------------------------------
    describe('createPractice', () => {
        it('creates a best_practice at version 1 with the markdown body and metric tags', () => {
            const {contribution, metrics} = createPractice(db, {
                title: 'Reduce churn',
                authorId: 'alice',
                scope: 'team',
                scopeTarget: 'eng',
                markdown: 'Keep an eye on {{churn}} and {{acceptance_rate}}.',
                timestamp: T1,
            });
            expect(contribution.contentType).toBe('best_practice');
            expect(contribution.currentVersion).toBe(1);
            expect(contribution.state).toBe('draft');
            const history = getVersionHistory(db, contribution.id);
            expect(history).toHaveLength(1);
            expect(decodeContent(history[0].body).markdown).toBe('Keep an eye on {{churn}} and {{acceptance_rate}}.');
            expect(metrics).toEqual(['acceptance_rate', 'churn']);
            expect(getContributionTags(db, contribution.id)).toEqual(['acceptance_rate', 'churn']);
        });

        it('persists model_used to practice_details when provided', () => {
            const {contribution} = createPractice(db, {
                title: 'AI-assisted practice',
                authorId: 'alice',
                scope: 'org',
                markdown: 'body',
                modelUsed: 'claude-opus-4-8',
            });
            expect(getPracticeDetails(db, contribution.id)?.modelUsed).toBe('claude-opus-4-8');
        });

        it('writes no details row when model_used is omitted', () => {
            const {contribution} = createPractice(db, {
                title: 'Manual practice',
                authorId: 'alice',
                scope: 'org',
                markdown: 'body',
            });
            expect(getPracticeDetails(db, contribution.id)).toBeUndefined();
        });

        it('rejects an empty title', () => {
            expect(() =>
                createPractice(db, {title: '   ', authorId: 'alice', scope: 'org', markdown: 'body'}),
            ).toThrow(AuthoringError);
        });

        it('rejects an empty (whitespace-only) markdown body', () => {
            try {
                createPractice(db, {title: 'T', authorId: 'alice', scope: 'org', markdown: '   \n  '});
                expect.unreachable('should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(AuthoringError);
                expect((err as AuthoringError).code).toBe('empty_markdown');
            }
        });
    });

    // --- AC: saving creates a version --------------------------------------
    describe('savePractice', () => {
        function makePractice(markdown: string): string {
            return createPractice(db, {
                title: 'Practice',
                authorId: 'alice',
                scope: 'team',
                scopeTarget: 'eng',
                markdown,
                timestamp: T1,
            }).contribution.id;
        }

        it('appends a new version and advances current_version (history preserved)', () => {
            const id = makePractice('v1 body about {{churn}}');
            const {version} = savePractice(db, id, {actorId: 'alice', markdown: 'v2 body', changeNote: 'edit', timestamp: T2});
            expect(version.version).toBe(2);
            expect(version.changeNote).toBe('edit');
            expect(getContribution(db, id)!.currentVersion).toBe(2);
            // version 1 is still there, untouched
            const history = getVersionHistory(db, id);
            expect(history).toHaveLength(2);
            expect(decodeContent(history[0].body).markdown).toBe('v1 body about {{churn}}');
        });

        it('adds newly referenced metric tags and removes ones no longer referenced', () => {
            const id = makePractice('start with {{churn}} and {{cost_per_pr}}');
            expect(getContributionTags(db, id)).toEqual(['churn', 'cost_per_pr']);
            savePractice(db, id, {actorId: 'alice', markdown: 'now only {{acceptance_rate}}', timestamp: T2});
            expect(getContributionTags(db, id)).toEqual(['acceptance_rate']);
        });

        it('does not persist a tag forged via raw-HTML data-metric', () => {
            const id = makePractice('Real {{churn}} and forged <span data-metric="evil_tag">x</span>');
            expect(getContributionTags(db, id)).toEqual(['churn']);
            // and a later save can still cleanly drop the real metric (no stuck junk)
            savePractice(db, id, {actorId: 'alice', markdown: 'no metrics now', timestamp: T2});
            expect(getContributionTags(db, id)).toEqual([]);
        });

        it('preserves a non-metric (free-form) tag while reconciling metric tags', () => {
            const id = makePractice('about {{churn}}');
            addContributionTag(db, id, 'onboarding'); // a manual, non-metric tag
            savePractice(db, id, {actorId: 'alice', markdown: 'about {{cost_per_pr}}', timestamp: T2});
            const tags = getContributionTags(db, id);
            expect(tags).toContain('onboarding'); // untouched
            expect(tags).toContain('cost_per_pr'); // added
            expect(tags).not.toContain('churn'); // removed
        });

        it('rejects an empty markdown body', () => {
            const id = makePractice('body');
            expect(() => savePractice(db, id, {actorId: 'alice', markdown: ''})).toThrow(AuthoringError);
        });

        it('throws not_a_practice when the contribution is a different content type', () => {
            const showcase = createContribution(db, {
                contentType: 'showcase_example',
                title: 'Not a practice',
                authorId: 'alice',
                scope: 'org',
                body: JSON.stringify({markdown: 'x'}),
                timestamp: T1,
            });
            try {
                savePractice(db, showcase.id, {actorId: 'alice', markdown: 'edit'});
                expect.unreachable('should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(AuthoringError);
                expect((err as AuthoringError).code).toBe('not_a_practice');
            }
        });
    });

    // --- revert -------------------------------------------------------------
    describe('revertPractice', () => {
        it('recreates a prior body as a new version and re-syncs tags to it', () => {
            const id = createPractice(db, {
                title: 'Practice',
                authorId: 'alice',
                scope: 'org',
                markdown: 'v1 about {{churn}}',
                timestamp: T1,
            }).contribution.id;
            savePractice(db, id, {actorId: 'alice', markdown: 'v2 about {{acceptance_rate}}', timestamp: T2});
            expect(getContributionTags(db, id)).toEqual(['acceptance_rate']);

            const {version, metrics} = revertPractice(db, id, 1, {actorId: 'bob', timestamp: T3});
            expect(version.version).toBe(3); // new version, not a rewrite of v1
            expect(decodeContent(version.body).markdown).toBe('v1 about {{churn}}');
            expect(metrics).toEqual(['churn']);
            // tags now follow the reverted (current) content
            expect(getContributionTags(db, id)).toEqual(['churn']);
            // full history retained
            expect(getVersionHistory(db, id)).toHaveLength(3);
        });
    });

    // --- getPracticeView ----------------------------------------------------
    describe('getPracticeView', () => {
        it('returns the current markdown, a rendered preview and metrics', () => {
            const id = createPractice(db, {
                title: 'Visible',
                authorId: 'alice',
                scope: 'org',
                markdown: '# Heading\n\nWatch {{churn}}.',
                timestamp: T1,
            }).contribution.id;
            const view = getPracticeView(db, id);
            expect(view).toBeDefined();
            expect(view!.title).toBe('Visible');
            expect(view!.currentVersion).toBe(1);
            expect(view!.markdown).toBe('# Heading\n\nWatch {{churn}}.');
            expect(view!.html).toContain('<h1>Heading</h1>');
            expect(view!.html).toContain('data-metric="churn"');
            expect(view!.metrics).toEqual(['churn']);
        });

        it('round-trips markdown with quotes and backslashes through the version body', () => {
            const tricky = 'He said "x" and used a \\ backslash and a `{{churn}}` literal';
            const id = createPractice(db, {title: 'T', authorId: 'alice', scope: 'org', markdown: tricky, timestamp: T1})
                .contribution.id;
            expect(getPracticeView(db, id)!.markdown).toBe(tricky);
            // and after a save the new body round-trips too
            savePractice(db, id, {actorId: 'alice', markdown: tricky + ' edited', timestamp: T2});
            expect(getPracticeView(db, id)!.markdown).toBe(tricky + ' edited');
        });

        it('reflects the latest version after a save', () => {
            const id = createPractice(db, {title: 'T', authorId: 'alice', scope: 'org', markdown: 'first', timestamp: T1})
                .contribution.id;
            savePractice(db, id, {actorId: 'alice', markdown: 'second', timestamp: T2});
            expect(getPracticeView(db, id)!.markdown).toBe('second');
        });

        it('returns undefined for an unknown id and for a non-practice contribution', () => {
            expect(getPracticeView(db, 'nope')).toBeUndefined();
            const showcase = createContribution(db, {
                contentType: 'showcase_example',
                title: 'x',
                authorId: 'alice',
                scope: 'org',
                body: JSON.stringify({markdown: 'x'}),
                timestamp: T1,
            });
            expect(() => getPracticeView(db, showcase.id)).toThrow(AuthoringError);
        });
    });

    // --- decodeContent leniency --------------------------------------------
    describe('decodeContent', () => {
        it('decodes our JSON shape', () => {
            expect(decodeContent(JSON.stringify({markdown: 'hello'}))).toEqual({markdown: 'hello'});
        });

        it('treats a non-JSON body as raw markdown rather than throwing', () => {
            expect(decodeContent('just text')).toEqual({markdown: 'just text'});
        });

        it('treats a JSON object without a string markdown field as raw markdown', () => {
            expect(decodeContent('{"x":1}')).toEqual({markdown: '{"x":1}'});
        });
    });

    // --- removed contribution refuses a save (spine guard surfaces) ---------
    it('a removed practice refuses further saves via the versioning guard', () => {
        const id = createPractice(db, {title: 'T', authorId: 'alice', scope: 'org', markdown: 'body', timestamp: T1})
            .contribution.id;
        updateContributionState(db, id, 'removed', T2);
        expect(() => savePractice(db, id, {actorId: 'alice', markdown: 'edit'})).toThrow();
    });
});
