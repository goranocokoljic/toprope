import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        // Backend tests run in node; the React dashboard tests need a DOM.
        environment: 'node',
        environmentMatchGlobs: [['**/dashboard/frontend/**', 'jsdom']],
        setupFiles: ['src/dashboard/frontend/src/test/setup.ts'],
    },
});
