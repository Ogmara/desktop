/**
 * NodeSelector — dropdown for choosing L2 node with ping display.
 *
 * Discovers available nodes, measures latency, and lets the user
 * pick which node to connect to. Remembers selection in settings.
 */

import { Component, createResource, createSignal, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getCurrentNodeUrl, getAvailableNodes, switchNode, removeKnownNode, getKnownNodes } from '../lib/api';
import { DEFAULT_NODE_URL } from '@ogmara/sdk';
import type { NodeWithPing } from '@ogmara/sdk';
import { pingNode, validateNodeUrl } from '@ogmara/sdk';
import { AnchorBadge } from './AnchorBadge';

export const NodeSelector: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [currentUrl, setCurrentUrl] = createSignal(getCurrentNodeUrl());
  const [manualUrl, setManualUrl] = createSignal('');
  const [addError, setAddError] = createSignal('');
  const [adding, setAdding] = createSignal(false);

  const [nodes, { refetch }] = createResource(async () => {
    return getAvailableNodes();
  });

  const handleSelect = (url: string) => {
    switchNode(url);
    setCurrentUrl(url);
    setOpen(false);
  };

  const handleRefresh = () => {
    refetch();
  };

  /** Try to add a manually-entered URL.
   *
   *  We do a raw `fetch(${url}/api/v1/health)` here BEFORE handing off
   *  to `pingNode` so we can surface the actual failure to the user.
   *  `pingNode` collapses every error class (DNS, TLS, CORS, malformed
   *  JSON, …) into `Infinity`, which made every failure render as the
   *  same generic "couldn't reach" string with no clue what to fix.
   *
   *  Desktop opts into `allowPrivateHosts: true` so LAN URLs survive
   *  the SDK's SSRF guard. */
  const tryAddManual = async () => {
    const raw = manualUrl().trim();
    if (!raw) return;
    setAddError('');
    setAdding(true);
    try {
      // Normalize: strip trailing slash + auto-prefix http:// for
      // bare host:port input.
      let url = raw.replace(/\/$/, '');
      if (!/^https?:\/\//i.test(url)) {
        url = `http://${url}`;
      }

      // SSRF guard check (LAN allowed on desktop).
      if (!validateNodeUrl(url, { allowPrivateHosts: true })) {
        setAddError(
          t('node_add_failed_invalid_url') ||
            `Invalid URL: ${url}. Must be http(s) and under 256 chars.`,
        );
        return;
      }

      // Raw fetch — capture the actual error class.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      let resp: Response;
      try {
        resp = await fetch(`${url}/api/v1/health`, { signal: controller.signal });
      } catch (e: any) {
        clearTimeout(timeoutId);
        // Fetch threw — DNS / network / TLS / CORS-without-headers.
        const msg = e?.message || String(e);
        // The two most common Tauri/WebKit cases get specific hints.
        let hint = '';
        if (/SSL|TLS|HTTPS|wrong version/i.test(msg)) {
          hint = ' Looks like a TLS handshake failure — most L2 nodes serve plain HTTP on :41721. Try the same URL with `http://`.';
        } else if (/CORS|Access-Control/i.test(msg)) {
          hint = ` CORS rejected by the node. On the Odroid, set \`cors_origins = ["*"]\` in [api] of ogmara.toml and restart.`;
        } else if (/Failed to fetch|NetworkError|name not resolved|getaddrinfo/i.test(msg)) {
          hint = ` Network / DNS error. From this machine, can you \`curl ${url}/api/v1/health\`? If yes but the app can't, it's probably a webview DNS scope issue.`;
        }
        setAddError(`Fetch failed: ${msg}.${hint}`);
        return;
      }
      clearTimeout(timeoutId);

      if (!resp.ok) {
        setAddError(`Node returned HTTP ${resp.status} for /api/v1/health. The URL is probably not an Ogmara L2 node.`);
        return;
      }
      let body: any;
      try {
        body = await resp.json();
      } catch (e: any) {
        setAddError(`Response wasn't JSON — that URL doesn't look like an L2 node /api/v1/health endpoint.`);
        return;
      }
      if (!body || typeof body.version !== 'string') {
        setAddError(`Response had no \`version\` field — that URL doesn't look like an L2 node.`);
        return;
      }

      // All good — commit.
      handleSelect(url);
      setManualUrl('');
    } catch (e: any) {
      setAddError(`Unexpected error: ${e?.message || String(e)}`);
    } finally {
      setAdding(false);
    }
  };

  const pingLabel = (ping: number) => {
    if (ping < 100) return 'fast';
    if (ping < 300) return 'ok';
    return 'slow';
  };

  const pingColor = (ping: number) => {
    if (ping < 100) return 'var(--color-success, #22c55e)';
    if (ping < 300) return 'var(--color-warning, #eab308)';
    return 'var(--color-error, #ef4444)';
  };

  return (
    <div class="node-selector">
      <button class="node-current" onClick={() => {
        // Refresh when OPENING the dropdown so the user sees fresh
        // ping times + any newly-added node. The previous expression
        // — `if (!open()) handleRefresh()` — actually refreshed on
        // CLOSE (because setOpen had already flipped the signal),
        // which is why a manually-added node only appeared on the
        // second open attempt.
        const willOpen = !open();
        setOpen(willOpen);
        if (willOpen) handleRefresh();
      }}>
        <span class="node-dot" />
        <span class="node-url">{currentUrl().replace(/^https?:\/\//, '')}</span>
        <span class="node-arrow">{open() ? '▲' : '▼'}</span>
      </button>

      <Show when={open()}>
        <div class="node-dropdown">
          <div class="node-dropdown-header">
            <span>{t('settings_node_url')}</span>
            <button class="node-refresh" onClick={handleRefresh}>↻</button>
          </div>
          <Show when={!nodes.loading} fallback={<div class="node-loading">{t('loading')}</div>}>
            <For each={nodes()}>
              {(node: NodeWithPing) => {
                // Show the ✕ button only on entries the user manually
                // added. Discovered entries, the default, and the
                // currently-selected node don't get a remove control —
                // there's no useful state to remove for those (the
                // default re-appears from `getAvailableNodes` and the
                // current one is what's actually in use).
                const isUserAdded = () =>
                  getKnownNodes().includes(node.url) &&
                  node.url !== DEFAULT_NODE_URL &&
                  node.url !== currentUrl();
                return (
                  <div class={`node-option-row ${node.url === currentUrl() ? 'active' : ''}`}>
                    <button
                      class="node-option"
                      onClick={() => handleSelect(node.url)}
                    >
                      <span class="node-option-left">
                        <span class="node-option-url">{node.url.replace(/^https?:\/\//, '')}</span>
                        <Show when={node.anchorStatus && node.anchorStatus.level !== 'none'}>
                          <AnchorBadge level={node.anchorStatus!.level} showLabel={false} />
                        </Show>
                      </span>
                      <span class="node-ping" style={{ color: pingColor(node.ping) }}>
                        {node.ping === Infinity ? '∞' : node.ping}ms ({pingLabel(node.ping)})
                      </span>
                    </button>
                    <Show when={isUserAdded()}>
                      <button
                        class="node-option-remove"
                        title={t('node_remove_known') || 'Remove from list'}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeKnownNode(node.url);
                          handleRefresh();
                        }}
                      >
                        ✕
                      </button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
          <div class="node-manual">
            <input
              type="text"
              placeholder="http://192.168.x.x:41721"
              value={manualUrl()}
              onInput={(e) => { setManualUrl(e.currentTarget.value); setAddError(''); }}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !adding()) {
                  tryAddManual();
                }
              }}
              class="node-manual-input"
              disabled={adding()}
            />
            <button
              class="node-manual-btn"
              onClick={tryAddManual}
              disabled={adding() || !manualUrl().trim()}
            >
              {adding() ? '…' : '+'}
            </button>
          </div>
          <Show when={addError()}>
            <div class="node-manual-error">{addError()}</div>
          </Show>
        </div>
      </Show>

      <style>{`
        .node-selector { position: relative; }
        .node-current {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-sm);
          font-size: var(--font-size-xs);
          cursor: pointer;
          color: var(--color-text-secondary);
        }
        .node-current:hover { color: var(--color-text-primary); }
        .node-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: var(--color-success, #22c55e);
        }
        .node-arrow { font-size: 8px; }
        .node-dropdown {
          position: absolute;
          bottom: 100%;
          left: 0;
          min-width: 300px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          box-shadow: 0 -4px 12px rgba(0,0,0,0.15);
          z-index: 100;
          margin-bottom: var(--spacing-xs);
        }
        .node-dropdown-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--spacing-sm);
          font-size: var(--font-size-xs);
          font-weight: 600;
          color: var(--color-text-secondary);
          border-bottom: 1px solid var(--color-border);
        }
        .node-refresh {
          cursor: pointer;
          font-size: var(--font-size-md);
          color: var(--color-text-secondary);
        }
        .node-refresh:hover { color: var(--color-accent-primary); }
        .node-option-row {
          display: flex;
          align-items: stretch;
          width: 100%;
        }
        .node-option-row.active { background: var(--color-bg-tertiary); font-weight: 600; }
        .node-option-row:hover { background: var(--color-bg-tertiary); }
        .node-option {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex: 1;
          padding: var(--spacing-sm);
          text-align: left;
          font-size: var(--font-size-sm);
          cursor: pointer;
          background: transparent;
        }
        .node-option:hover { background: var(--color-bg-tertiary); }
        .node-option.active { background: var(--color-bg-tertiary); font-weight: 600; }
        .node-option-remove {
          padding: 0 10px;
          background: transparent;
          color: var(--color-text-secondary);
          font-size: 12px;
          cursor: pointer;
          opacity: 0.6;
        }
        .node-option-remove:hover {
          opacity: 1;
          color: var(--color-error);
        }
        .node-option-left {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
        }
        .node-option-url { color: var(--color-text-primary); }
        .node-ping { font-size: var(--font-size-xs); font-weight: 600; }
        .node-loading {
          padding: var(--spacing-md);
          text-align: center;
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .node-manual {
          display: flex;
          gap: var(--spacing-xs);
          padding: var(--spacing-sm);
          border-top: 1px solid var(--color-border);
        }
        .node-manual-input {
          flex: 1;
          padding: var(--spacing-xs) var(--spacing-sm);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          font-size: var(--font-size-xs);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
        }
        .node-manual-input:focus { outline: none; border-color: var(--color-accent-primary); }
        .node-manual-btn {
          padding: var(--spacing-xs) var(--spacing-sm);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-sm);
          font-weight: 700;
          cursor: pointer;
        }
        .node-manual-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .node-manual-input:disabled { opacity: 0.6; cursor: not-allowed; }
        .node-manual-error {
          padding: var(--spacing-xs) var(--spacing-sm);
          font-size: var(--font-size-xs);
          color: var(--color-error);
          border-top: 1px solid var(--color-border);
          line-height: 1.4;
        }
      `}</style>
    </div>
  );
};
