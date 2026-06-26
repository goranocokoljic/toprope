/**
 * Auto-flag scrubber — two-tier sensitive-content detector (Task 6.3.5 / #168).
 *
 * A NEW, focused detector (the proxy-era live-substitution scanner was removed in
 * the pivot away from the proxy — see Phase6 design §5.4). This one only needs to
 * FLAG content for the human reviewer; it never redacts, never rewrites the
 * conversation, and never sits in a request path. It writes `scrub_flags` rows and
 * stops there — the MANDATORY manual review (6.3.6) is the actual publish control,
 * not this detector.
 *
 * TWO confidence tiers, kept deliberately distinct (never blurred):
 *
 *   - `secret_high` — secrets / API keys / credentials. Pattern-reliable: an API
 *     key, token, or private-key block looks like one. Flagged FIRMLY as
 *     likely-sensitive.
 *
 *   - `pii_hint_low` — softer PII (emails, phone numbers, customer/account ids, …).
 *     Pattern matching here is NOISY and false-positive-prone (every example email,
 *     every product code looks like PII). These are surfaced as fallible "possible
 *     PII" HINTS that draw the reviewer's eye — NEVER asserted as fact, NEVER
 *     blocking.
 *
 * FALSE-POSITIVE-TOLERANT BY DESIGN (PII tier): the low tier is intentionally
 * permissive. We would rather surface a harmless example email as a hint than miss a
 * real customer address — because the mandatory manual review (6.3.6) is the real
 * gate, an over-eager hint costs only a glance, while a missed one could leak. The
 * high tier, by contrast, is tuned to be reliable so it does NOT cause alert-fatigue:
 * treating noisy PII as authoritative is exactly what trains reviewers to ignore
 * flags, including the real ones. So secrets are firm flags; soft PII is an attention
 * prompt; the human is the control for both.
 */

import type Database from 'better-sqlite3';
import {addScrubFlag} from './unitsStore';
import type {ScrubFlag, ScrubTier} from './unitsTypes';

/** A single sensitive-content match, before it is persisted as a `scrub_flag`. */
export interface ScrubFinding {
    tier: ScrubTier;
    /** Human-readable, location-bearing description for the manual reviewer. */
    finding: string;
    /** 0-based char offset of the match in the scanned content (drives ordering). */
    index: number;
}

/**
 * One detector rule. `regex` MUST be global (`g`) so every occurrence is found.
 * `tier` is fixed per rule — a rule is wholly a secret rule or wholly a PII-hint
 * rule, so the two tiers can never blur. `accept` optionally rejects a raw match
 * (e.g. an obvious placeholder) to keep the high tier reliable.
 */
interface DetectorRule {
    label: string;
    tier: ScrubTier;
    regex: RegExp;
    /**
     * Which capture group holds the sensitive value to mask in the finding text.
     * Defaults to 0 (the whole match). Used by credential-assignment rules whose
     * match includes the key name but whose secret is a sub-group.
     */
    valueGroup?: number;
    accept?: (match: RegExpMatchArray) => boolean;
}

// Obvious non-secret stand-ins, so a credential-assignment rule doesn't fire on
// `password = "your_password_here"`. Kept lowercase; compared case-insensitively.
const PLACEHOLDER_VALUES = [
    'password',
    'changeme',
    'change_me',
    'example',
    'placeholder',
    'redacted',
    'xxxxxx',
    'your_',
    'my_',
    'secret',
    'token',
    'todo',
    '<',
    '****',
    '...',
];

function looksLikePlaceholder(value: string): boolean {
    const v = value.trim().toLowerCase();
    if (v.length === 0) {
        return true;
    }
    return PLACEHOLDER_VALUES.some((p) => v.includes(p));
}

/**
 * HIGH-confidence rules — pattern-reliable secrets / keys / credentials. Each is a
 * well-known token shape, a private-key block, a JWT, or a credential assignment
 * whose value survives the placeholder filter. Tuned to be reliable: a match here is
 * firmly flagged.
 */
