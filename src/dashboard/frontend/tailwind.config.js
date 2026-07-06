/** @type {import('tailwindcss').Config} */
// Design tokens are defined once as CSS variables in src/index.css (light +
// dark values) and surfaced to Tailwind here. Components reference semantic
// names (bg-surface, text-muted, text-accent, ...) — never raw hex — so the
// palette stays centralized and dark mode is a single class swap on <html>.
const path = require('node:path');

const withAlpha = (variable) => `rgb(var(${variable}) / <alpha-value>)`;

// Absolute globs: `vite build` runs from the project root, so cwd-relative
// content paths would scan the wrong tree.
module.exports = {
    darkMode: 'class',
    content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{ts,tsx}')],
    theme: {
        extend: {
            colors: {
                canvas: withAlpha('--color-canvas'),
                surface: withAlpha('--color-surface'),
                'surface-raised': withAlpha('--color-surface-raised'),
                border: withAlpha('--color-border'),
                foreground: withAlpha('--color-foreground'),
                muted: withAlpha('--color-muted'),
                accent: withAlpha('--color-accent'),
                'accent-soft': withAlpha('--color-accent-soft'),
                primary: withAlpha('--color-primary'),
                'primary-soft': withAlpha('--color-primary-soft'),
                success: withAlpha('--color-success'),
                warning: withAlpha('--color-warning'),
                danger: withAlpha('--color-danger'),
            },
            fontFamily: {
                // Inter everywhere. `display` is kept as a semantic alias (used by
                // headings) but now resolves to Inter, so the app uses one family.
                display: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
                sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
            },
            borderRadius: {
                card: '0.75rem',
            },
            boxShadow: {
                card: '0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(0 0 0 / 0.12)',
            },
        },
    },
    plugins: [],
};
