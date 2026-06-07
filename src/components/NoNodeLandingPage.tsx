/**
 * NoNodeLandingPage — shown when the app has no L2 node connected.
 *
 * Two states, driven by the reactive `getLastBootstrapResult()`:
 *   - boot still running (`null`)        → a calm "connecting…" screen
 *   - boot finished, no node found       → an informative landing page with
 *                                          a manual-connect field + retry
 *
 * This replaces the Sidebar + router entirely (so the News view never mounts
 * and can't surface the misleading `Unexpected token '<' … not valid JSON`
 * error from fetching against an empty node URL). On mainnet a fresh install
 * legitimately finds no nodes yet — this state should read as intentional,
 * not broken.
 */

import { Component, createSignal, Show, onMount, onCleanup } from 'solid-js';
import { pingNode, validateNodeUrl } from '@ogmara/sdk';
import { t } from '../i18n/init';
import { getLastBootstrapResult, switchNode, bootstrapNodeSelection } from '../lib/api';
import { invoke } from '@tauri-apps/api/core';

const OFFICIAL_SITE = 'https://ogmara.org';

export const NoNodeLandingPage: Component = () => {
  const [url, setUrl] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false);

  // null while boot is still pinging candidates; a result (reason
  // 'no-candidates') once it has given up.
  const booting = () => getLastBootstrapResult() === null;

  const handleConnect = async () => {
    if (busy()) return; // re-entrancy guard (Enter + click)
    const raw = url().trim();
    if (!raw) return;
    setError('');
    let u = raw.replace(/\/$/, '');
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    // Use the canonicalized ORIGIN the validator returns — it strips any
    // userinfo (user:pass@), path, and query, so we never persist credentials
    // or a path-bearing string as the API base.
    const validated = validateNodeUrl(u, { allowPrivateHosts: true });
    if (!validated) {
      setError(t('landing_node_invalid') || 'That doesn’t look like a valid node URL.');
      return;
    }
    setBusy(true);
    const ping = await pingNode(validated, 5000, { allowPrivateHosts: true }).catch(() => Infinity);
    setBusy(false);
    if (ping === Infinity) {
      setError(t('landing_node_unreachable') || 'Couldn’t reach that node. Check the URL and try again.');
      return;
    }
    // Reachable → switch (persists + reloads; boot then honors it explicitly).
    switchNode(validated);
  };

  const handleRetry = async () => {
    if (retrying()) return;
    setRetrying(true);
    setError('');
    try {
      await bootstrapNodeSelection();
      // If a node was found, `bootstrapNodeSelection` lands it via
      // switchNodeSilent → `activeNodeUrl()` updates → the App gate swaps this
      // screen out for the real app. If not, we stay here.
    } finally {
      setRetrying(false);
    }
  };

  // Auto-retry discovery with exponential backoff while we're in the "no node
  // found" terminal state (spec 05-clients §1.1). Self-heals: when a node comes
  // online, bootstrap lands it, `activeNodeUrl()` flips, and the App gate
  // unmounts this screen — onCleanup then clears the timer.
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 5000;
  onMount(() => {
    const tick = async () => {
      // Skip while boot is still on its first pass, or a manual retry is running.
      if (getLastBootstrapResult() !== null && !retrying()) {
        await bootstrapNodeSelection().catch(() => {});
      }
      backoff = Math.min(Math.round(backoff * 1.8), 60000);
      retryTimer = setTimeout(tick, backoff);
    };
    retryTimer = setTimeout(tick, backoff);
  });
  onCleanup(() => { if (retryTimer) clearTimeout(retryTimer); });

  return (
    <div class="nonode-screen">
      <div class="nonode-card">
        <svg class={`nonode-logo ${booting() || retrying() ? 'spin' : ''}`} viewBox="0 0 512 512" width="84" height="84">
          <defs>
            <linearGradient id="nnbg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#0f0f1a" />
              <stop offset="100%" stop-color="#1a0f2e" />
            </linearGradient>
            <linearGradient id="nng" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#a855f7" />
              <stop offset="50%" stop-color="#6366f1" />
              <stop offset="100%" stop-color="#3b82f6" />
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="96" fill="url(#nnbg)" />
          <circle cx="256" cy="256" r="120" fill="none" stroke="url(#nng)" stroke-width="36" stroke-linecap="round" stroke-dasharray="300 50 200 50" transform="rotate(-30 256 256)" />
        </svg>

        <Show
          when={!booting()}
          fallback={
            <>
              <h2 class="nonode-title">{t('landing_connecting_title') || 'Connecting to the network…'}</h2>
              <p class="nonode-sub">{t('landing_connecting_sub') || 'Looking for an available Ogmara node.'}</p>
            </>
          }
        >
          <h2 class="nonode-title">{t('landing_no_node_title') || 'No node connected'}</h2>
          <p class="nonode-sub">
            {t('landing_no_node_desc') ||
              'Ogmara runs on a network of independent nodes. None could be reached right now — the network may still be coming online, or you may be offline.'}
          </p>

          <div class="nonode-form">
            <label class="nonode-label">{t('landing_add_node_label') || 'Know a node? Connect to it directly:'}</label>
            <div class="nonode-row">
              <input
                class="nonode-input"
                type="text"
                inputmode="url"
                autocapitalize="off"
                spellcheck={false}
                placeholder={t('landing_node_url_placeholder') || 'https://node.example.com'}
                value={url()}
                onInput={(e) => { setUrl(e.currentTarget.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(); }}
                disabled={busy()}
              />
              <button class="nonode-btn nonode-btn-primary" onClick={handleConnect} disabled={busy() || !url().trim()}>
                {busy() ? (t('landing_connecting_short') || 'Connecting…') : (t('landing_connect_cta') || 'Connect')}
              </button>
            </div>
            <Show when={error()}>
              <div class="nonode-error">{error()}</div>
            </Show>
          </div>

          <div class="nonode-actions">
            <button class="nonode-btn nonode-btn-ghost" onClick={handleRetry} disabled={retrying()}>
              {retrying() ? (t('landing_retrying') || 'Retrying…') : (t('landing_retry_cta') || 'Retry discovery')}
            </button>
            <button class="nonode-btn nonode-btn-ghost" onClick={() => { invoke('open_url', { url: OFFICIAL_SITE }).catch(() => {}); }}>
              {t('landing_learn_more') || 'Learn more'}
            </button>
          </div>
        </Show>
      </div>

      <style>{`
        .nonode-screen {
          flex: 1; min-height: 0;
          display: flex; align-items: center; justify-content: center;
          background: var(--color-bg-primary);
          padding: var(--spacing-lg);
          overflow: auto;
        }
        .nonode-card {
          width: 100%; max-width: 480px;
          display: flex; flex-direction: column; align-items: center;
          gap: var(--spacing-md); text-align: center;
        }
        .nonode-logo { margin-bottom: var(--spacing-sm); }
        .nonode-logo.spin { animation: nonode-spin 1.4s linear infinite; transform-origin: 50% 50%; }
        @keyframes nonode-spin { to { transform: rotate(360deg); } }
        .nonode-title { font-size: var(--font-size-xl); font-weight: 700; color: var(--color-text-primary); margin: 0; }
        .nonode-sub { font-size: var(--font-size-sm); color: var(--color-text-secondary); line-height: 1.6; margin: 0; max-width: 420px; }
        .nonode-form { width: 100%; margin-top: var(--spacing-md); display: flex; flex-direction: column; gap: var(--spacing-xs); text-align: left; }
        .nonode-label { font-size: var(--font-size-xs); color: var(--color-text-secondary); font-weight: 600; }
        .nonode-row { display: flex; gap: var(--spacing-sm); }
        .nonode-input {
          flex: 1; min-width: 0;
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          color: var(--color-text-primary);
          font-size: var(--font-size-sm);
        }
        .nonode-input:focus { outline: none; border-color: var(--color-accent-primary); }
        .nonode-btn {
          padding: var(--spacing-sm) var(--spacing-lg);
          border-radius: var(--radius-md);
          font-weight: 600; font-size: var(--font-size-sm);
          cursor: pointer; white-space: nowrap;
        }
        .nonode-btn:disabled { opacity: 0.5; cursor: default; }
        .nonode-btn-primary { background: var(--color-accent-primary); color: var(--color-text-inverse); border: none; }
        .nonode-btn-primary:not(:disabled):hover { opacity: 0.9; }
        .nonode-btn-ghost { background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border); }
        .nonode-btn-ghost:not(:disabled):hover { color: var(--color-text-primary); border-color: var(--color-accent-primary); }
        .nonode-error { font-size: var(--font-size-xs); color: var(--color-error); margin-top: var(--spacing-xs); }
        .nonode-actions { display: flex; gap: var(--spacing-sm); margin-top: var(--spacing-md); }
      `}</style>
    </div>
  );
};
