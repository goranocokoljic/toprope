// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Route, Routes} from 'react-router-dom';
import {BestPractices} from '../pages/BestPractices';
import {BestPracticeDetail} from '../pages/BestPracticeDetail';
import {BestPracticeEditor} from '../pages/BestPracticeEditor';
import type {
    BrowsePracticeDetail,
    BrowsePracticeSummary,
    ContributionModel,
    PracticeHistoryEntry,
    ShowcaseCrossLink,
} from '../api/types';

function summary(over: Partial<BrowsePracticeSummary> = {}): BrowsePracticeSummary {
    return {
        id: 'p1',
        title: 'Review AI suggestions',
        scope: 'org',
        scopeTarget: null,
        authorId: 'alice',
        authorName: 'Alice Dev',
        currentVersion: 1,
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
        metrics: ['churn'],
        endorsed: false,
        feedback: {helpful: 0, notHelpful: 0, helpfulRatio: null},
        ...over,
    };
}

function detail(over: Partial<BrowsePracticeDetail> = {}): BrowsePracticeDetail {
    return {
        id: 'p1',
        title: 'Review AI suggestions',
        scope: 'org',
        scopeTarget: null,
        state: 'published',
        authorId: 'alice',
        authorName: 'Alice Dev',
        currentVersion: 1,
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
        html: '<h1>Heading</h1><p>Body text</p>',
        metrics: ['churn'],
        feedback: {helpful: 0, notHelpful: 0, helpfulRatio: null, viewerSignal: null},
        endorsed: false,
        model: 'top_down',
        canEdit: false,
        showcases: [],
        ...over,
    };
}

// --- Mock state, configured per test ---------------------------------------
let listModel: ContributionModel;
let listPractices: BrowsePracticeSummary[];
let detailData: BrowsePracticeDetail;
let historyData: PracticeHistoryEntry[];
let browseUrls: string[];
let feedbackPosts: {id: string; signal: string}[];
let createPosts: {title: string; scope: string; markdown: string}[];
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
}

