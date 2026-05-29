/// <reference types="vite/client" />

// Augments Vite's built-in ImportMetaEnv with this app's custom vars.
interface ImportMetaEnv {
    readonly VITE_API_BASE?: string;
}
