import {describe, it, expect} from 'vitest';
import {
    checkMissingContext,
    checkMissingError,
    checkShortPrompt,
    DEFAULT_NUDGE_CONFIG,
    runStructuralChecks,
} from '../../../src/coaching/realtime/nudges';

describe('structural nudges — each condition (Task 5.6)', () => {
    describe('short_prompt', () => {
        it('fires when the prompt is below the length threshold', () => {
            const n = checkShortPrompt('fix this', DEFAULT_NUDGE_CONFIG);
            expect(n?.type).toBe('short_prompt');
            expect(n?.dismissible).toBe(true);
        });
        it('does not fire for a sufficiently long prompt', () => {
            expect(checkShortPrompt('please walk me through how the retry backoff is configured', DEFAULT_NUDGE_CONFIG)).toBeNull();
        });
    });

    describe('missing_context', () => {
        it('fires when the prompt is about code but includes none', () => {
            expect(checkMissingContext('why is this function returning undefined every time')?.type).toBe('missing_context');
        });
        it('does not fire when code is included (a code fence)', () => {
            expect(checkMissingContext('why does this function fail\n```ts\nfn()\n```')).toBeNull();
        });
        it('does not fire when a file reference is included', () => {
            expect(checkMissingContext('the function in src/server.ts throws on boot')).toBeNull();
        });
        it('does not fire for a prompt that is not about code', () => {
            expect(checkMissingContext('what is a good name for a pet rabbit')).toBeNull();
        });
    });

    describe('missing_error', () => {
        it('fires when the prompt describes an error but includes none', () => {
            expect(checkMissingError('the build keeps failing on my machine and i am stuck')?.type).toBe('missing_error');
        });
        it('does not fire when error output is included (inline)', () => {
            expect(checkMissingError('the build fails with `TypeError: x is not a function`')).toBeNull();
        });
        it('does not fire when a typed error label is present', () => {
            expect(checkMissingError('it crashes — NullPointerException: cannot read id')).toBeNull();
        });
        it('does not fire for a prompt that is not about an error', () => {
            expect(checkMissingError('summarize the quarterly report in three bullets')).toBeNull();
        });
    });

    it('runStructuralChecks returns applicable nudges in a stable order', () => {
        // Short AND about code without code → two nudges, short first.
        const nudges = runStructuralChecks('fix the bug');
        expect(nudges.map((n) => n.type)).toEqual(['short_prompt']);
        const longerNoCode = runStructuralChecks('please explain why this api endpoint keeps returning a 500 error');
        // Long enough; about code w/o code AND about an error w/o error text.
        expect(longerNoCode.map((n) => n.type)).toEqual(['missing_context', 'missing_error']);
    });

    it('a well-formed prompt with code and error output produces no nudges', () => {
        const good = 'The endpoint in src/api.ts throws:\n```\nError: ECONNREFUSED 127.0.0.1:5432\n```\nWhat is the fix?';
        expect(runStructuralChecks(good)).toEqual([]);
    });
});
