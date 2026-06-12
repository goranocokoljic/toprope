// @vitest-environment jsdom
import '../test/setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

import {MyCoaching} from '../pages/MyCoaching';
import {TeamCoaching} from '../pages/TeamCoaching';
import {ThemeProvider} from '../theme/ThemeProvider';
import {
    combinedSignalCopy,
    formatPeriodTick,
    reworkTrendSentence,
} from '../components/coaching';
import type {
    DeveloperPRReviewCoaching,
    PRReviewMetricTrend,
    TeamPRReviewCoaching,
} from '../api/types';

// --- Fixtures --------------------------------------------------------------

const DEV_COACHING: DeveloperPRReviewCoaching = {
    period_unit: 'monthly',
    all_pr: {
        scope_variant: 'all_pr',
        basis: 'factual',
        points: [
            {period: '2026-05', prs_total: 5, prs_merged: 5, rework_rate: 0.15, review_rejection_rate: 0.15, avg_review_rounds: 1.2, avg_comment_density: 3, comment_density_vs_baseline: 1, avg_time_to_merge_hours: 10, avg_churn: 0.1, combined_signal: 'effective'},
            {period: '2026-06', prs_total: 6, prs_merged: 6, rework_rate: 0.3, review_rejection_rate: 0.3, avg_review_rounds: 2, avg_comment_density: 5, comment_density_vs_baseline: 1.5, avg_time_to_merge_hours: 20, avg_churn: 0.25, combined_signal: 'struggling'},
        ],
        rework_trend: {metric: 'rework_rate', direction: 'rising', from_period: '2026-05', to_period: '2026-06', from_value: 0.15, to_value: 0.3},
        latest_signal: 'struggling',
        sufficient_periods: 2,
    },
    ai_assisted: {
        scope_variant: 'ai_assisted_pr',
        basis: 'inferred',
        points: [
            {period: '2026-06', prs_total: 3, prs_merged: 3, rework_rate: 0.33, review_rejection_rate: 0.33, avg_review_rounds: 1.5, avg_comment_density: 4, comment_density_vs_baseline: 1.1, avg_time_to_merge_hours: 12, avg_churn: 0.2, combined_signal: 'healthy_iteration'},
        ],
        rework_trend: {metric: 'rework_rate', direction: 'insufficient_data', from_period: '2026-06', to_period: '2026-06', from_value: 0.33, to_value: 0.33},
        latest_signal: 'healthy_iteration',
        sufficient_periods: 1,
    },
};

const TEAM_COACHING: TeamPRReviewCoaching = {
    scope: 'org',
    period_unit: 'monthly',
    all_pr: {
        scope_variant: 'all_pr',
        basis: 'factual',
        points: [
            {period: '2026-05', suppressed: true, developers: null, prs_total: null, rework_rate: null, review_rejection_rate: null, avg_review_rounds: null, avg_comment_density: null, avg_time_to_merge_hours: null, avg_churn: null, combined_signal: 'insufficient_data'},
            {period: '2026-06', suppressed: false, developers: 4, prs_total: 20, rework_rate: 0.28, review_rejection_rate: 0.28, avg_review_rounds: 1.8, avg_comment_density: 4, avg_time_to_merge_hours: 15, avg_churn: 0.22, combined_signal: 'struggling'},
        ],
        rework_trend: {metric: 'rework_rate', direction: 'insufficient_data', from_period: '2026-06', to_period: '2026-06', from_value: 0.28, to_value: 0.28},
        latest_signal: 'struggling',
        sufficient_periods: 1,
    },
    ai_assisted: {
        scope_variant: 'ai_assisted_pr',
        basis: 'inferred',
        points: [
            {period: '2026-06', suppressed: false, developers: 3, prs_total: 9, rework_rate: 0.4, review_rejection_rate: 0.4, avg_review_rounds: 2, avg_comment_density: 6, avg_time_to_merge_hours: 18, avg_churn: 0.3, combined_signal: 'struggling'},
        ],
        rework_trend: {metric: 'rework_rate', direction: 'insufficient_data', from_period: '2026-06', to_period: '2026-06', from_value: 0.4, to_value: 0.4},
        latest_signal: 'struggling',
        sufficient_periods: 1,
    },
};

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify({data: body}), {status: 200, headers: {'Content-Type': 'application/json'}});
}

let fetchMock: Mock;

function installFetch(): void {
    fetchMock = vi.fn(async (url: unknown) => {
        const path = new URL(String(url), 'http://localhost').pathname;
        if (path === '/api/me/pr-coaching') return jsonResponse(DEV_COACHING);
        if (path === '/api/coaching/pr-review/org') return jsonResponse(TEAM_COACHING);
        if (path === '/api/teams') {
            return jsonResponse([{name: 'eng'}]) as Response & {pagination?: unknown};
        }
        return new Response(JSON.stringify({error: 'not found'}), {status: 404});
    });
    vi.stubGlobal('fetch', fetchMock);
}

