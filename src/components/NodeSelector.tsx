/**
 * NodeSelector — dropdown for choosing L2 node with ping display.
 *
 * Discovers available nodes, measures latency, and lets the user
 * pick which node to connect to. Remembers selection in settings.
 */

import { Component, createResource, createSignal, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import {
  activeNodeUrl,
  getAvailableNodes,
  switchNode,
  removeKnownNode,
  getKnownNodes,
  getDefaultNodeUrl,
  setDefaultNodeUrl,
  getLastBootstrapResult,
} from '../lib/api';
import type { NodeWithPing } from '@ogmara/sdk';
import { pingNode, validateNodeUrl } from '@ogmara/sdk';
import { AnchorBadge } from './AnchorBadge';

export const NodeSelector: Component = () => {
  const [open, setOpen] = createSignal(false);
  // Reactive current node — updates the moment bootstrap / any silent switch
  // lands a node (the old local signal was captured once at mount, so it
  // showed blank on a fresh install until a manual select).
  const currentUrl = activeNodeUrl;
  const [manualUrl, setManualUrl] = createSignal('');
  const [addError, setAddError] = createSignal('');
  const [adding, setAdding] = createSignal(false);
  const [defaultUrl, setDefaultUrl] = createSignal(getDefaultNodeUrl());

  // One-time notice when boot couldn't reach the pinned default and
  // fell back to best-ping. Cleared after the user opens the dropdown
  // (the picker UI is the place to fix the issue anyway).
  const bootResult = getLastBootstrapResult();
  const [bootNotice, setBootNotice] = createSignal(
    bootResult && bootResult.reason === 'default-unreachable-fallback'
      ? bootResult.chosen
      : '',
  );

  const togglePin = (url: string) => {
    const current = defaultUrl();
    const next = current === url ? '' : url;
    setDefaultNodeUrl(next || null);
    setDefaultUrl(next);
  };

  const [nodes, { refetch }] = createResource(async () => {
    return getAvailableNodes();
  });

  const handleSelect = (url: string) => {
    switchNode(url); // updates activeNodeUrl via switchNodeSilent, then reloads
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
          <Show when={bootNotice()}>
            <div class="node-boot-notice">
              {t('node_default_unreachable_notice') ||
                'Pinned default node unreachable — using best-ping fallback'}
              <button
                class="node-boot-dismiss"
                onClick={() => setBootNotice('')}
                title="Dismiss"
              >
                ✕
              </button>
            </div>
          </Show>
          <Show when={defaultUrl()}>
            <div class="node-default-summary">
              <span class="node-star-active">★</span>{' '}
              {t('node_default_pinned') || 'Default'}:{' '}
              <span class="node-default-url">
                {defaultUrl().replace(/^https?:\/\//, '')}
              </span>
            </div>
          </Show>
          <Show when={!nodes.loading} fallback={<div class="node-loading">{t('loading')}</div>}>
            <For each={nodes()}>
              {(node: NodeWithPing) => {
                // Show the ✕ on any known-nodes breadcrumb that isn't the
                // currently-selected node. (We no longer exempt a hardcoded
                // default — there isn't one anymore; nodes come from the SC
                // registry + the user's own list, and a stale/dead known
                // node must always be removable.)
                const isUserAdded = () =>
                  getKnownNodes().includes(node.url) &&
                  node.url !== currentUrl();
                const isPinned = () => defaultUrl() === node.url;
                return (
                  <div
                    class={`node-option-row ${node.url === currentUrl() ? 'active' : ''} ${
                      isPinned() ? 'pinned' : ''
                    }`}
                  >
                    <button
                      class={`node-option-pin ${isPinned() ? 'pinned' : ''}`}
                      title={
                        isPinned()
                          ? t('node_unpin_default') || 'Clear pinned default'
                          : t('node_pin_default') ||
                            'Pin as default — always connect here first'
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(node.url);
                      }}
                    >
                      {isPinned() ? '★' : '☆'}
                    </button>
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
                    </button>
                    {/* Ping + remove are ROW-LEVEL siblings (not inside the
                        select button) with reserved, non-shrinking width, so
                        the ping label can never slide on top of the ✕ —
                        whatever the URL length or active-row bold weight. */}
                    <span class="node-ping" style={{ color: pingColor(node.ping) }}>
                      {node.ping === Infinity ? '∞' : node.ping}ms ({pingLabel(node.ping)})
                    </span>
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
          /* Grid with explicit column tracks: [pin] [url(flex)] [ping] [✕].
             Tracks can't overlap by definition, so the ping label can
             never land on top of the remove button no matter how long the
             URL is or whether the row is the bold active one. The url
             track is minmax(0,1fr) so it (and only it) absorbs slack and
             truncates; the other three size to content. The 4th track is
             empty on rows without a ✕ (current/default node). */
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto auto;
          align-items: stretch;
          width: 100%;
        }
        .node-option-row.active { background: var(--color-bg-tertiary); font-weight: 600; }
        .node-option-row:hover { background: var(--color-bg-tertiary); }
        .node-option-row.pinned { box-shadow: inset 3px 0 0 var(--color-warning, #eab308); }
        .node-option-pin {
          display: flex;
          align-items: center;
          flex-shrink: 0;
          padding: 0 8px;
          background: transparent;
          color: var(--color-text-secondary);
          font-size: 14px;
          cursor: pointer;
          opacity: 0.45;
          transition: opacity 120ms, color 120ms;
        }
        .node-option-pin:hover { opacity: 1; color: var(--color-warning, #eab308); }
        .node-option-pin.pinned { opacity: 1; color: var(--color-warning, #eab308); }
        .node-default-summary {
          padding: var(--spacing-xs) var(--spacing-sm);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          background: var(--color-bg-tertiary);
          border-bottom: 1px solid var(--color-border);
        }
        .node-star-active { color: var(--color-warning, #eab308); }
        .node-default-url { color: var(--color-text-primary); font-weight: 600; }
        .node-boot-notice {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-xs) var(--spacing-sm);
          font-size: var(--font-size-xs);
          color: var(--color-warning, #eab308);
          background: rgba(234, 179, 8, 0.08);
          border-bottom: 1px solid var(--color-border);
        }
        .node-boot-dismiss {
          background: transparent;
          color: inherit;
          padding: 0 4px;
          cursor: pointer;
          opacity: 0.7;
        }
        .node-boot-dismiss:hover { opacity: 1; }
        .node-option {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex: 1;
          /* Allow the button to shrink below its content's intrinsic
             width. Without this (flex items default to min-width:auto)
             a long URL like the tailscale host + the ping label can't
             shrink, so the row overflows and the ping slides on top of
             the ✕ remove button — making it unclickable. Regressed in
             v1.23.0 when the ★ pin button stole ~30px of row width. */
          min-width: 0;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm);
          text-align: left;
          font-size: var(--font-size-sm);
          cursor: pointer;
          background: transparent;
        }
        .node-option:hover { background: var(--color-bg-tertiary); }
        .node-option.active { background: var(--color-bg-tertiary); font-weight: 600; }
        .node-option-remove {
          flex-shrink: 0;
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
          /* Take the slack and clip the URL rather than push the ping
             into the remove button. */
          min-width: 0;
          flex: 1;
          overflow: hidden;
        }
        .node-option-url {
          color: var(--color-text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        /* Ping label is a ROW-LEVEL flex sibling (not inside the select
           button): reserved width, never shrinks, never overlaps the ✕. */
        .node-ping {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          padding: 0 var(--spacing-sm);
          white-space: nowrap;
          font-size: var(--font-size-xs);
          font-weight: 600;
        }
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
