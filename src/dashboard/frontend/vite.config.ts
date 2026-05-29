import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The app is served by Fastify under /dashboard, so all asset URLs must be
// prefixed accordingly. `root` is pinned to this directory so the build works
// regardless of the cwd the npm script is invoked from.
const root = __dirname;

export default defineConfig({
    root,
    base: '/dashboard/',
    plugins: [react()],
    build: {
        outDir: path.resolve(root, 'dist'),
        emptyOutDir: true,
        sourcemap: true,
    },
    server: {
        port: 5173,
        // Proxy API + health calls to the Fastify backend during `vite` HMR dev.
        proxy: {
            '/api': 'http://localhost:8080',
            '/health': 'http://localhost:8080',
        },
    },
});
