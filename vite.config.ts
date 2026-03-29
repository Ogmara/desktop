import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.1.0'),
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
