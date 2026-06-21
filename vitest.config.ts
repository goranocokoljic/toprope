import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        // Backend tests run in node; the React dashboard tests need a DOM.
        // Frontend tests import their own setup (src/dashboard/frontend/src/test/
        // setup.ts) directly, so backend node tests don't load DOM polyfills.
        environment: 'node',
        environmentMatchGlobs: [['**/dashboard/frontend/**', 'jsdom']],
        coverage: {
            provider: 'v8',
            // Per-changed-file thresholds are enforced by the dev-cycle skill's
            // Phase 4 gate (reading this table), not by a repo-wide config
            // threshold — a global threshold would retroactively fail the
            // existing suite. 'text' prints the per-file table the gate reads.
            reporter: ['text', 'text-summary', 'html'],
            include: ['src/**'],
            exclude: [
                'src/**/*.d.ts',
                'src/**/*.test.ts',
                'src/**/*.test.tsx',
                'src/dashboard/frontend/dist/**',
                'src/dashboard/frontend/**/test/**',
            ],
        },
    },
});
