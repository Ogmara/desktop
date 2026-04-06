/* @refresh reload */
import { render } from 'solid-js/web';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { App } from './App';
import { initI18n } from './i18n/init';
import { initTheme } from './lib/theme';
import { setContractAddress, setKleverNetwork } from './lib/klever';
import { getClient } from './lib/api';
import { getSetting } from './lib/settings';
import './styles/global.css';
import './styles/design-styles.css';

// Override global fetch for external URLs only (bypasses CORS for API calls).
// Internal/local requests (Vite HMR, local assets) use the original browser fetch.
if ((window as any).__TAURI_INTERNALS__) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Use Tauri HTTP plugin for external HTTPS/HTTP URLs (bypasses webview CORS)
    if (url.startsWith('https://') || (url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1'))) {
      // Tauri's HTTP plugin can't handle Blob/File in FormData.
      // Manually build a multipart body with the correct boundary.
      if (init?.body instanceof FormData) {
        return (async () => {
          const randBytes = crypto.getRandomValues(new Uint8Array(16));
          const boundary = '----TauriBoundary' + Array.from(randBytes).map(b => b.toString(16).padStart(2, '0')).join('');
          const parts: Uint8Array[] = [];
          const enc = new TextEncoder();
          for (const [key, value] of (init.body as FormData).entries()) {
            if (value instanceof Blob) {
              const filename = ((value as File).name || 'file').replace(/[\r\n"]/g, '_');
              const mime = value.type || 'application/octet-stream';
              parts.push(enc.encode(
                `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
              ));
              parts.push(new Uint8Array(await value.arrayBuffer()));
              parts.push(enc.encode('\r\n'));
            } else {
              parts.push(enc.encode(
                `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
              ));
            }
          }
          parts.push(enc.encode(`--${boundary}--\r\n`));
          // Concatenate all parts
          const totalLen = parts.reduce((s, p) => s + p.length, 0);
          const body = new Uint8Array(totalLen);
          let offset = 0;
          for (const p of parts) { body.set(p, offset); offset += p.length; }
          const headers = { ...(init.headers as Record<string, string> || {}) };
          headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
          return (tauriFetch as any)(input, { ...init, body, headers });
        })();
      }
      return (tauriFetch as any)(input, init);
    }
    // Use native browser fetch for local/internal requests
    return originalFetch(input, init);
  };
}

// Initialize i18n before rendering
initI18n();

// Apply theme before first paint (prevents flash)
initTheme();

// Apply compact layout class if saved
if (getSetting('compactLayout')) {
  document.documentElement.classList.add('compact');
}

// Auth + WebSocket initialization happens in App.tsx after vault migrations.
// We start WS here only as a fallback for the no-wallet case.
// App.tsx calls initAuth() after runVaultMigrations(), then the WS
// connection is properly started with the signer if available.

// Fetch node config for on-chain operations (contract address + network)
getClient().networkStats().then((stats: any) => {
  if (stats?.contract_address) setContractAddress(stats.contract_address);
  if (stats?.network) setKleverNetwork(stats.network);
}).catch(() => { /* node may be unreachable at startup */ });

// Disable native browser context menu globally so only in-app right-click menus appear.
// Allow native context menu on text inputs/textareas for paste/spellcheck.
document.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  e.preventDefault();
});

const root = document.getElementById('root');
if (root) {
  render(() => <App />, root);
}
