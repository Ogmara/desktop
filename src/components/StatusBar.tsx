import { Component, createResource, createSignal, Show } from 'solid-js';
import { t } from '../i18n/init';
import { NodeSelector } from './NodeSelector';
import { AnchorBadge } from './AnchorBadge';
import { getClient, getCurrentNodeUrl } from '../lib/api';
import type { AnchorStatus } from '@ogmara/sdk';

/** Format seconds into a human-readable "X ago" string. */
function formatAge(seconds: number): string {
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return t('anchor_ago_minutes', { count: mins || 1 });
  }
  if (seconds < 86400) {
    const hrs = Math.floor(seconds / 3600);
    return t('anchor_ago_hours', { count: hrs });
  }
  const days = Math.floor(seconds / 86400);
  return t('anchor_ago_days', { count: days });
}

export const StatusBar: Component = () => {
  const [showInfo, setShowInfo] = createSignal(false);

  // Fetch stats from the connected node (for anchor status)
  const [stats] = createResource(async () => {
    try {
      return await getClient().networkStats();
    } catch {
      return null;
    }
  });

  /** Network name from node stats ("testnet", "mainnet", or "unknown"). */
  const networkName = () => (stats()?.network as string) || 'unknown';
  const isTestnet = () => networkName() === 'testnet';

  const anchorLevel = (): AnchorStatus['level'] => {
    const s = stats();
    if (!s?.anchor_status?.is_anchorer) return 'none';
    // Derive level from self anchor status
    const age = s.anchor_status.last_anchor_age_seconds;
    if (age == null || age > 86400) return 'none';
    if (s.anchor_status.anchoring_since) {
      const now = Date.now() / 1000;
      const since = s.anchor_status.anchoring_since / 1000;
      if (now - since > 7 * 86400) return 'active';
    }
    return 'verified';
  };

  return (
    <footer class="status-bar">
      <button class="status-btn" onClick={() => setShowInfo(!showInfo())}>
        <span class="status-indicator connected" />
        <span class="status-text">{t('status_connected')}</span>
        <Show when={anchorLevel() !== 'none'}>
          <AnchorBadge level={anchorLevel()} showLabel={false} />
        </Show>
      </button>
      <Show when={networkName() !== 'unknown'}>
        <span class={`network-badge ${isTestnet() ? 'testnet' : 'mainnet'}`}>
          {networkName().charAt(0).toUpperCase() + networkName().slice(1)}
        </span>
      </Show>
      <NodeSelector />
      <span class="status-version">v{__APP_VERSION__}</span>

      {/* Node info dialog */}
      <Show when={showInfo()}>
        <div class="node-info-overlay" onClick={() => setShowInfo(false)}>
          <div class="node-info-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t('node_info_title')}</h3>
            <p class="node-info-url">{getCurrentNodeUrl()}</p>

            <div class="node-info-row">
              <span>{t('node_info_status')}</span>
              <span class="node-info-online">Online</span>
            </div>
            <div class="node-info-row">
              <span>Network</span>
              <span class={`network-badge-inline ${isTestnet() ? 'testnet' : 'mainnet'}`}>
                {networkName().charAt(0).toUpperCase() + networkName().slice(1)}
              </span>
            </div>
            <div class="node-info-row">
              <span>{t('node_info_verified')}</span>
              <span>
                <Show when={anchorLevel() !== 'none'} fallback="—">
                  <AnchorBadge level={anchorLevel()} />
                </Show>
              </span>
            </div>
            <Show when={stats()?.anchor_status?.anchoring_since}>
              <div class="node-info-row">
                <span>{t('anchor_since')}</span>
                <span>{new Date(stats()!.anchor_status!.anchoring_since!).toLocaleDateString()}</span>
              </div>
            </Show>
            <Show when={stats()?.anchor_status?.last_anchor_age_seconds != null}>
              <div class="node-info-row">
                <span>{t('anchor_last')}</span>
                <span>{formatAge(stats()!.anchor_status!.last_anchor_age_seconds!)}</span>
              </div>
            </Show>
            <div class="node-info-row">
              <span>{t('node_info_peers')}</span>
              <span>{stats()?.peers ?? '—'}</span>
            </div>
            <div class="node-info-row">
              <span>{t('node_info_version')}</span>
              <span>v{__APP_VERSION__}</span>
            </div>

            <button class="node-info-close" onClick={() => setShowInfo(false)}>
              {t('done')}
            </button>
          </div>
        </div>
      </Show>

      <style>{`
        .status-bar {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-xs) var(--spacing-md);
          background: var(--color-bg-secondary);
          border-top: 1px solid var(--color-border);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          height: 28px;
        }
        .status-btn {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          cursor: pointer;
          color: var(--color-text-secondary);
        }
        .status-btn:hover { color: var(--color-text-primary); }
        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: var(--radius-full);
        }
        .status-indicator.connected { background: var(--color-success); }
        .status-indicator.disconnected { background: var(--color-error); }
        .network-badge {
          padding: 1px 6px;
          border-radius: var(--radius-sm);
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .network-badge.testnet {
          background: var(--color-warning);
          color: #1a1a1a;
        }
        .network-badge.mainnet {
          background: var(--color-success);
          color: #1a1a1a;
        }
        .network-badge-inline {
          padding: 2px 8px;
          border-radius: var(--radius-sm);
          font-size: var(--font-size-xs);
          font-weight: 700;
        }
        .network-badge-inline.testnet {
          background: var(--color-warning);
          color: #1a1a1a;
        }
        .network-badge-inline.mainnet {
          background: var(--color-success);
          color: #1a1a1a;
        }
        .status-version { margin-left: auto; opacity: 0.5; }

        .node-info-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 200;
        }
        .node-info-dialog {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
          min-width: 320px;
          max-width: 400px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.2);
        }
        .node-info-dialog h3 {
          margin: 0 0 var(--spacing-xs) 0;
          font-size: var(--font-size-md);
          color: var(--color-text-primary);
        }
        .node-info-url {
          margin: 0 0 var(--spacing-md) 0;
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .node-info-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--spacing-xs) 0;
          font-size: var(--font-size-sm);
          color: var(--color-text-primary);
          border-bottom: 1px solid var(--color-border);
        }
        .node-info-row:last-of-type { border-bottom: none; }
        .node-info-online { color: var(--color-success); font-weight: 600; }
        .node-info-close {
          margin-top: var(--spacing-md);
          width: 100%;
          padding: var(--spacing-sm);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          cursor: pointer;
        }
        .node-info-close:hover { opacity: 0.9; }
      `}</style>
    </footer>
  );
};

declare const __APP_VERSION__: string;
