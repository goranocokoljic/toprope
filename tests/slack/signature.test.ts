import {describe, it, expect} from 'vitest';
import {createHmac} from 'crypto';
import {verifySlackSignature, MAX_SKEW_SECONDS} from '../../src/slack/signature';

const SECRET = 'test-signing-secret';

function sign(secret: string, timestamp: string, body: string): string {
    const digest = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
    return `v0=${digest}`;
}

describe('verifySlackSignature', () => {
    const now = 1_700_000_000;
    const ts = String(now);
    const body = 'token=abc&user_id=U1&command=%2Fgovproxy-log';

    it('accepts a correctly signed, fresh request', () => {
        const signature = sign(SECRET, ts, body);
        expect(
            verifySlackSignature({signingSecret: SECRET, timestamp: ts, signature, rawBody: body, nowSeconds: now}),
        ).toBe(true);
    });

    it('rejects a tampered body', () => {
        const signature = sign(SECRET, ts, body);
        expect(
            verifySlackSignature({
                signingSecret: SECRET,
                timestamp: ts,
                signature,
                rawBody: body + '&injected=1',
                nowSeconds: now,
            }),
        ).toBe(false);
    });

    it('rejects a signature made with the wrong secret', () => {
        const signature = sign('other-secret', ts, body);
        expect(
            verifySlackSignature({signingSecret: SECRET, timestamp: ts, signature, rawBody: body, nowSeconds: now}),
        ).toBe(false);
    });

    it('rejects a stale timestamp (replay protection)', () => {
        const signature = sign(SECRET, ts, body);
        const later = now + MAX_SKEW_SECONDS + 1;
        expect(
            verifySlackSignature({signingSecret: SECRET, timestamp: ts, signature, rawBody: body, nowSeconds: later}),
        ).toBe(false);
    });

    it('accepts a timestamp at the edge of the allowed skew', () => {
        const signature = sign(SECRET, ts, body);
        const later = now + MAX_SKEW_SECONDS;
        expect(
            verifySlackSignature({signingSecret: SECRET, timestamp: ts, signature, rawBody: body, nowSeconds: later}),
        ).toBe(true);
    });

    it('rejects when headers or secret are missing', () => {
        const signature = sign(SECRET, ts, body);
        expect(verifySlackSignature({signingSecret: '', timestamp: ts, signature, rawBody: body, nowSeconds: now})).toBe(false);
        expect(verifySlackSignature({signingSecret: SECRET, timestamp: undefined, signature, rawBody: body, nowSeconds: now})).toBe(false);
        expect(verifySlackSignature({signingSecret: SECRET, timestamp: ts, signature: undefined, rawBody: body, nowSeconds: now})).toBe(false);
    });

    it('rejects a non-numeric timestamp', () => {
        const signature = sign(SECRET, 'not-a-number', body);
        expect(
            verifySlackSignature({
                signingSecret: SECRET,
                timestamp: 'not-a-number',
                signature,
                rawBody: body,
                nowSeconds: now,
            }),
        ).toBe(false);
    });
});
