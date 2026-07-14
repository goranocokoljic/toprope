// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Route, Routes} from 'react-router-dom';
import {Showcase} from '../pages/Showcase';
import {ShowcaseDetail} from '../pages/ShowcaseDetail';
import type {BrowseShowcaseDetail, BrowseShowcaseSummary, ShowcaseRemovalNotice} from '../api/types';

function summary(over: Partial<BrowseShowcaseSummary> = {}): BrowseShowcaseSummary {
    return {
        id: 's1',
        title: 'Refactor with tests',
        scope: 'org',
        scopeTarget: null,
        authorId: 'alice',
        authorName: 'Alice Dev',
        publishPath: 'self_publish',
        hasOutcomeLink: true,
        annotationCount: 2,
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
        ...over,
    };
}

function detail(over: Partial<BrowseShowcaseDetail> = {}): BrowseShowcaseDetail {
    return {
        id: 's1',
        title: 'Refactor with tests',
        scope: 'org',
        scopeTarget: null,
        state: 'published',
        authorId: 'alice',
        authorName: 'Alice Dev',
        publishPath: 'self_publish',
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
        curatorsNote: 'Drive the refactor from a failing test.',
        outcomeLink: 'https://example/pr/9',
        hasOutcomeLink: true,
        display: {
            turns: [
                {
                    turnRef: 't0',
                    turn: {id: 't0', role: 'user', text: 'how do I refactor'},
                    annotations: [],
                },
                {
                    turnRef: 't1',
                    turn: {id: 't1', role: 'assistant', text: 'write a test first'},
                    annotations: [
                        {
                            id: 'a1',
                            contributionId: 's1',
                            turnRef: 't1',
                            authorId: 'alice',
                            body: 'notice the test-first move',
                            createdAt: '2026-06-20T00:00:00.000Z',
                        },
                    ],
                },
            ],
            orphaned: [],
        },
        aiAnnotation: {
            present: false,
            source: 'ai_generated',
            prominence: 'secondary',
            label: 'AI suggestion',
            text: null,
        },
        practices: [{id: 'p1', title: 'Test-first development'}],
        canUnpublish: false,
        ...over,
    };
}

// --- Mock state, configured per test ---------------------------------------
let listShowcases: BrowseShowcaseSummary[];
let detailData: BrowseShowcaseDetail;
let removals: ShowcaseRemovalNotice[];
let browseUrls: string[];
let unpublishPosts: string[];
let fetchMock: Mock;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
}

