import {createHmac, timingSafeEqual} from 'crypto';

// Slack signs every request with `v0`, an HMAC-SHA256 over
// `v0:{timestamp}:{rawBody}` keyed by the app signing secret. See
// https://api.slack.com/authentication/verifying-requests-from-slack
const SIGNATURE_VERSION = 'v0';

// Reject requests whose timestamp is more than this many seconds from now, in
// either direction. Slack recommends 5 minutes; this defends against replay of a
// captured request.
export const MAX_SKEW_SECONDS = 60 * 5;

export interface SlackSignatureInput {
    signingSecret: string;
    // Value of the X-Slack-Request-Timestamp header (unix seconds, as a string).
    timestamp: string | undefined;
    // Value of the X-Slack-Signature header (e.g. "v0=abc123…").
    signature: string | undefined;
    // The exact, unparsed request body.
    rawBody: string;
    // Current time in unix seconds; injectable for testing. Defaults to now.
    nowSeconds?: number;
}

function timingSafeEqualStr(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    // timingSafeEqual throws on length mismatch; compare lengths first (a length
    // difference is not secret — the signature format is fixed-width anyway).
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/**
 * Verify an inbound Slack request signature. Returns true only when the signing
 * secret is configured, the timestamp is present and within the allowed skew,
 * and the recomputed HMAC matches the provided signature (compared in constant
 * time). Any missing/garbage input returns false rather than throwing, so a
 * malformed request is simply rejected at the boundary.
 */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
    const {signingSecret, timestamp, signature, rawBody} = input;
    if (!signingSecret || !timestamp || !signature) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;

    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

    const base = `${SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
    const digest = createHmac('sha256', signingSecret).update(base).digest('hex');
    const expected = `${SIGNATURE_VERSION}=${digest}`;

    return timingSafeEqualStr(expected, signature);
}