// getTeams pages through a PaginatedResponse, so /api/teams needs that envelope.
function installFetchWithTeams(): void {
    fetchMock = vi.fn(async (url: unknown) => {
        const path = new URL(String(url), 'http://localhost').pathname;
        if (path === '/api/coaching/pr-review/org') return jsonResponse(TEAM_COACHING);
        if (path === '/api/teams') {
            return new Response(
                JSON.stringify({data: [{name: 'eng'}], pagination: {page: 1, limit: 100, total: 1}}),
                {status: 200, headers: {'Content-Type': 'application/json'}},
            );
        }
        return new Response(JSON.stringify({error: 'not found'}), {status: 404});
    });
    vi.stubGlobal('fetch', fetchMock);
}

function makeClient(): QueryClient {
    return new QueryClient({defaultOptions: {queries: {retry: false}}});
}

function renderPage(node: JSX.Element): void {
    render(
        <QueryClientProvider client={makeClient()}>
            <ThemeProvider>
                <MemoryRouter>{node}</MemoryRouter>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
});

// --- Developer view --------------------------------------------------------

describe('MyCoaching — developer-private trajectory', () => {
    beforeEach(() => installFetch());

    it('renders both variants with the AI-assisted one labeled inferred / lower-confidence', async () => {
        renderPage(<MyCoaching />);
        expect(await screen.findByText('All your PRs')).toBeInTheDocument();
        expect(screen.getByText('Your AI-assisted PRs')).toBeInTheDocument();
        // The inferred variant carries an explicit lower-confidence label + note.
        expect(screen.getByText(/Inferred · lower confidence/i)).toBeInTheDocument();
        expect(screen.getByTestId('inferred-note')).toBeInTheDocument();
    });

    it('frames the signal as a trajectory, not a bare verdict', async () => {
        renderPage(<MyCoaching />);
        const sentences = await screen.findAllByTestId('trajectory-sentence');
        // all_pr has a real rising trend → from→to phrasing.
        expect(sentences[0]).toHaveTextContent(/rose from 15% to 30%/i);
        // ai_assisted has no trend yet → gentle "not enough history" copy, no verdict.
        expect(sentences[1]).toHaveTextContent(/isn't enough history yet/i);
    });

    it('states the privacy guarantee to the developer', async () => {
        renderPage(<MyCoaching />);
        expect(await screen.findByText(/manager only ever sees team-level aggregates/i)).toBeInTheDocument();
    });
});

// --- Manager view ----------------------------------------------------------

describe('TeamCoaching — manager aggregate only', () => {
    beforeEach(() => installFetchWithTeams());

    it('renders team-level variants and the k-anonymity suppression note', async () => {
        renderPage(<TeamCoaching />);
        expect(await screen.findByText('All PRs')).toBeInTheDocument();
        expect(screen.getByText('AI-assisted PRs')).toBeInTheDocument();
        // A suppressed period present → the privacy note explains the gap.
        expect(screen.getAllByTestId('suppression-note').length).toBeGreaterThan(0);
    });

    it('states that individual numbers are never shown', async () => {
        renderPage(<TeamCoaching />);
        expect(
            await screen.findByText(/never shows or links to any one person's figures/i),
        ).toBeInTheDocument();
    });
});

// --- Pure copy helpers -----------------------------------------------------

describe('coaching copy helpers', () => {
    it('phrases rising/falling/steady trajectories from the trend', () => {
        const base: PRReviewMetricTrend = {metric: 'rework_rate', direction: 'rising', from_period: 'a', to_period: 'b', from_value: 0.15, to_value: 0.3};
        expect(reworkTrendSentence(base, 'your PRs')).toMatch(/rose from 15% to 30%/);
        expect(reworkTrendSentence({...base, direction: 'falling'}, 'your PRs')).toMatch(/eased from/);
        expect(reworkTrendSentence({...base, direction: 'steady'}, 'your PRs')).toMatch(/held steady/);
    });

    it('returns null (no verdict) when there is no trend', () => {
        const none: PRReviewMetricTrend = {metric: 'rework_rate', direction: 'insufficient_data', from_period: null, to_period: null, from_value: null, to_value: null};
        expect(reworkTrendSentence(none, 'your PRs')).toBeNull();
    });

    it('maps signals to non-judgmental copy for both subjects', () => {
        expect(combinedSignalCopy('struggling', 'you').guidance).toMatch(/review AI output a little more/i);
        expect(combinedSignalCopy('struggling', 'team').guidance).toMatch(/team might benefit/i);
        expect(combinedSignalCopy('effective', 'you').tone).toBe('success');
        expect(combinedSignalCopy('insufficient_data', 'you').label).toMatch(/not enough data/i);
    });

    it('formats period ticks for month and ISO-week keys', () => {
        expect(formatPeriodTick('2026-06')).toMatch(/2026/);
        expect(formatPeriodTick('2026-W07')).toBe('W07');
    });
});
