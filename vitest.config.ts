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
    },
});
