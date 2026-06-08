/**
 * WalletButton — toolbar wallet status indicator and connect button.
 */

import { Component, Show } from 'solid-js';
import { t } from '../i18n/init';
import { authStatus, walletAddress } from '../lib/auth';
import { navigate } from '../lib/router';

export const WalletButton: Component = () => {
  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <button
      class="wallet-button"
      onClick={() => {
        const addr = walletAddress();
        if (authStatus() === 'ready' && addr) {
          navigate(`/user/${addr}`);
        } else {
          navigate('/wallet');
        }
      }}
      title={authStatus() === 'ready' ? (walletAddress() ?? '') : t('wallet_connect')}
    >
      <Show
        when={authStatus() === 'ready'}
        fallback={<span class="wallet-connect-label">{t('wallet_connect')}</span>}
      >
        <span class="wallet-indicator connected" />
        <span class="wallet-addr">{walletAddress() ? truncateAddress(walletAddress()!) : ''}</span>
        {/* audit 2026-06-07 B4.1: removed dead `walletSource() === 'klever-extension'`
            badge — desktop is built-in-wallet only (WalletSource = 'builtin' | null),
            so the extension branch could never render. */}
      </Show>

      <style>{`
        .wallet-button {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          cursor: pointer;
        }
        .wallet-button:hover { background: var(--color-bg-tertiary); }
        .wallet-connect-label {
          color: var(--color-accent-primary);
          font-weight: 600;
        }
        .wallet-indicator {
          width: 8px;
          height: 8px;
          border-radius: var(--radius-full);
        }
        .wallet-indicator.connected { background: var(--color-success); }
        .wallet-addr {
          font-family: monospace;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .wallet-badge {
          background: #6c5ce7;
          color: white;
          font-size: 10px;
          font-weight: 700;
          width: 16px;
          height: 16px;
          border-radius: var(--radius-full);
          display: flex;
          align-items: center;
          justify-content: center;
        }
      `}</style>
    </button>
  );
};
