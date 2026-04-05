/**
 * TokenPortfolioView — displays all token balances in the user's wallet
 * and provides a send dialog for transferring tokens to other addresses.
 */

import { Component, createSignal, createResource, Show, For, createMemo } from 'solid-js';
import { t } from '../i18n/init';
import { walletAddress, authStatus } from '../lib/auth';
import {
  getAccountBalances,
  getTokenMetadata,
  sendTransfer,
  getExplorerUrl,
  TokenBalance,
} from '../lib/klever';
import { navigate } from '../lib/router';
import { invoke } from '@tauri-apps/api/core';

/** Open a URL in the system default browser via Rust backend. */
function openExternal(url: string): void {
  invoke('open_url', { url }).catch((err) => {
    console.error('open_url failed:', err);
  });
}

/**
 * Format atomic units to human-readable balance using string math
 * to avoid floating-point precision loss on large values.
 */
function formatBalance(atomic: number, precision: number): string {
  if (precision === 0) return atomic.toLocaleString();
  const str = String(atomic);
  const padded = str.padStart(precision + 1, '0');
  const intPart = padded.slice(0, padded.length - precision);
  const fracPart = padded.slice(padded.length - precision).replace(/0+$/, '');
  const intFormatted = Number(intPart).toLocaleString();
  return fracPart ? `${intFormatted}.${fracPart}` : intFormatted;
}

/**
 * Parse a decimal string into atomic units without floating-point math.
 * E.g., "1.5" with precision 6 → 1500000.
 */
function parseDecimalToAtomic(value: string, precision: number): number {
  const parts = value.split('.');
  const intPart = parts[0] || '0';
  let fracPart = parts[1] || '';
  // Pad or truncate fractional part to `precision` digits
  if (fracPart.length > precision) {
    fracPart = fracPart.slice(0, precision);
  } else {
    fracPart = fracPart.padEnd(precision, '0');
  }
  return Number(intPart + fracPart);
}

/**
 * Convert atomic units to a decimal string without float division.
 * E.g., 1500000 with precision 6 → "1.5".
 */
