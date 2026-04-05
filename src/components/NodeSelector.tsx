/**
 * NodeSelector — dropdown for choosing L2 node with ping display.
 *
 * Discovers available nodes, measures latency, and lets the user
 * pick which node to connect to. Remembers selection in settings.
 */

import { Component, createResource, createSignal, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getCurrentNodeUrl, getAvailableNodes, switchNode } from '../lib/api';
import type { NodeWithPing } from '@ogmara/sdk';
import { pingNode } from '@ogmara/sdk';
import { AnchorBadge } from './AnchorBadge';

export const NodeSelector: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [currentUrl, setCurrentUrl] = createSignal(getCurrentNodeUrl());
  const [manualUrl, setManualUrl] = createSignal('');

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
      <button class="node-current" onClick={() => { setOpen(!open()); if (!open()) handleRefresh(); }}>
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
              {(node: NodeWithPing) => (
                <button
                  class={`node-option ${node.url === currentUrl() ? 'active' : ''}`}
                  onClick={() => handleSelect(node.url)}
                >
                  <span class="node-option-left">
                    <span class="node-option-url">{node.url.replace(/^https?:\/\//, '')}</span>
                    <Show when={node.anchorStatus && node.anchorStatus.level !== 'none'}>
                      <AnchorBadge level={node.anchorStatus!.level} showLabel={false} />
                    </Show>
                  </span>
                  <span class="node-ping" style={{ color: pingColor(node.ping) }}>
                    {node.ping}ms ({pingLabel(node.ping)})
                  </span>
                </button>
              )}
            </For>
          </Show>
          <div class="node-manual">
            <input
              type="text"
              placeholder="https://custom-node.example.com"
              value={manualUrl()}
              onInput={(e) => setManualUrl(e.currentTarget.value)}
              onKeyPress={async (e) => {
                if (e.key === 'Enter' && manualUrl().trim()) {
                  const url = manualUrl().trim().replace(/\/$/, '');
                  const ping = await pingNode(url);
                  if (ping < Infinity) {
                    handleSelect(url);
                    setManualUrl('');
                  }
                }
              }}
              class="node-manual-input"
            />
            <button
              class="node-manual-btn"
              onClick={async () => {
                if (!manualUrl().trim()) return;
                const url = manualUrl().trim().replace(/\/$/, '');
                const ping = await pingNode(url);
                if (ping < Infinity) {
                  handleSelect(url);
                  setManualUrl('');
                }
              }}
            >
              +
            </button>
          </div>
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
        .node-option {
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 100%;
          padding: var(--spacing-sm);
          text-align: left;
          font-size: var(--font-size-sm);
          cursor: pointer;
        }
        .node-option:hover { background: var(--color-bg-tertiary); }
        .node-option.active { background: var(--color-bg-tertiary); font-weight: 600; }
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
      `}</style>
    </div>
  );
};