beforeEach(() => {
    listModel = 'top_down';
    listPractices = [summary()];
    detailData = detail();
    historyData = [
        {version: 1, authorId: 'alice', authorName: 'Alice Dev', changeNote: null, createdAt: '2026-06-20T00:00:00.000Z'},
        {version: 2, authorId: 'alice', authorName: 'Alice Dev', changeNote: 'tweak', createdAt: '2026-06-22T00:00:00.000Z'},
    ];
    browseUrls = [];
    feedbackPosts = [];
    createPosts = [];

    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();

        const feedbackMatch = u.match(/\/api\/me\/practices\/browse\/([^/]+)\/feedback/);
        if (feedbackMatch && method === 'POST') {
            const body = JSON.parse(String(init?.body ?? '{}')) as {signal: string};
            feedbackPosts.push({id: decodeURIComponent(feedbackMatch[1]), signal: body.signal});
            return json({data: {signal: body.signal, removed: false, feedback: {helpful: 1, notHelpful: 0, helpfulRatio: 1}}});
        }
        const historyMatch = u.match(/\/api\/me\/practices\/browse\/([^/]+)\/history/);
        if (historyMatch && method === 'GET') {
            return json({data: historyData});
        }
        const detailMatch = u.match(/\/api\/me\/practices\/browse\/([^/?]+)(\?|$)/);
        if (detailMatch && method === 'GET' && detailMatch[1] !== '') {
            return json({data: detailData});
        }
        if (u.includes('/api/me/practices/browse') && method === 'GET') {
            browseUrls.push(u);
            return json({data: {model: listModel, canContribute: true, practices: listPractices}});
        }
        if (u.endsWith('/api/me/practices/preview') && method === 'POST') {
            return json({data: {html: '<p>preview</p>', metrics: []}});
        }
        if (u.endsWith('/api/me/practices') && method === 'POST') {
            const body = JSON.parse(String(init?.body ?? '{}')) as {title: string; scope: string; markdown: string};
            createPosts.push(body);
            return json({data: {contribution: {id: 'new1', title: body.title, scope: body.scope, scopeTarget: null, state: 'draft'}, metrics: []}}, 201);
        }
        return json({error: 'unexpected', url: u}, 500);
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
                    <Route path="/developer/practices" element={<BestPractices />} />
                    <Route path="/developer/practices/new" element={<BestPracticeEditor />} />
                    <Route path="/developer/practices/:id" element={<BestPracticeDetail />} />
                    <Route path="/developer/practices/:id/edit" element={<BestPracticeEditor />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('Best-practice browse list (Task 6.2.8 / #163)', () => {
    it('lists practices with their metric tags and a model-aware contribute banner (AC1, AC3)', async () => {
        renderAt('/developer/practices');
        expect(await screen.findByText('Review AI suggestions')).toBeInTheDocument();
        expect(screen.getByText('churn')).toBeInTheDocument();
        // The contribute entry point explains the active contribution model.
        const banner = screen.getByTestId('contribute-banner');
        expect(banner.textContent).toMatch(/top-down/i);
        expect(banner.textContent).toMatch(/reviews and approves/i);
    });

    it('the contribute banner copy reflects a different model (AC3)', async () => {
        listModel = 'bottom_up';
        renderAt('/developer/practices');
        const banner = await screen.findByTestId('contribute-banner');
        expect(banner.textContent).toMatch(/bottom-up/i);
        expect(banner.textContent).toMatch(/publishes straight into the shared pool/i);
    });

    it('submitting a tag filter refetches with the tag query (AC1)', async () => {
        renderAt('/developer/practices');
        await screen.findByText('Review AI suggestions');
        const tagInput = screen.getByPlaceholderText('e.g. churn');
        fireEvent.change(tagInput, {target: {value: 'churn'}});
        fireEvent.click(screen.getByRole('button', {name: 'Search'}));
        await waitFor(() => expect(browseUrls.some((u) => u.includes('tag=churn'))).toBe(true));
    });

    it('renders an empty state when no practices match', async () => {
        listPractices = [];
        renderAt('/developer/practices');
        expect(await screen.findByText('No best practices yet')).toBeInTheDocument();
    });
});

describe('Best-practice detail (Task 6.2.8 / #163)', () => {
    it('renders the sanitized rich content with semantic theme tokens (AC2, dark mode)', async () => {
        renderAt('/developer/practices/p1');
        const content = await screen.findByTestId('practice-content');
        expect(content.innerHTML).toContain('<h1>Heading</h1>');
        expect(content.className).toMatch(/text-foreground/);
        // No raw colors that would break dark mode.
        expect(content.className).not.toMatch(/bg-gray|text-black|#[0-9a-fA-F]{3,}/);
    });

    it('records a helpful vote when the affordance is pressed (AC2, 6.2.4)', async () => {
        renderAt('/developer/practices/p1');
        const helpful = await screen.findByRole('button', {name: /^helpful/i});
        fireEvent.click(helpful);
        await waitFor(() => expect(feedbackPosts).toEqual([{id: 'p1', signal: 'helpful'}]));
        // The count reflects the server's fresh tally without a refetch.
        await waitFor(() => expect(screen.getByRole('button', {name: /^helpful/i}).textContent).toContain('1'));
    });

    it('opens version history on demand and lists the versions (AC2)', async () => {
        renderAt('/developer/practices/p1');
        const toggle = await screen.findByRole('button', {name: /show history/i});
        fireEvent.click(toggle);
        expect(await screen.findByTestId('version-history')).toBeInTheDocument();
        expect(await screen.findByText('v2')).toBeInTheDocument();
        expect(screen.getByText(/tweak/)).toBeInTheDocument();
    });

    it('shows the showcase cross-link affordance only when present (AC4, 6.3.8)', async () => {
        const showcases: ShowcaseCrossLink[] = [{id: 's1', title: 'A great session'}];
        detailData = detail({showcases});
        renderAt('/developer/practices/p1');
        expect(await screen.findByTestId('showcase-cross-links')).toBeInTheDocument();
        expect(screen.getByText('A great session')).toBeInTheDocument();
    });

    it('renders no cross-link section when there are no showcases (AC4)', async () => {
        renderAt('/developer/practices/p1');
        await screen.findByTestId('practice-content');
        expect(screen.queryByTestId('showcase-cross-links')).not.toBeInTheDocument();
    });

    it('shows the edit entry point only to the author (AC3, permissions)', async () => {
        detailData = detail({canEdit: true});
        renderAt('/developer/practices/p1');
        expect(await screen.findByTestId('edit-entry-point')).toBeInTheDocument();
        expect(screen.getByRole('link', {name: 'Edit'})).toBeInTheDocument();
    });

    it('hides the edit entry point from non-authors (AC3, permissions)', async () => {
        renderAt('/developer/practices/p1');
        await screen.findByTestId('practice-content');
        expect(screen.queryByTestId('edit-entry-point')).not.toBeInTheDocument();
    });
});

describe('Best-practice editor (Task 6.2.8 / #163)', () => {
    it('explains the active contribution model and creates a draft (AC3, model-aware authoring)', async () => {
        renderAt('/developer/practices/new');
        // Model-aware copy is shown up front.
        expect(await screen.findByTestId('model-explainer')).toHaveTextContent(/reviews and approves/i);

        fireEvent.change(screen.getByPlaceholderText('A short, descriptive title'), {
            target: {value: 'My new practice'},
        });
        fireEvent.change(screen.getByPlaceholderText('Write the practice in Markdown…'), {
            target: {value: 'Some helpful content'},
        });
        fireEvent.click(screen.getByRole('button', {name: 'Save draft'}));

        await waitFor(() =>
            expect(createPosts).toEqual([{title: 'My new practice', scope: 'org', markdown: 'Some helpful content'}]),
        );
        // The confirmation keeps the model framing honest (saved as a draft).
        expect(await screen.findByTestId('create-confirmation')).toHaveTextContent(/draft/i);
    });
});
