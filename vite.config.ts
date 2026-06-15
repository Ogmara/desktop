import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import path from 'path';

export default defineConfig({
  plugins: [solidPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.1.0'),
  },
  resolve: {
    alias: {
      // Force Vite to use the local node_modules version of @noble packages,
      // not a stale system-level ~/node_modules version missing async APIs.
      // @ogmara/sdk is linked via `file:` (a symlink), so resolution of its
      // @noble imports starts from the SDK's real path — OUTSIDE this app's
      // node_modules — and fails. Aliasing pins them to the app's copy.
      // @noble/ciphers (XChaCha20 for E2E DM/channel/media content, incl. P5
      // encrypted media) needs the same treatment as ed25519/hashes.
      '@noble/ed25519': path.resolve(__dirname, 'node_modules/@noble/ed25519/index.js'),
      '@noble/hashes': path.resolve(__dirname, 'node_modules/@noble/hashes'),
      '@noble/ciphers': path.resolve(__dirname, 'node_modules/@noble/ciphers'),
    },
  },
  // Tauri expects a fixed port during dev
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    // This is a Tauri app — assets load from the local app bundle, not over
    // the network, so the default 500 kB chunk-size advisory isn't
    // actionable here. Raise it past the app chunk so the build output stays
    // clean (the vendor split below is still worthwhile for cache locality).
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split third-party code out of the app bundle so app-code edits
        // don't bust the (large, stable) vendor cache. Groups by
        // change-cadence: `solid` (framework), `sdk` (@ogmara/sdk),
        // `vendor` (crypto/msgpack/i18n/etc.).
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('solid-js') || id.includes('vite-plugin-solid')) return 'solid';
          if (id.includes('@ogmara') || id.includes('/sdk-js/')) return 'sdk';
          return 'vendor';
        },
      },
    },
  },
  // Prevent vite from obscuring Rust errors
  clearScreen: false,
});
