/**
 * Capture-key setup + recovery routes (Task 5.5 / #126).
 *
 * All routes live under /api/me, so the developer id comes STRICTLY from the
 * session (never request input) — a developer can only set up, read, recover, and
 * audit THEIR OWN key. The design carries the same blind-server guarantee as the
 * capture pipeline: the server stores a key REFERENCE, the developer's recovery
 * posture, and (for recovery_path) an opaque client-wrapped blob — never the
 * capture key, the recovery secret, or the wrapping key. Two hard invariants,
 * enforced here and verified by tests:
 *
 *  1. NO SECRET REACHES THE SERVER. The setup/recovery bodies REJECT any field
 *     that looks like raw key or recovery-secret material — wrapping/unwrapping is
 *     the client's job, so the server can never decrypt captures on its own.
 *
 *  2. NO SILENT RECOVERY. Every recovery action (initiate + the client-reported
 *     outcome) is written to key_recovery_log as visible to the developer and is
 *     surfaced in the developer's own recovery-log view. There is no admin path to
 *     any of this — all access is developer-scoped.
 */

import type {FastifyInstance, FastifyReply} from 'fastify';
import type Database from 'better-sqlite3';
import {requireDeveloperId} from './guards';
import {getDeveloperById} from '../../registry/developers';
import {resolveSetting, setDeveloperPreference} from '../../settings/store';
import {badRequest, asObject, BASE64_RE, validateMetaAllowlist} from './body-validation';
import {RECOVERY_WRAP_ALGO, RECOVERY_KDF} from '../../capture/key-recovery';
import {
    registerKey,
    getKeyRecord,
    getRecoveryMaterial,
    logRecoveryEvent,
    hasOpenRecovery,
    listRecoveryLog,
    type RecoveryChoice,
} from '../../capture/keys-store';

// Fields that would mean the client is shipping material the server must NEVER
// hold: the raw capture key, the recovery secret, or a derived wrapping key.
// Wrapping/unwrapping happens client-side; the server only ever stores the opaque
// already-wrapped blob. Refusing these is a structural guard behind the
// server-cannot-decrypt guarantee, not a content scan.
const FORBIDDEN_SECRET_KEYS = [
    'key',
    'capture_key',
    'recovery_secret',
    'secret',
    'wrapping_key',
    'private_key',
    'plaintext',
    'password',
];

// A wrapped AES-256 key is tiny (~48 bytes); 1 KiB is generous and bounds the
// blind store against an authenticated developer padding it.
const MAX_RECOVERY_BLOB_BYTES = 1024;

// recovery_meta holds only public KDF/cipher params; a few KiB is ample.
const MAX_META_BYTES = 4 * 1024;

const MAX_KEY_ID_LEN = 256;

// Setup/recovery bodies are small; cap the whole request to keep the route from
// buffering anything large into the key tables.
const KEY_BODY_LIMIT = 64 * 1024;

const RECOVERY_CHOICES: readonly RecoveryChoice[] = ['no_recovery', 'recovery_path'];

// The base64 meta fields the client wraps with; validated for shape at setup so a
// broken client can't store un-unwrappable material it only discovers at recovery.
const RECOVERY_META_BASE64_FIELDS = ['salt', 'iv', 'auth_tag'] as const;

/** True when the org currently permits prompt capture for the developer's team. */
function capturePermitted(db: Database.Database, team: string | null): boolean {
    return resolveSetting(db, 'coaching_capture_permitted', team) === true;
}

interface ValidatedSetup {
    keyId: string;
    recoveryChoice: RecoveryChoice;
    recoveryBlob: Buffer | null;
    recoveryMeta: Record<string, unknown> | null;
}

