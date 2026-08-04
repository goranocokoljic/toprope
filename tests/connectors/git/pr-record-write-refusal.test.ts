/**
 * #307 — `isUnstorablePRFieldError`'s discrimination, at the unit level.
 *
 * The PR-record skip is now decided by CATCHING the write's error and asking this predicate
 * whether it is an unstorable-field bind (skip) or a genuine failure (rethrow → roll the run
 * back). Two of its shapes are driven end to end in `unwritable-author-days.test.ts`, but the
 * design decisions the narrowing rests on are not reachable through the pipeline:
 *
 *   - the single-object `"Too few parameter values"` branch — the only object-valued PR fixture
 *     binds TWO objects (`merged_at` and `closed_at` are coupled), so it hits the two-object
 *     TypeError branch, never the single-object RangeError one;
 *   - the message-vs-class decision — the whole reason this matches {@link DRIVER_VALUE_BIND_RE}
 *     rather than a bare `RangeError`/`TypeError` class is that the driver throws the SAME classes
 *     (uncoded) for LIFECYCLE faults that must NOT be swallowed; no pipeline path produces one.
 *
 * So the positives are driven through the REAL better-sqlite3 binding layer (pinning the driver's
 * actual messages, so a version reword that broke the regex fails here), and the negatives — the
 * lifecycle throws — are synthetic. Revert `DRIVER_VALUE_BIND_RE.test(...)` to a bare class match,
 * or drop `too few parameter values|` from the regex, and a test here goes red.
 */
import {describe, it, expect, afterEach} from 'vitest';
import Database from 'better-sqlite3';
import {isUnstorablePRFieldError} from '../../../src/connectors/git/sync';

/**
 * The REAL error better-sqlite3 throws for a positional bind of `args` against a 3-column
 * statement whose middle column is `NOT NULL`. Pins the driver's actual message/class so the
 * predicate is tested against what the write really raises, not a hand-copied string.
 */
function realBindError(args: unknown[]): unknown {
    const db = new Database(':memory:');
    try {
        db.exec('CREATE TABLE t (a TEXT, b TEXT NOT NULL, c TEXT)');
        const stmt = db.prepare('INSERT INTO t (a, b, c) VALUES (?, ?, ?)');
        try {
            (stmt.run as (...a: unknown[]) => unknown)(...args);
            throw new Error('expected the bind to throw');
        } catch (e) {
            return e;
        }
    } finally {
        db.close();
    }
}

describe('isUnstorablePRFieldError — the PR-write skip discrimination (#307)', () => {
    afterEach(() => {
        // nothing persistent; realBindError closes its own db.
    });

    describe('SKIPS a genuinely unstorable field value (returns true)', () => {
        it('null into a NOT NULL column → SQLITE_CONSTRAINT_NOTNULL', () => {
            const err = realBindError(['x', null, 'y']);
            expect((err as {code?: string}).code).toBe('SQLITE_CONSTRAINT_NOTNULL');
            expect(isUnstorablePRFieldError(err)).toBe(true);
        });

        it('undefined into a NOT NULL column → SQLITE_CONSTRAINT_NOTNULL', () => {
            const err = realBindError(['x', undefined, 'y']);
            expect((err as {code?: string}).code).toBe('SQLITE_CONSTRAINT_NOTNULL');
            expect(isUnstorablePRFieldError(err)).toBe(true);
        });

        it('ONE object-valued field → RangeError "Too few parameter values" (the branch no fixture reaches)', () => {
            // Exactly one object among the positional args — the production shape when a single PR
            // date field is object-valued and its siblings are strings/null. Dropping
            // `too few parameter values|` from DRIVER_VALUE_BIND_RE makes this return false.
            const err = realBindError(['x', 'ok', {}]);
            expect(err).toBeInstanceOf(RangeError);
            expect(isUnstorablePRFieldError(err)).toBe(true);
        });

        it('TWO object-valued fields → TypeError "named parameters in two different objects"', () => {
            const err = realBindError(['x', {}, {}]);
            expect(err).toBeInstanceOf(TypeError);
            expect(isUnstorablePRFieldError(err)).toBe(true);
        });

        it('a symbol → TypeError "can only bind …"', () => {
            const err = realBindError(['x', Symbol('s') as never, 'y']);
            expect(err).toBeInstanceOf(TypeError);
            expect(isUnstorablePRFieldError(err)).toBe(true);
        });
    });

    describe('RETHROWS a non-refusal failure (returns false — the run must fail loudly)', () => {
        it('any other SQLITE_* code — trigger, FK, BUSY — is a genuine failure', () => {
            for (const code of ['SQLITE_CONSTRAINT_TRIGGER', 'SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_BUSY', 'SQLITE_IOERR']) {
                expect(isUnstorablePRFieldError(new Database.SqliteError('boom', code))).toBe(false);
            }
        });

        it('a driver LIFECYCLE RangeError/TypeError of the same class as a bind error is NOT swallowed', () => {
            // These are the exact messages a bare `instanceof RangeError || TypeError` match would
            // wrongly absorb as a skip. Matching the MESSAGE positively is the whole point.
            expect(isUnstorablePRFieldError(new RangeError('Too many parameter values were provided'))).toBe(false);
            expect(isUnstorablePRFieldError(new TypeError('The database connection is not open'))).toBe(false);
            expect(isUnstorablePRFieldError(new TypeError('This database connection is busy executing a query'))).toBe(false);
        });

        it('an own-code Error with a non-bind message rethrows', () => {
            expect(isUnstorablePRFieldError(new Error('Cannot read properties of undefined'))).toBe(false);
            expect(isUnstorablePRFieldError(new TypeError('foo.map is not a function'))).toBe(false);
        });

        it('a non-Error operand is never a skip', () => {
            for (const v of ['SQLITE_CONSTRAINT_NOTNULL', null, undefined, 42, {code: 'SQLITE_CONSTRAINT_NOTNULL'}]) {
                expect(isUnstorablePRFieldError(v)).toBe(false);
            }
        });
    });
});
