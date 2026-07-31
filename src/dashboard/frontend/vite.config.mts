import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The app is served by Fastify under /dashboard, so all asset URLs must be
// prefixed accordingly. `root` is pinned to this directory so the build works
// regardless of the cwd the npm script is invoked from.
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root,
    base: '/dashboard/',
    plugins: [react()],
    build: {
        outDir: path.resolve(root, 'dist'),
        emptyOutDir: true,
        // The /dashboard shell is served publicly (auth-exempt), so don't ship
        // source maps that would expose the unminified frontend source.
        sourcemap: false,
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
