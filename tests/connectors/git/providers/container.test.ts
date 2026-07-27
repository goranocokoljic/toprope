import {describe, it, expect} from 'vitest';
import fs from 'fs';
import path from 'path';
import {
    isBlankContainer,
    normalizeContainer,
    sameContainer,
} from '../../../../src/connectors/git/providers/container';

/**
 * The shared container normalization (#266) — the ONE definition of how a provider
 * container is spelled, used by the server's duplicate guard and by the admin bundle's
 * inline "already taken" affordance.
 *
 * These assertions are deliberately about the exact spellings the issue names: the four
 * variants of one real workspace that used to create four independent, double-counting data
 * sets under `UNIQUE(type, container)`.
 */
describe('normalizeContainer (#266)', () => {
    it('collapses the case/whitespace variants of one workspace onto one spelling', () => {
        const variants = [
            'Wireless_Media',
            'wireless_media',
            'WIRELESS_MEDIA',
            'Wireless_Media ',
            ' Wireless_Media',
            '\tWireless_Media\n',
        ];
        for (const variant of variants) {
            expect(normalizeContainer(variant)).toBe('wireless_media');
        }
        // …and therefore every pair of them compares equal.
        for (const a of variants) {
            for (const b of variants) {
                expect(sameContainer(a, b)).toBe(true);
            }
        }
    });

    it('keeps genuinely different containers distinct', () => {
        expect(sameContainer('acme', 'acme-2')).toBe(false);
        expect(sameContainer('acme', 'acme_')).toBe(false);
        // Inner whitespace is NOT stripped — only surrounding. `a b` and `ab` are two names.
        expect(normalizeContainer(' a b ')).toBe('a b');
        expect(sameContainer('a b', 'ab')).toBe(false);
    });

    it('is idempotent, so re-applying it defensively at the write boundary is safe', () => {
        for (const raw of ['Wireless_Media ', 'acme', '', '  ', 'MiXeD-Case']) {
            expect(normalizeContainer(normalizeContainer(raw))).toBe(normalizeContainer(raw));
        }
    });

    it('is locale-independent (a Turkish locale must not fork the stored value)', () => {
        // toLowerCase(), not toLocaleLowerCase(): 'I' must always become 'i', never 'ı'.
        expect(normalizeContainer('INFRA')).toBe('infra');
        expect(normalizeContainer('INFRA')).not.toContain('ı');
    });

    it('has NO imports, which is what lets the React admin bundle share it (AC9)', () => {
        // The whole "one normalization rule, not two" property rests on this file being safe to
        // import from `src/dashboard/frontend/src/**`. A single `import ... from './types.js'`
        // would either break the Vite build or drag the server graph into the browser bundle —
        // and the local convention in `providers/` IS `.js`-suffixed relative specifiers, so that
        // edit is one keystroke away. Only `npm run build:web` would otherwise catch it; this
        // fails in `npm test`, where the mistake is actually made.
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../../../src/connectors/git/providers/container.ts'),
            'utf-8',
        );
        expect(source).not.toMatch(/^\s*import\s/m);
        expect(source).not.toMatch(/\brequire\s*\(/);
    });

    it('treats blank, whitespace-only and absent containers as blank', () => {
        expect(isBlankContainer('')).toBe(true);
        expect(isBlankContainer('   ')).toBe(true);
        expect(isBlankContainer('\t\n')).toBe(true);
        expect(isBlankContainer('acme')).toBe(false);
        // Total over the UNVALIDATED config entries `resolveGitProviderConfigs` passes
        // through: absent, null, or (from YAML) not even a string.
        expect(normalizeContainer(undefined)).toBe('');
        expect(normalizeContainer(null)).toBe('');
        expect(normalizeContainer(42 as unknown as string)).toBe('');
        expect(isBlankContainer(undefined)).toBe(true);
        expect(sameContainer(undefined, null)).toBe(true);
        expect(sameContainer(undefined, 'acme')).toBe(false);
    });
});
