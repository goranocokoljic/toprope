// @vitest-environment jsdom
import '../test/setup';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {api, ApiError} from '../api/client';

/**
 * Tests for the API client's error-message extraction (#209). `request` now
 * surfaces the server's typed error body `message` app-wide; these pin the
 * contract's fallback branches so a non-JSON body (proxy HTML, empty response)
 * or a blank message can never escape as a raw SyntaxError or an empty string —
 * every failure is an ApiError with a displayable message.
 */

function stubFetch(body: string, status: number, contentType?: string): void {
    const headers = contentType ? {'Content-Type': contentType} : undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {status, headers})));
}

async function caught(): Promise<ApiError> {
    const err = await api.getOverview().then(
        () => {
            throw new Error('expected the request to reject');
        },
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('api client — error-message extraction (#209)', () => {
    it('surfaces the server body message from a typed error response', async () => {
        stubFetch(
            JSON.stringify({error: 'Conflict', message: 'A sync is already in progress for this provider'}),
            409,
            'application/json',
        );
        const err = await caught();
        expect(err.status).toBe(409);
        expect(err.message).toBe('A sync is already in progress for this provider');
    });

    it('falls back to the generic message on a non-JSON error body', async () => {
        stubFetch('<html>502 Bad Gateway</html>', 502, 'text/html');
        const err = await caught();
        expect(err.status).toBe(502);
        expect(err.message).toBe('Request to /api/overview failed with 502');
    });

    it('falls back to the generic message when the JSON body has no usable message', async () => {
        stubFetch(JSON.stringify({error: 'Bad Request', message: '   '}), 400, 'application/json');
        const err = await caught();
        expect(err.message).toBe('Request to /api/overview failed with 400');
    });

    it('falls back to the generic message when the body is JSON without a message field', async () => {
        stubFetch(JSON.stringify({error: 'Forbidden'}), 403, 'application/json');
        const err = await caught();
        expect(err.status).toBe(403);
        expect(err.message).toBe('Request to /api/overview failed with 403');
    });

    it('surfaces the deliberate 503 remediation message (key-setup guidance is user-facing)', async () => {
        stubFetch(
            JSON.stringify({error: 'Service Unavailable', message: 'TOPROPE_SECRET_KEY is not set — configure a key'}),
            503,
            'application/json',
        );
        const err = await caught();
        expect(err.status).toBe(503);
        expect(err.message).toBe('TOPROPE_SECRET_KEY is not set — configure a key');
    });

    it('redacts unhandled 500 bodies: raw internal error text never reaches the UI', async () => {
        stubFetch(
            JSON.stringify({error: 'Internal Server Error', message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: git_providers.id'}),
            500,
            'application/json',
        );
        const err = await caught();
        expect(err.status).toBe(500);
        expect(err.message).toBe('Request to /api/overview failed with 500');
    });
});