beforeEach(() => {
    listShowcases = [summary()];
    detailData = detail();
    removals = [];
    browseUrls = [];
    unpublishPosts = [];

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();

        if (u.includes('/api/me/showcase-units/removals') && method === 'GET') {
            return jsonResponse({data: removals});
        }
        const unpublishMatch = u.match(/\/api\/me\/showcase-units\/([^/]+)\/unpublish/);
        if (unpublishMatch && method === 'POST') {
            unpublishPosts.push(decodeURIComponent(unpublishMatch[1]));
            return jsonResponse({data: {state: 'unpublished'}});
        }
        if (u.includes('/api/me/showcase-units/browse') && method === 'GET') {
            browseUrls.push(u);
            return jsonResponse({data: {showcases: listShowcases}});
        }
        const detailMatch = u.match(/\/api\/me\/showcase-units\/([^/?]+)(\?|$)/);
        if (detailMatch && method === 'GET' && detailMatch[1] !== '' && detailMatch[1] !== 'browse') {
            return jsonResponse({data: detailData});
        }
        return jsonResponse({error: 'unexpected', url: u}, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderAt(path: string): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/developer/showcase" element={<Showcase />} />
                    <Route path="/developer/showcase/:id" element={<ShowcaseDetail />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('Showcase gallery (Task 6.3.9 / #172)', () => {
    it('lists showcases with provenance and annotation heft', async () => {
        renderAt('/developer/showcase');
        expect(await screen.findByText('Refactor with tests')).toBeInTheDocument();
        expect(screen.getByText('Self-published')).toBeInTheDocument();
        expect(screen.getByText(/2 annotations/)).toBeInTheDocument();
        expect(screen.getByText(/Has outcome/)).toBeInTheDocument();
    });

    it('submitting a search refetches with the q query', async () => {
        renderAt('/developer/showcase');
        await screen.findByText('Refactor with tests');
        fireEvent.change(screen.getByPlaceholderText('Search by title'), {target: {value: 'churn'}});
        fireEvent.click(screen.getByRole('button', {name: 'Search'}));
        await waitFor(() => expect(browseUrls.some((u) => u.includes('q=churn'))).toBe(true));
    });

    it('renders an empty state when no showcases match', async () => {
        listShowcases = [];
        renderAt('/developer/showcase');
        expect(await screen.findByText('No showcases yet')).toBeInTheDocument();
    });

    it('paginates the gallery at 12 cards per page and navigates pages', async () => {
        listShowcases = Array.from({length: 15}, (_, i) =>
            summary({id: `s${i}`, title: `Showcase ${String(i).padStart(2, '0')}`}),
        );
        renderAt('/developer/showcase');
        await screen.findByText('Showcase 00');

        const list = screen.getByTestId('showcase-list');
        expect(list.querySelectorAll('li')).toHaveLength(12);
        expect(screen.queryByText('Showcase 12')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', {name: 'Next page'}));
        expect(screen.getByTestId('showcase-list').querySelectorAll('li')).toHaveLength(3);
        expect(screen.getByText('Showcase 12')).toBeInTheDocument();
        expect(screen.queryByText('Showcase 00')).not.toBeInTheDocument();
    });

    it('surfaces the author’s removal notices when present (author is notified)', async () => {
        removals = [
            {showcaseId: 's9', title: 'An old session', removedBy: 'lead', reason: 'off-topic', occurredAt: '2026-06-25T00:00:00.000Z'},
        ];
        renderAt('/developer/showcase');
        const panel = await screen.findByTestId('showcase-removals');
        expect(panel.textContent).toMatch(/An old session/);
        expect(panel.textContent).toMatch(/off-topic/);
    });

    it('falls back to “Unknown author” when the author record is gone', async () => {
        listShowcases = [summary({authorName: null})];
        renderAt('/developer/showcase');
        expect(await screen.findByText('Unknown author')).toBeInTheDocument();
    });
});

describe('Showcase detail (Task 6.3.9 / #172)', () => {
    it('renders all unit components: note, outcome, annotated turns, cross-links', async () => {
        renderAt('/developer/showcase/s1');
        expect(await screen.findByTestId('curators-note')).toHaveTextContent('failing test');
        expect(screen.getByTestId('outcome-link')).toHaveAttribute('href', 'https://example/pr/9');
        // The conversation renders, with the inline annotation beside its turn.
        expect(screen.getByTestId('conversation')).toBeInTheDocument();
        expect(screen.getByText('write a test first')).toBeInTheDocument();
        expect(screen.getByText('notice the test-first move')).toBeInTheDocument();
        // The cross-linked practice surfaces.
        expect(screen.getByText('Test-first development')).toBeInTheDocument();
    });

    it('neutralizes a non-http(s) outcome link, rendering it as plain text (no clickable href)', async () => {
        // Defense-in-depth (#189, SEC-1): even if a dangerous scheme reaches the client,
        // the renderer must not emit a clickable link. It shows the value as plain text.
        // eslint-disable-next-line no-script-url
        detailData = detail({outcomeLink: 'javascript:alert(1)', hasOutcomeLink: true});
        renderAt('/developer/showcase/s1');
        const plain = await screen.findByTestId('outcome-link-unsafe');
        expect(plain).toHaveTextContent('javascript:alert(1)');
        // No anchor was rendered for the unsafe link.
        expect(screen.queryByTestId('outcome-link')).not.toBeInTheDocument();
    });

    it('renders a safe http(s) outcome link as a clickable anchor', async () => {
        detailData = detail({outcomeLink: 'https://example.com/pr/9', hasOutcomeLink: true});
        renderAt('/developer/showcase/s1');
        const link = await screen.findByTestId('outcome-link');
        expect(link).toHaveAttribute('href', 'https://example.com/pr/9');
        expect(screen.queryByTestId('outcome-link-unsafe')).not.toBeInTheDocument();
    });

    it('shows the AI annotation only when present and clearly labels it', async () => {
        detailData = detail({
            aiAnnotation: {
                present: true,
                source: 'ai_generated',
                prominence: 'secondary',
                label: 'AI suggestion',
                text: 'Used few-shot examples to anchor the format.',
            },
        });
        renderAt('/developer/showcase/s1');
        const ai = await screen.findByTestId('ai-annotation');
        expect(ai.textContent).toMatch(/AI suggestion/);
        expect(ai.textContent).toMatch(/few-shot/);
    });

    it('hides the AI annotation slot entirely when absent', async () => {
        renderAt('/developer/showcase/s1');
        await screen.findByTestId('curators-note');
        expect(screen.queryByTestId('ai-annotation')).not.toBeInTheDocument();
    });

    it('shows the unpublish control only to the author and posts on click', async () => {
        detailData = detail({canUnpublish: true});
        renderAt('/developer/showcase/s1');
        const button = await screen.findByRole('button', {name: 'Unpublish'});
        fireEvent.click(button);
        await waitFor(() => expect(unpublishPosts).toEqual(['s1']));
    });

    it('hides the unpublish control from a non-author', async () => {
        renderAt('/developer/showcase/s1');
        await screen.findByTestId('curators-note');
        expect(screen.queryByTestId('unpublish-control')).not.toBeInTheDocument();
    });

    it('renders a not-found state on a 404', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({error: 'Not Found'}, 404));
        renderAt('/developer/showcase/missing');
        expect(await screen.findByText('Showcase not found')).toBeInTheDocument();
    });
});
