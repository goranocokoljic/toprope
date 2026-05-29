// Test environment polyfills. jsdom does not implement ResizeObserver, which
// Recharts' ResponsiveContainer relies on; provide a no-op so charts mount.
// Guarded so this is harmless in the node (backend) test environment too.
if (typeof globalThis.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    }
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
