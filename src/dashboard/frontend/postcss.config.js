const path = require('node:path');

// `vite build` runs from the project root, but Tailwind resolves its config
// from cwd by default — so point it explicitly at the config in this folder.
module.exports = {
    plugins: {
        tailwindcss: {config: path.join(__dirname, 'tailwind.config.js')},
        autoprefixer: {},
    },
};