const SECRET_RULES: DetectorRule[] = [
    {
        label: 'private key block',
        tier: 'secret_high',
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    },
    {
        label: 'AWS access key id',
        tier: 'secret_high',
        regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
        label: 'GitHub token',
        tier: 'secret_high',
        regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    },
    {
        label: 'Slack token',
        tier: 'secret_high',
        regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    },
    {
        label: 'Google API key',
        tier: 'secret_high',
        regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    {
        label: 'Stripe secret key',
        tier: 'secret_high',
        regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
    },
    {
        // OpenAI / Anthropic / generic `sk-` secret keys (incl. `sk-ant-`, `sk-proj-`).
        label: 'API secret key',
        tier: 'secret_high',
        regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    },
    {
        label: 'JSON Web Token',
        tier: 'secret_high',
        regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    },
    {
        label: 'credential assignment',
        tier: 'secret_high',
        // key (password / secret / api_key / access_token / client_secret / …) then
        // = or : then a quoted-or-bare value of length >= 6. Group 1 is the value.
        regex: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*["']?([^\s"']{6,})["']?/gi,
        valueGroup: 1,
        accept: (m) => !looksLikePlaceholder(m[1] ?? ''),
    },
];

/**
 * LOW-confidence rules — softer PII. NOISY by design and tolerated as such: these
 * are hints, not verdicts. Names are intentionally NOT matched (a free-text name
 * detector is pure false positives without NLP); instead we hint on the
 * machine-shaped PII a regex can actually find — emails, phones, ids — and lean on
 * the human reviewer for the rest.
 */
const PII_RULES: DetectorRule[] = [
    {
        label: 'possible email',
        tier: 'pii_hint_low',
        regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    },
    {
        label: 'possible SSN',
        tier: 'pii_hint_low',
        regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    },
    {
        label: 'possible phone number',
        tier: 'pii_hint_low',
        regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    },
    {
        label: 'possible IP address',
        tier: 'pii_hint_low',
        regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    },
    {
        label: 'possible customer/account id',
        tier: 'pii_hint_low',
        regex: /\b(?:customer|account|client|user)[_\s-]?id\s*[=:]\s*["']?([^\s"']{2,})["']?/gi,
        valueGroup: 1,
    },
];

const ALL_RULES: DetectorRule[] = [...SECRET_RULES, ...PII_RULES];

// Tier order for the deterministic tie-break: secrets before hints at the same index.
const TIER_RANK: Record<ScrubTier, number> = {
    secret_high: 0,
    pii_hint_low: 1,
};

/** 1-based line number of a char offset, for locating the finding in the content. */
function lineOf(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
        if (content[i] === '\n') {
            line++;
        }
    }
    return line;
}

/**
 * Mask a sensitive value so the finding text can locate it WITHOUT copying the raw
 * secret verbatim into a second column. Keeps a short head and tail for the reviewer
 * to recognize; collapses the middle.
 */
function mask(value: string): string {
    if (value.length <= 6) {
        return `${value.slice(0, 1)}…`;
    }
    return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/**
 * Scan content for sensitive material and return findings, deterministically
 * ordered. Pure: it reads the string and nothing else — no DB, no I/O, no
 * mutation of the input. Findings are ordered by position, then secrets-before-hints
 * at the same position, then label, so the same content always yields the same
 * sequence (a property the persistence layer and tests rely on).
 */
export function detectSensitiveContent(content: string): ScrubFinding[] {
    if (typeof content !== 'string' || content.length === 0) {
        return [];
    }

    const findings: ScrubFinding[] = [];
    for (const rule of ALL_RULES) {
        for (const match of content.matchAll(rule.regex)) {
            if (rule.accept && !rule.accept(match)) {
                continue;
            }
            const index = match.index ?? 0;
            const rawValue = rule.valueGroup ? (match[rule.valueGroup] ?? match[0]) : match[0];
            const line = lineOf(content, index);
            const prefix = rule.tier === 'secret_high' ? rule.label : `${rule.label} (hint, verify manually)`;
            findings.push({
                tier: rule.tier,
                finding: `${prefix} — ${mask(rawValue)} at line ${line}`,
                index,
            });
        }
    }

    findings.sort((a, b) => {
        if (a.index !== b.index) {
            return a.index - b.index;
        }
        if (a.tier !== b.tier) {
            return TIER_RANK[a.tier] - TIER_RANK[b.tier];
        }
        return a.finding.localeCompare(b.finding);
    });

    return findings;
}

/**
 * Detect sensitive content in a contribution's text and PERSIST each finding as a
 * `scrub_flags` row (via the canonical {@link addScrubFlag} writer — no duplicate
 * insert logic). FLAG-ONLY: the content is never modified and nothing is gated here;
 * the returned flags simply feed the mandatory manual review (6.3.6). Returns the
 * stored flags in the same deterministic order as {@link detectSensitiveContent}.
 */
export function scrubContribution(
    db: Database.Database,
    contributionId: string,
    content: string,
): ScrubFlag[] {
    const findings = detectSensitiveContent(content);
    return findings.map((f) => addScrubFlag(db, {contributionId, tier: f.tier, finding: f.finding}));
}
