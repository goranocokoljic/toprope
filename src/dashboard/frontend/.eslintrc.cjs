// ESLint config for the React dashboard. The backend lint (root .eslintrc.json)
// excludes this tree because it uses a different tsconfig (DOM libs, JSX, ESM)
// and needs React-specific rules — most importantly react-hooks, which catches
// the highest-frequency real React bug (incorrect/missing hook deps) that tsc
// cannot. Run via `npm run lint:web`.
module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        ecmaFeatures: {jsx: true},
    },
    env: {browser: true, es2022: true},
    plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended'],
    rules: {
        '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
        '@typescript-eslint/no-explicit-any': 'error',
        // Co-locating the theme context with its provider is intentional; warn
        // rather than error so it doesn't block the build.
        'react-refresh/only-export-components': ['warn', {allowConstantExport: true}],
    },
    ignorePatterns: ['dist/', 'vite.config.ts', '*.cjs', '*.config.js'],
};
