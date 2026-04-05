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
      '@noble/ed25519': path.resolve(__dirname, 'node_modules/@noble/ed25519/index.js'),
      '@noble/hashes': path.resolve(__dirname, 'node_modules/@noble/hashes'),
    },
  },
  // Tauri expects a fixed port during dev
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
  // Prevent vite from obscuring Rust errors
  clearScreen: false,
});
