// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {RelatedPractices} from '../components/RelatedPractices';
import type {RelatedPractice} from '../api/types';

const INTRO = 'Here are a few practices that may help with code churn.';

function practice(over: Partial<RelatedPractice> = {}): RelatedPractice {
    return {id: 'p1', title: 'Review AI suggestions before accepting', scope: 'org', pinned: false, endorsed: false, helpfulRatio: null, ...over};
}

let surfaced: RelatedPractice[];
let viewPosts: {id: string; metric: string}[];
let fetchMock: Mock;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
}

beforeEach(() => {
    surfaced = [practice()];
    viewPosts = [];
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();

        const viewMatch = u.match(/\/api\/me\/practices\/([^/]+)\/view/);
        if (viewMatch && method === 'POST') {
            const body = JSON.parse(String(init?.body ?? '{}')) as {metric: string};
            viewPosts.push({id: decodeURIComponent(viewMatch[1]), metric: body.metric});
            return json({data: {id: 'e1', event: 'viewed'}}, 201);
        }
        if (u.includes('/api/me/practices/related') && method === 'GET') {
            return json({data: {metric: 'churn', intro: INTRO, practices: surfaced}});
        }
        return json({error: 'unexpected'}, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderAffordance(metric = 'churn'): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <RelatedPractices metric={metric} />
        </QueryClientProvider>,
    );
}

describe('RelatedPractices affordance (Task 6.2.7)', () => {
    it('renders nothing when there are no relevant practices (unobtrusive)', async () => {
        surfaced = [];
        const {container} = render(
            <QueryClientProvider client={makeClient()}>
                <RelatedPractices metric="churn" />
            </QueryClientProvider>,
        );
        // Give the query a tick to settle, then assert the affordance stays absent.
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(container.textContent).toBe('');
        expect(viewPosts).toEqual([]);
    });

    it('surfaces a collapsed, encouraging trigger and expands to the practices (surfacing in context)', async () => {
        renderAffordance();
        const trigger = await screen.findByRole('button', {name: /related practice.*that may help/i});
        // Encouraging, never scolding.
        expect(trigger.textContent?.toLowerCase()).toContain('may help');
        expect(trigger.textContent?.toLowerCase()).not.toContain('bad');

        fireEvent.click(trigger);

        // The reviewed intro copy from the server, plus the surfaced practice.
        expect(await screen.findByText(INTRO)).toBeInTheDocument();
        expect(screen.getByText('Review AI suggestions before accepting')).toBeInTheDocument();
        expect(INTRO.toLowerCase()).not.toContain('bad');
    });

    it('records a usage view event when the practices are viewed (usage-event recording)', async () => {
        surfaced = [practice({id: 'a'}), practice({id: 'b', title: 'Second tip'})];
        renderAffordance();
        const trigger = await screen.findByRole('button', {name: /related practice/i});
        fireEvent.click(trigger);

        await waitFor(() => expect(viewPosts).toHaveLength(2));
        expect(viewPosts.map((v) => v.id).sort()).toEqual(['a', 'b']);
        expect(viewPosts.every((v) => v.metric === 'churn')).toBe(true);
    });

    it('does not double-record a view when the panel is collapsed and re-expanded', async () => {
        renderAffordance();
        const trigger = await screen.findByRole('button', {name: /related practice/i});
        fireEvent.click(trigger);
        await waitFor(() => expect(viewPosts).toHaveLength(1));

        fireEvent.click(screen.getByRole('button', {name: /hide related practices/i}));
        fireEvent.click(await screen.findByRole('button', {name: /related practice/i}));
        // No second view recorded for the same practice.
        await waitFor(() => expect(screen.getByText(INTRO)).toBeInTheDocument());
        expect(viewPosts).toHaveLength(1);
    });

    it('shows lead pin / endorsement markers and the helpful-ratio hint', async () => {
        surfaced = [practice({pinned: true, endorsed: true, helpfulRatio: 0.8})];
        renderAffordance();
        fireEvent.click(await screen.findByRole('button', {name: /related practice/i}));
        expect(await screen.findByText('Pinned')).toBeInTheDocument();
        expect(screen.getByText('Endorsed')).toBeInTheDocument();
        expect(screen.getByText(/found this helpful/i)).toBeInTheDocument();
    });
});