/** Validate the (untrusted) key-setup body. Sends a 400 and returns null on any failure. */
function validateSetup(body: unknown, reply: FastifyReply): ValidatedSetup | null {
    const obj = asObject(body);
    if (!obj) {
        badRequest(reply, 'Request body must be an object');
        return null;
    }

    // Refuse anything that could be raw key or recovery-secret material.
    for (const key of FORBIDDEN_SECRET_KEYS) {
        if (key in obj) {
            badRequest(
                reply,
                `Field '${key}' is not accepted: keys are wrapped client-side and the server never receives key or secret material`,
            );
            return null;
        }
    }

    const keyId = typeof obj.key_id === 'string' ? obj.key_id.trim() : '';
    if (!keyId) {
        badRequest(reply, 'key_id is required');
        return null;
    }
    if (keyId.length > MAX_KEY_ID_LEN) {
        badRequest(reply, `key_id exceeds the ${MAX_KEY_ID_LEN}-character limit`);
        return null;
    }

    if (typeof obj.recovery_choice !== 'string' || !RECOVERY_CHOICES.includes(obj.recovery_choice as RecoveryChoice)) {
        badRequest(reply, 'recovery_choice must be one of: no_recovery, recovery_path');
        return null;
    }
    const recoveryChoice = obj.recovery_choice as RecoveryChoice;

    if (recoveryChoice === 'no_recovery') {
        // INFORMED CONSENT: choosing no_recovery means a lost key is unrecoverable
        // forever. Require an explicit acknowledgement so this can never be the
        // silent/default outcome of a malformed request — the developer must have
        // consciously accepted the tradeoff.
        if (obj.acknowledge_unrecoverable !== true) {
            badRequest(
                reply,
                'no_recovery requires acknowledge_unrecoverable: true — confirm you understand that a lost key makes your captures permanently unrecoverable',
            );
            return null;
        }
        // No recovery material is stored, by design.
        if ('recovery_blob' in obj || 'recovery_meta' in obj) {
            badRequest(reply, 'no_recovery must not include recovery_blob or recovery_meta');
            return null;
        }
        return {keyId, recoveryChoice, recoveryBlob: null, recoveryMeta: null};
    }

    // recovery_path: the client wrapped the capture key and sends the opaque blob
    // + public KDF/cipher meta. The server stores them as-is and can't unwrap.
    if (typeof obj.recovery_blob !== 'string' || !BASE64_RE.test(obj.recovery_blob) || obj.recovery_blob.length % 4 !== 0) {
        badRequest(reply, 'recovery_path requires recovery_blob as a non-empty base64 string');
        return null;
    }
    const recoveryBlob = Buffer.from(obj.recovery_blob, 'base64');
    if (recoveryBlob.length === 0) {
        badRequest(reply, 'recovery_blob must decode to non-empty bytes');
        return null;
    }
    if (recoveryBlob.length > MAX_RECOVERY_BLOB_BYTES) {
        badRequest(reply, `recovery_blob exceeds the ${MAX_RECOVERY_BLOB_BYTES}-byte limit`);
        return null;
    }

    const meta = asObject(obj.recovery_meta);
    if (!meta) {
        badRequest(reply, 'recovery_path requires recovery_meta as an object');
        return null;
    }
    // Allowlist exactly the public KDF/cipher fields, each a non-empty string —
    // so a secret can't be smuggled in under a differently-named or nested field,
    // and the stored meta is always a known, flat, bounded shape. Shared with the
    // capture-ingestion route via validateMetaAllowlist.
    if (!validateMetaAllowlist(meta, ['algo', 'kdf', 'salt', 'iv', 'auth_tag'], 'recovery_meta', MAX_META_BYTES, reply)) {
        return null;
    }
    // Beyond shape, validate the meta DESCRIBES material this server can actually
    // help unwrap later: the algo/kdf must be the ones the client wrapper emits,
    // and salt/iv/auth_tag must be real base64. Without this, a broken client could
    // store `algo: "rot13"` or `salt: "!!!"`, get a green 201, and only discover at
    // recovery time that the key is permanently unrecoverable — defeating the whole
    // point of choosing recovery_path. The server still never decrypts; this only
    // protects the developer's own ability to recover their own data.
    if (meta.algo !== RECOVERY_WRAP_ALGO) {
        badRequest(reply, `recovery_meta.algo must be ${RECOVERY_WRAP_ALGO}`);
        return null;
    }
    if (meta.kdf !== RECOVERY_KDF) {
        badRequest(reply, `recovery_meta.kdf must be ${RECOVERY_KDF}`);
        return null;
    }
    for (const field of RECOVERY_META_BASE64_FIELDS) {
        const v = meta[field] as string;
        if (!BASE64_RE.test(v) || v.length % 4 !== 0) {
            badRequest(reply, `recovery_meta.${field} must be base64`);
            return null;
        }
    }

    return {keyId, recoveryChoice, recoveryBlob, recoveryMeta: meta};
}

