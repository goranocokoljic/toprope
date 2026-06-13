/**
 * Promote / redact / publish service for the showcase (Task 5.8 / #129).
 *
 * This module operationalises the showcase privacy contract — the deliberate,
 * owner-only bridge from a private encrypted capture to an org-visible example:
 *
 *   1. DRAFT (transient decrypt). `draftFromSession` decrypts one of the owner's
 *      OWN captured sessions in memory with the key they supply for this one call,
 *      and returns the plaintext as an EDITABLE DRAFT. That plaintext is never
 *      persisted and never logged — it exists only as the value returned to the
 *      owner so they can redact it. (The route binds the draft to one of the
 *      owner's own retrospectives, so promote has no path other than the owner's
 *      own retrospective view.)
 *
 *   2. PUBLISH (owner-submitted redacted content only). `publishExample` writes to
 *      the SEPARATE shared store. It NEVER re-derives content from a capture — it
 *      persists exactly the redacted text the owner submits, which is why nothing
 *      can be auto-harvested. Before writing it enforces, live, the org policy:
 *      showcasing must be enabled, the chosen scope must be within
 *      showcase_scope_permitted, and — mandatory — the owner must have acknowledged
 *      the redaction step. scope_target is resolved from the author's OWN team,
 *      never from request input, so one can't publish into another team's showcase.
 *
 * The private capture is untouched by any of this: publish reads no capture and
 * writes only to showcase_examples.
 */

import type Database from 'better-sqlite3';
import {decryptCapture, type EncryptionMeta} from '../capture/encryption';
import {listSessionCapturesForDeveloper} from '../capture/store';
import {insertShowcaseExample} from './store';
import {isShowcaseEnabledForTeam, isScopePermittedForTeam} from './gate';
import type {ShowcaseExample, ShowcaseScope} from './types';

/** Stable error codes the route maps to HTTP statuses without string-matching messages. */
export type ShowcaseErrorCode =
    | 'no_captures'
    | 'decrypt_failed'
    | 'showcase_disabled'
    | 'scope_not_permitted'
    | 'redaction_required';

/** A typed failure from the showcase flow, carrying a code the route can switch on. */
export class ShowcaseError extends Error {
    constructor(
        readonly code: ShowcaseErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ShowcaseError';
    }
}

/** Coerce a stored public meta object into the EncryptionMeta decryptCapture needs. */
function toEncryptionMeta(meta: Record<string, unknown>): EncryptionMeta {
    const {algo, iv, auth_tag, key_id} = meta;
    if (
        typeof algo !== 'string' ||
        typeof iv !== 'string' ||
        typeof auth_tag !== 'string' ||
        typeof key_id !== 'string'
    ) {
        throw new ShowcaseError('decrypt_failed', 'Capture encryption metadata is malformed');
    }
    return {algo, iv, auth_tag, key_id};
}

/** The transient result of decrypting a session for promotion: the joined plaintext draft. */
export interface ShowcaseDraft {
    sessionId: string;
    /** The decrypted conversation, concatenated chronologically. Transient: never persisted/logged. */
    plaintext: string;
    /** How many capture rows the draft was built from (provenance for the owner). */
    captureCount: number;
}

export interface DraftFromSessionInput {
    developerId: string;
    sessionId: string;
    /** The developer's AES-256 key, supplied transiently for this one operation. */
    key: Buffer;
}

/**
 * Transiently decrypt one of the owner's OWN captured sessions into an editable
 * draft. Mirrors the retrospective generator's transient-decrypt posture: captures
 * are the server's blind ciphertext; decryption happens HERE, in memory, and the
 * returned plaintext is the owner's to redact — it is never persisted or logged. A
 * wrong key (or any tampering) makes GCM verification throw, surfaced as a typed
 * `decrypt_failed`; an empty session is a typed `no_captures`.
 *
 * Ordering note: `captured_at` is client-supplied (see the capture store), so the
 * chronological join is best-effort with `created_at` as the tiebreak — good enough
 * for a human reviewing a draft to redact.
 */
export function draftFromSession(db: Database.Database, input: DraftFromSessionInput): ShowcaseDraft {
    const captures = listSessionCapturesForDeveloper(db, input.developerId, input.sessionId);
    if (captures.length === 0) {
        throw new ShowcaseError('no_captures', 'No captured session found to promote');
    }
    const parts: string[] = [];
    for (const capture of captures) {
        const meta = toEncryptionMeta(capture.encryptionMeta);
        const ciphertext = Buffer.from(capture.ciphertext, 'base64');
        try {
            parts.push(decryptCapture(ciphertext, meta, input.key));
        } catch {
            // Never include the underlying crypto error or any bytes — a bad key and a
            // tampered blob are intentionally indistinguishable.
            throw new ShowcaseError('decrypt_failed', 'Could not decrypt the session with the provided key');
        }
    }
    return {sessionId: input.sessionId, plaintext: parts.join('\n'), captureCount: captures.length};
}

export interface PublishExampleInput {
    authorDeveloperId: string;
    /** The author's own team — resolves scope_target and the org policy boundary. */
    team: string | null;
    scope: ShowcaseScope;
    title: string;
    /** The owner-submitted, already-redacted content. The ONLY plaintext publish persists. */
    content: string;
    taskType: string | null;
    tool: string | null;
    authorNote: string | null;
    /**
     * The owner's explicit confirmation that they reviewed and redacted the draft.
     * Publishing is refused without it — the redaction step cannot be bypassed.
     */
    redactionAcknowledged: boolean;
}

/**
 * Publish a redacted example to the separate shared store, enforcing the org
 * policy live. Order of checks is deliberate: feature-enabled, then the mandatory
 * redaction acknowledgement, then scope permission — so a forbidden request never
 * advances to a write. scope_target is the author's own team for team scope and
 * null for org scope; it is never taken from input.
 */
export function publishExample(db: Database.Database, input: PublishExampleInput): ShowcaseExample {
    if (!isShowcaseEnabledForTeam(db, input.team)) {
        throw new ShowcaseError('showcase_disabled', 'Showcasing is not enabled for your team.');
    }
    if (!input.redactionAcknowledged) {
        throw new ShowcaseError(
            'redaction_required',
            'You must review and redact the conversation before publishing; the redaction step cannot be skipped.',
        );
    }
    if (!isScopePermittedForTeam(db, input.team, input.scope)) {
        throw new ShowcaseError('scope_not_permitted', `Your organization does not permit publishing at '${input.scope}' scope.`);
    }
    // Team scope needs a team to publish into; a developer with no team can only go org-wide.
    if (input.scope === 'team' && !input.team) {
        throw new ShowcaseError('scope_not_permitted', 'Team-scoped publishing requires you to belong to a team.');
    }
    const scopeTarget = input.scope === 'team' ? input.team : null;
    return insertShowcaseExample(db, {
        authorDeveloperId: input.authorDeveloperId,
        publishedAt: new Date().toISOString(),
        scope: input.scope,
        scopeTarget,
        title: input.title,
        taskType: input.taskType,
        tool: input.tool,
        content: input.content,
        authorNote: input.authorNote,
    });
}