function atomicToDecimalString(atomic: number, precision: number): string {
  if (precision === 0) return String(atomic);
  const str = String(atomic).padStart(precision + 1, '0');
  const intPart = str.slice(0, str.length - precision);
  const fracPart = str.slice(str.length - precision).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** Truncate token ID for display (e.g., "FLIPPY-3FQ0" stays, long IDs get trimmed). */
function displayAssetId(assetId: string): string {
  return assetId.length > 20 ? assetId.slice(0, 17) + '...' : assetId;
}

export const TokenPortfolioView: Component = () => {
  const [sendToken, setSendToken] = createSignal<TokenBalance | null>(null);
  const [sendRecipient, setSendRecipient] = createSignal('');
  const [sendAmount, setSendAmount] = createSignal('');
  const [sendPending, setSendPending] = createSignal(false);
  const [sendError, setSendError] = createSignal('');
  const [sendResult, setSendResult] = createSignal('');
  const [tokenLogos, setTokenLogos] = createSignal<Record<string, string>>({});
  const [tokenNames, setTokenNames] = createSignal<Record<string, string>>({});

  // Fetch balances when wallet is connected
  const [balances, { refetch }] = createResource(
    () => authStatus() === 'ready' ? walletAddress() : null,
    async (address) => {
      if (!address) return [];
      const result = await getAccountBalances(address);
      // Fetch metadata for non-KLV tokens in background (skip if already cached)
      const cachedNames = tokenNames();
      for (const token of result) {
        if (token.assetId !== 'KLV' && !token.name && !(token.assetId in cachedNames)) {
          getTokenMetadata(token.assetId).then((meta) => {
            if (meta) {
              setTokenLogos((prev) => ({ ...prev, [token.assetId]: meta.logo }));
              setTokenNames((prev) => ({ ...prev, [token.assetId]: meta.name }));
            }
          }).catch(() => { /* metadata is non-critical */ });
        }
      }
      return result;
    },
  );

  const explorerUrl = createMemo(() => getExplorerUrl());

  const totalKlvValue = createMemo(() => {
    const list = balances();
    if (!list) return '0';
    const klv = list.find((b) => b.assetId === 'KLV');
    return klv ? formatBalance(klv.balance, klv.precision) : '0';
  });

  const getTokenLogo = (token: TokenBalance): string => {
    const url = token.logo || tokenLogos()[token.assetId] || '';
    // Only allow HTTPS URLs to prevent tracking/injection via logo field
    return url.startsWith('https://') ? url : '';
  };

  const getTokenName = (token: TokenBalance): string => {
    const raw = token.name || tokenNames()[token.assetId] || token.assetId.split('-')[0];
    // Strip control chars and RTL/LTR overrides to prevent Unicode spoofing
    return raw.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  };

  const openSend = (token: TokenBalance) => {
    setSendToken(token);
    setSendRecipient('');
    setSendAmount('');
    setSendError('');
    setSendResult('');
  };

  const closeSend = () => {
    setSendToken(null);
    setSendRecipient('');
    setSendAmount('');
    setSendError('');
    setSendResult('');
    setSendPending(false);
  };

  const handleSend = async () => {
    const token = sendToken();
    if (!token) return;

    const recipient = sendRecipient().trim();
    if (!/^klv1[a-z0-9]{58}$/.test(recipient)) {
      setSendError(t('portfolio_invalid_address'));
      return;
    }
    if (recipient === walletAddress()) {
      setSendError(t('portfolio_self_send'));
      return;
    }

    const amountStr = sendAmount().trim();
    // Validate: only digits with optional single decimal point
    if (!/^\d+(\.\d+)?$/.test(amountStr)) {
      setSendError(t('portfolio_invalid_amount'));
      return;
    }
    if (parseFloat(amountStr) <= 0) {
      setSendError(t('portfolio_invalid_amount'));
      return;
    }

    // Convert to atomic units using string math (no float precision loss)
    const atomicAmount = parseDecimalToAtomic(amountStr, token.precision);
    if (atomicAmount <= 0) {
      setSendError(t('portfolio_invalid_amount'));
      return;
    }
    if (atomicAmount > token.balance) {
      setSendError(t('portfolio_insufficient'));
      return;
    }

    setSendError('');
    setSendPending(true);
    setSendResult('');

    try {
      const txHash = await sendTransfer(recipient, token.assetId, atomicAmount);
      setSendResult(txHash);
      // Refresh balances after successful send
      setTimeout(() => refetch(), 3000);
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setSendPending(false);
    }
  };

  const setMaxAmount = () => {
    const token = sendToken();
    if (!token) return;
    // Use string-based conversion to avoid float precision loss
    setSendAmount(atomicToDecimalString(token.balance, token.precision));
  };

  return (
    <div class="portfolio-view">
      <div class="portfolio-header">
        <h2>{t('portfolio_title')}</h2>
        <button class="portfolio-refresh-btn" onClick={() => refetch()} title={t('portfolio_refresh')}>
          ↻
        </button>
      </div>

      <Show when={authStatus() !== 'ready'}>
        <div class="portfolio-connect">
          <p>{t('portfolio_connect_wallet')}</p>
          <button class="wallet-btn primary" onClick={() => navigate('/wallet')}>
            {t('wallet_connect')}
          </button>
        </div>
      </Show>

      <Show when={authStatus() === 'ready'}>
        {/* KLV summary */}
        <div class="portfolio-summary">
          <span class="portfolio-klv-label">KLV</span>
          <span class="portfolio-klv-value">{totalKlvValue()}</span>
        </div>

        {/* Loading state */}
        <Show when={balances.loading}>
          <div class="portfolio-loading">{t('loading')}</div>
        </Show>

        {/* Error state */}
        <Show when={balances.error}>
          <div class="portfolio-error">{balances.error?.message || t('error')}</div>
        </Show>

        {/* Token list */}
        <Show when={balances() && !balances.loading}>
          <div class="portfolio-table">
            <div class="portfolio-table-header">
              <span class="col-token">{t('portfolio_token')}</span>
              <span class="col-balance">{t('portfolio_balance')}</span>
              <span class="col-frozen">{t('portfolio_frozen')}</span>
              <span class="col-actions"></span>
            </div>

            <Show when={balances()!.length === 0}>
              <div class="portfolio-empty">{t('portfolio_empty')}</div>
            </Show>

            <For each={balances()}>
              {(token) => (
                <div class="portfolio-row">
                  <div class="col-token">
                    <div class="token-icon">
                      <Show when={getTokenLogo(token)} fallback={
                        <div class="token-icon-placeholder">
                          {token.assetId.charAt(0).toUpperCase()}
                        </div>
                      }>
                        <img
                          src={getTokenLogo(token)}
                          alt={token.assetId}
                          class="token-logo-img"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                            (e.currentTarget.nextElementSibling as HTMLElement)?.style.setProperty('display', 'flex');
                          }}
                        />
                        <div class="token-icon-placeholder" style="display:none">
                          {token.assetId.charAt(0).toUpperCase()}
                        </div>
                      </Show>
                    </div>
                    <div class="token-info">
                      <span class="token-ticker">{displayAssetId(token.assetId)}</span>
                      <span class="token-name">{getTokenName(token)}</span>
                    </div>
                  </div>
                  <span class="col-balance">{formatBalance(token.balance, token.precision)}</span>
                  <span class="col-frozen">
                    <Show when={token.frozenBalance > 0}>
                      {formatBalance(token.frozenBalance, token.precision)}
                    </Show>
                  </span>
                  <div class="col-actions">
                    <button
                      class="send-btn"
                      onClick={() => openSend(token)}
                      disabled={token.balance === 0}
                      title={t('portfolio_send')}
                    >
                      {t('portfolio_send')}
                    </button>
                    <span
                      class="explorer-link"
                      onClick={() => openExternal(`${explorerUrl()}/asset/${encodeURIComponent(token.assetId)}`)}
                      title={t('portfolio_view_explorer')}
                    >
                      ↗
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Send dialog */}
        <Show when={sendToken()}>
          <div class="send-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeSend(); }}>
            <div class="send-dialog">
              <div class="send-dialog-header">
                <h3>{t('portfolio_send')} {sendToken()!.assetId}</h3>
                <button class="send-close-btn" onClick={closeSend}>✕</button>
              </div>

              <Show when={sendResult()}>
                <div class="send-success">
                  {t('portfolio_tx_sent')}{' '}
                  <span
                    class="tx-link"
                    onClick={(e) => { e.stopPropagation(); openExternal(`${explorerUrl()}/transaction/${sendResult()}`); }}
                  >
                    {sendResult().slice(0, 16)}... ↗
                  </span>
                </div>
              </Show>

              <Show when={sendError()}>
                <div class="send-error">{sendError()}</div>
              </Show>

              <Show when={!sendResult()}>
                <div class="send-field">
                  <label>{t('portfolio_available')}</label>
                  <span class="send-available">
                    {formatBalance(sendToken()!.balance, sendToken()!.precision)} {sendToken()!.assetId}
                  </span>
                </div>

                <div class="send-field">
                  <label>{t('portfolio_recipient')}</label>
                  <input
                    type="text"
                    class="send-input"
                    placeholder="klv1..."
                    value={sendRecipient()}
                    onInput={(e) => setSendRecipient(e.currentTarget.value)}
                    disabled={sendPending()}
                  />
                </div>

                <div class="send-field">
                  <label>{t('portfolio_amount')}</label>
                  <div class="send-amount-row">
                    <input
                      type="text"
                      inputMode="decimal"
                      class="send-input send-amount-input"
                      placeholder="0.00"
                      value={sendAmount()}
                      onInput={(e) => setSendAmount(e.currentTarget.value)}
                      disabled={sendPending()}
                    />
                    <button class="max-btn" onClick={setMaxAmount} disabled={sendPending()}>
                      MAX
                    </button>
                  </div>
                </div>

                <button
                  class="wallet-btn primary send-confirm-btn"
                  onClick={handleSend}
                  disabled={sendPending() || !sendRecipient() || !sendAmount()}
                >
                  {sendPending() ? t('onchain_tx_pending') : t('portfolio_confirm_send')}
                </button>
              </Show>

              <Show when={sendResult()}>
                <button class="wallet-btn send-confirm-btn" onClick={closeSend}>
                  {t('done')}
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </Show>

      <style>{`
        .portfolio-view {
          padding: var(--spacing-lg);
          overflow-y: auto;
          height: 100%;
          max-width: 800px;
        }
        .portfolio-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: var(--spacing-lg);
        }
        .portfolio-header h2 {
          font-size: var(--font-size-xl);
          margin: 0;
        }
        .portfolio-refresh-btn {
          font-size: var(--font-size-xl);
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          cursor: pointer;
          transition: background 0.15s;
        }
        .portfolio-refresh-btn:hover {
          background: var(--color-bg-secondary);
        }

        .portfolio-connect {
          text-align: center;
          padding: var(--spacing-xl);
          color: var(--color-text-secondary);
        }
        .portfolio-connect p { margin-bottom: var(--spacing-md); }

        .portfolio-summary {
          display: flex;
          align-items: baseline;
          gap: var(--spacing-sm);
          padding: var(--spacing-md) var(--spacing-lg);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-lg);
          margin-bottom: var(--spacing-lg);
        }
        .portfolio-klv-label {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          font-weight: 600;
        }
        .portfolio-klv-value {
          font-size: var(--font-size-xxl, 1.75rem);
          font-weight: 700;
          color: var(--color-text-primary);
        }

        .portfolio-loading, .portfolio-error, .portfolio-empty {
          text-align: center;
          padding: var(--spacing-xl);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
        }
        .portfolio-error { color: var(--color-error); }

        /* Table */
        .portfolio-table {
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          overflow: hidden;
        }
        .portfolio-table-header {
          display: grid;
          grid-template-columns: 2fr 1fr 1fr 120px;
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-bg-tertiary);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-weight: 600;
        }
        .portfolio-row {
          display: grid;
          grid-template-columns: 2fr 1fr 1fr 120px;
          padding: var(--spacing-sm) var(--spacing-md);
          align-items: center;
          border-top: 1px solid var(--color-border);
          transition: background 0.1s;
        }
        .portfolio-row:hover {
          background: var(--color-bg-tertiary);
        }

        .col-token {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          min-width: 0;
        }
        .col-balance, .col-frozen {
          font-family: monospace;
          font-size: var(--font-size-sm);
          text-align: right;
          padding-right: var(--spacing-md);
        }
        .col-frozen { color: var(--color-text-secondary); }
        .col-actions {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          justify-content: flex-end;
        }

        .token-icon {
          width: 32px;
          height: 32px;
          flex-shrink: 0;
        }
        .token-logo-img {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          object-fit: cover;
        }
        .token-icon-placeholder {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--color-accent-primary);
          color: var(--color-text-inverse, #fff);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: var(--font-size-sm);
          font-weight: 700;
        }
        .token-info {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .token-ticker {
          font-weight: 600;
          font-size: var(--font-size-sm);
          color: var(--color-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .token-name {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .send-btn {
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-sm);
          font-size: var(--font-size-xs);
          font-weight: 600;
          background: var(--color-accent-primary);
          color: var(--color-text-inverse, #fff);
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .send-btn:hover:not(:disabled) { opacity: 0.85; }
        .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .explorer-link {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          padding: var(--spacing-xs);
          border-radius: var(--radius-sm);
          cursor: pointer;
          transition: color 0.15s;
        }
        .explorer-link:hover { color: var(--color-accent-primary); }

        /* Send dialog overlay */
        .send-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .send-dialog {
          background: var(--color-bg-primary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
          width: 420px;
          max-width: 90vw;
          max-height: 90vh;
          overflow-y: auto;
        }
        .send-dialog-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: var(--spacing-lg);
        }
        .send-dialog-header h3 {
          font-size: var(--font-size-lg);
          margin: 0;
        }
        .send-close-btn {
          font-size: var(--font-size-lg);
          padding: var(--spacing-xs);
          border-radius: var(--radius-sm);
          background: none;
          color: var(--color-text-secondary);
          cursor: pointer;
        }
        .send-close-btn:hover { color: var(--color-text-primary); }

        .send-field {
          margin-bottom: var(--spacing-md);
        }
        .send-field label {
          display: block;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: var(--spacing-xs);
          font-weight: 600;
        }
        .send-available {
          font-family: monospace;
          font-size: var(--font-size-sm);
          color: var(--color-text-primary);
        }
        .send-input {
          width: 100%;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-size: var(--font-size-sm);
          font-family: monospace;
        }
        .send-input:focus {
          outline: none;
          border-color: var(--color-accent-primary);
        }
        .send-amount-row {
          display: flex;
          gap: var(--spacing-sm);
        }
        .send-amount-input { flex: 1; }
        .max-btn {
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-md);
          font-size: var(--font-size-xs);
          font-weight: 700;
          background: var(--color-bg-secondary);
          color: var(--color-accent-primary);
          cursor: pointer;
          white-space: nowrap;
        }
        .max-btn:hover { opacity: 0.8; }

        .send-confirm-btn {
          width: 100%;
          margin-top: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-lg);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
        }
        .send-success {
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-success);
          color: var(--color-text-primary);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          margin-bottom: var(--spacing-md);
          word-break: break-all;
        }
        .send-error {
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-error);
          color: var(--color-error);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          margin-bottom: var(--spacing-md);
        }
        .tx-link {
          color: var(--color-accent-primary);
          text-decoration: underline;
          cursor: pointer;
          font-family: monospace;
        }
        .tx-link:hover { opacity: 0.8; }
      `}</style>
    </div>
  );
};