export function registerKeyRoutes(app: FastifyInstance, db: Database.Database): void {
    /**
     * Set up (or replace) the developer's capture key record at opt-in: register
     * the key_id and recovery posture. For recovery_path, store the opaque
     * client-wrapped blob; for no_recovery, store nothing recoverable but require
     * an explicit informed-consent acknowledgement. Gated on the org permitting
     * capture at all. Writes the developer's `capture_recovery_choice` preference
     * in sync at write time. (Note: the resolved preference is org-gated, so if the
     * org later disables capture it reports the blockedValue 'no_recovery' while the
     * key record keeps the developer's real posture — they only provably match at
     * the moment of writing, which is the intended behavior.)
     */
    app.post<{Body: unknown}>('/api/me/capture-key', {bodyLimit: KEY_BODY_LIMIT}, async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const userId = request.authUser!.userId;
        const team = getDeveloperById(db, developerId)?.team ?? null;

        if (!capturePermitted(db, team)) {
            return reply.status(403).send({
                error: 'Forbidden',
                code: 'capture_not_permitted',
                message: 'Prompt capture is not permitted by your organization.',
            });
        }

        const valid = validateSetup(request.body, reply);
        if (!valid) {
            return reply;
        }

        // The key record and the mirrored preference must move together: write them
        // in ONE transaction so a failure can't leave the stored posture and the
        // resolved `capture_recovery_choice` preference diverged — the very
        // divergence this sync exists to prevent.
        const record = db.transaction(() => {
            const rec = registerKey(db, {
                developerId,
                keyId: valid.keyId,
                recoveryChoice: valid.recoveryChoice,
                recoveryBlob: valid.recoveryBlob,
                recoveryMeta: valid.recoveryMeta,
            });
            setDeveloperPreference(db, userId, 'capture_recovery_choice', valid.recoveryChoice);
            return rec;
        })();
        return reply.status(201).send({data: record});
    });

    /** The developer's own key record — metadata only, never the wrapped blob/secret. */
    app.get('/api/me/capture-key', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const record = getKeyRecord(db, developerId);
        if (!record) {
            return reply.status(404).send({error: 'Not Found', message: 'No capture key registered'});
        }
        return {data: record};
    });

    /**
     * Initiate recovery (recovery_path only). LOGS recovery_initiated — visible to
     * the developer — and hands back the opaque wrapped blob + meta so the client
     * can unwrap it locally with the developer's recovery secret. For no_recovery
     * (or no key) there is nothing to recover: 409, and no misleading log entry.
     *
     * Policy: the recovery routes (initiate/complete/recovery-log) are DELIBERATELY
     * NOT gated on `capturePermitted`, unlike setup. Recovery only ever operates on
     * the developer's OWN, already-captured, already-encrypted data; if the org
     * later turns capture off, the developer must still be able to recover and audit
     * what was captured while it was on — locking them out of their own data would
     * be the wrong outcome. Setup is gated because it provisions NEW capture; reading
     * back one's existing data is not new capture.
     */
    app.post('/api/me/capture-key/recovery/initiate', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const record = getKeyRecord(db, developerId);
        if (!record) {
            return reply.status(404).send({error: 'Not Found', message: 'No capture key registered'});
        }
        if (record.recoveryChoice !== 'recovery_path') {
            return reply.status(409).send({
                error: 'Conflict',
                code: 'no_recovery_path',
                message: 'You chose no-recovery: there is no recovery material, and your captures cannot be recovered if the key is lost.',
            });
        }
        // Second read of the same row is deliberate: getKeyRecord branches on the
        // posture to produce distinct 404 / no_recovery_path / no_recovery_material
        // codes, while getRecoveryMaterial returns the blob+meta (which getKeyRecord
        // never carries, by the privacy boundary). For a recovery_path record this is
        // expected to be present; the guard covers a torn/legacy row.
        const material = getRecoveryMaterial(db, developerId);
        if (!material) {
            return reply.status(409).send({
                error: 'Conflict',
                code: 'no_recovery_material',
                message: 'No recovery material is available for this key.',
            });
        }
        // Audit BEFORE returning the blob: the recovery attempt is recorded the
        // moment the wrapped material leaves the server, so it can never be handed
        // out without a developer-visible trace.
        const logged = logRecoveryEvent(db, developerId, 'recovery_initiated', request.authUser!.userId);
        return {
            data: {
                event: logged,
                recovery_blob: material.recoveryBlob.toString('base64'),
                recovery_meta: material.recoveryMeta,
            },
        };
    });

    /**
     * Report the outcome of a client-side unwrap. The server can't observe whether
     * the unwrap succeeded (it never holds the secret), so the client reports it
     * and the result is audited — completing the visible recovery trail.
     *
     * Gated by the SAME preconditions as `initiate` (recovery_path key required),
     * AND by an OPEN recovery: an outcome can only be recorded when the developer's
     * latest recovery event is a `recovery_initiated` not yet closed. Without these
     * guards a developer could append `recovery_completed`/`recovery_failed` rows
     * with no preceding initiate — or for a no_recovery/absent key — so the audit
     * (the feature's trust artifact) would no longer faithfully describe real
     * recovery flows. Every logged outcome stays tied to a recovery that was
     * actually initiated.
     */
    app.post<{Body: unknown}>('/api/me/capture-key/recovery/complete', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        const record = getKeyRecord(db, developerId);
        if (!record) {
            return reply.status(404).send({error: 'Not Found', message: 'No capture key registered'});
        }
        if (record.recoveryChoice !== 'recovery_path') {
            return reply.status(409).send({
                error: 'Conflict',
                code: 'no_recovery_path',
                message: 'You chose no-recovery: there is no recovery flow whose outcome could be recorded.',
            });
        }
        const obj = asObject(request.body);
        const outcome = obj?.outcome;
        if (outcome !== 'completed' && outcome !== 'failed') {
            return badRequest(reply, "outcome must be 'completed' or 'failed'") ?? reply;
        }
        const event = outcome === 'completed' ? 'recovery_completed' : 'recovery_failed';
        // Re-check "a recovery is open" and write the outcome in ONE transaction, so
        // exactly one outcome can close one initiate even if two complete requests
        // arrive together: the check-then-insert can't interleave with another's
        // insert. Returns null when there is no open recovery → 409.
        const logged = db.transaction(() => {
            if (!hasOpenRecovery(db, developerId)) {
                return null;
            }
            return logRecoveryEvent(db, developerId, event, request.authUser!.userId);
        })();
        if (!logged) {
            return reply.status(409).send({
                error: 'Conflict',
                code: 'no_recovery_in_progress',
                message: 'No recovery is in progress; initiate a recovery before reporting its outcome.',
            });
        }
        return {data: logged};
    });

    /**
     * The developer's own recovery audit, newest first — "your recovery flow was
     * used on <date>". This is the surface that makes recovery non-silent: it
     * shows every recovery event, since the writer always records them as visible.
     */
    app.get('/api/me/capture-key/recovery-log', async (request, reply) => {
        const developerId = requireDeveloperId(request, reply);
        if (!developerId) {
            return reply;
        }
        return {data: listRecoveryLog(db, developerId)};
    });
}
