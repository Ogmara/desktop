/**
 * TokenPortfolioView — displays all token balances in the user's wallet
 * and provides a send dialog for transferring tokens to other addresses.
 */

import { Component, createSignal, createResource, Show, For, createMemo } from 'solid-js';
import { t, currentLanguage } from '../i18n/init';
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
import { currentCurrency } from '../lib/settings';
import {
  loadPrices,
  loadForex,
  computeFiatValue,
  formatFiat,
  TokenPrice,
  ForexRates,
} from '../lib/prices';
import { TxConfirmationCancelled } from '../lib/txConfirm';

/** Open a URL in the system default browser via Rust backend. */
function openExternal(url: string): void {
  invoke('open_url', { url }).catch((err) => {
    console.error('open_url failed:', err);
  });
}

/**
 * Format atomic units to human-readable balance using string math
 * to avoid floating-point precision loss on large values. Uses the
 * user's i18n language for thousands separators (so a German user
 * sees `1.234,56` regardless of their OS locale).
 */
function formatBalance(atomic: number, precision: number): string {
  const locale = currentLanguage() || undefined;
  if (precision === 0) return atomic.toLocaleString(locale);
  const str = String(atomic);
  const padded = str.padStart(precision + 1, '0');
  const intPart = padded.slice(0, padded.length - precision);
  const fracPart = padded.slice(padded.length - precision).replace(/0+$/, '');
  const intFormatted = Number(intPart).toLocaleString(locale);
  // Use the locale's decimal separator so the fractional part lines up
  // visually with the integer separators (`1.234,567` in de, `1,234.567`
  // in en). Intl.NumberFormat exposes this via formatToParts.
  const decimalSep = new Intl.NumberFormat(locale).formatToParts(1.1)
    .find((p) => p.type === 'decimal')?.value ?? '.';
  return fracPart ? `${intFormatted}${decimalSep}${fracPart}` : intFormatted;
}

/**
 * Parse a decimal string into atomic units without floating-point math.
 * E.g., "1.5" with precision 6 → 1500000.
 *
 * Uses BigInt for the intermediate concatenation so high-precision assets
 * at large amounts don't silently overflow Number.MAX_SAFE_INTEGER. The
 * returned value is coerced back to Number because the Klever node API
 * accepts JS numbers for `amount` and JSON serialization would otherwise
 * break — but the safe-integer boundary still applies (2^53 atomic units
 * is far above any practical token amount).
 */
function parseDecimalToAtomic(value: string, precision: number): number {
  const parts = value.split('.');
  const intPart = parts[0] || '0';
  let fracPart = parts[1] || '';
  if (fracPart.length > precision) {
    fracPart = fracPart.slice(0, precision);
  } else {
    fracPart = fracPart.padEnd(precision, '0');
  }
  try {
    const combined = BigInt(intPart + fracPart);
    // Return -1 on any parse failure so the call site's `<= 0` guard
    // catches it. (Previously returned NaN, which is neither <= 0 nor
    // > balance — letting bad input slip through to sendTransfer if
    // the upstream regex ever loosened.)
    if (combined < 0n) return -1;
    const n = Number(combined);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
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
  const [receiveOpen, setReceiveOpen] = createSignal(false);
  const [copyHint, setCopyHint] = createSignal(false);

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

  // --- Fiat display ---
  // Prices come from bitcoin.me (per-KDA USD) with CoinGecko providing
  // USD→target currency conversion. We show fiat for every asset where
  // bitcoin.me has a price, on every network. The asset IDs used on
  // testnet differ from mainnet, so on testnet the fiat column will
  // simply show "—" for tokens with no match — that's the right signal:
  // testnet KLV isn't worth anything.
  //
  // `currentCurrency()` is signal-backed in `settings.ts`, so changing
  // the currency in Settings reactively re-renders the fiat column
  // here without needing a route remount.
  const currency = createMemo(() => currentCurrency());

  // Refresh key: bumped by the refresh button so both resources retry
  // after a failed initial fetch. Without this the resources used a
  // constant source and only ran once at mount — leaving the user
  // stuck with no prices until app restart on a transient network blip.
  const [priceRefreshKey, setPriceRefreshKey] = createSignal(0);

  const [prices] = createResource<Record<string, TokenPrice> | null, number>(
    priceRefreshKey,
    async (key) => {
      // Force a network re-fetch (bypassing the 5-minute cache) when
      // the user explicitly hit the refresh button (key > 0).
      const cache = await loadPrices(key > 0);
      return cache?.byAsset ?? null;
    },
  );

  const [forex] = createResource<ForexRates | null, number>(
    priceRefreshKey,
    async (key) => {
      const cache = await loadForex(key > 0);
      return cache?.rates ?? null;
    },
  );

  const fiatRate = createMemo(() => {
    const rates = forex();
    if (!rates) return 0;
    return rates[currency()] ?? rates['usd'] ?? 0;
  });

  const fiatFor = (token: TokenBalance): number | null => {
    const map = prices();
    const rate = fiatRate();
    if (!map || !rate) return null;
    const p = map[token.assetId];
    if (!p) return null;
    return computeFiatValue(token.balance, token.precision, p.usd, rate);
  };

  const changeFor = (token: TokenBalance): number | null => {
    const p = prices()?.[token.assetId];
    return p ? p.change24h : null;
  };

  const totalFiat = createMemo<number | null>(() => {
    const list = balances();
    const map = prices();
    const rate = fiatRate();
    if (!list || !map || !rate) return null;
    let sum = 0;
    for (const tok of list) {
      const p = map[tok.assetId];
      if (!p) continue;
      sum += computeFiatValue(tok.balance, tok.precision, p.usd, rate);
    }
    return sum;
  });

  // --- Column sorting ---
  // Default: by fiat value descending; KLV is always pinned to position 1
  // regardless of value (it's the network's primary token and users expect
  // to see it at the top).
  type SortKey = 'token' | 'balance' | 'fiat' | 'change';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = createSignal<SortKey>('fiat');
  const [sortDir, setSortDir] = createSignal<SortDir>('desc');

  function cycleSort(key: SortKey) {
    if (sortKey() === key) {
      setSortDir(sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      // Numeric columns default desc (biggest first); the text column
      // defaults asc (A → Z).
      setSortDir(key === 'token' ? 'asc' : 'desc');
    }
  }

  function sortIndicator(key: SortKey): string {
    if (sortKey() !== key) return '';
    return sortDir() === 'asc' ? ' ↑' : ' ↓';
  }

  const sortedBalances = createMemo<TokenBalance[]>(() => {
    const list = balances();
    if (!list) return [];
    const key = sortKey();
    const dir = sortDir();
    const sign = dir === 'asc' ? 1 : -1;

    // Stable copy — never mutate the resource result.
    const out = list.slice().sort((a, b) => {
      // KLV pin: always first regardless of sort state.
      if (a.assetId === 'KLV') return -1;
      if (b.assetId === 'KLV') return 1;

      let av: number | string;
      let bv: number | string;
      switch (key) {
        case 'token':
          av = a.assetId.toLowerCase();
          bv = b.assetId.toLowerCase();
          break;
        case 'balance': {
          // Compare in whole-token units so different precisions don't bias.
          av = a.precision > 0 ? a.balance / Math.pow(10, a.precision) : a.balance;
          bv = b.precision > 0 ? b.balance / Math.pow(10, b.precision) : b.balance;
          break;
        }
        case 'fiat':
          av = fiatFor(a) ?? -Infinity;
          bv = fiatFor(b) ?? -Infinity;
          break;
        case 'change':
          av = changeFor(a) ?? -Infinity;
          bv = changeFor(b) ?? -Infinity;
          break;
      }
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * sign;
      }
      const an = av as number;
      const bn = bv as number;
      if (an === bn) return 0;
      return an < bn ? -1 * sign : 1 * sign;
    });
    return out;
  });

  const getTokenLogo = (token: TokenBalance): string => {
    const url = token.logo || tokenLogos()[token.assetId] || '';
    // Allow:
    //   - https:// URLs from token issuers (trusted by the user's chain)
    //   - Vite-served bundled assets: /assets/* in prod, /src/assets/* in dev
    // Reject everything else (http://, javascript:, arbitrary root paths
    // from a malicious asset issuer, data: URLs that could embed XSS, etc.)
    if (url.startsWith('https://')) return url;
    if (/^\/(?:assets|src\/assets)\//.test(url)) return url;
    return '';
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
      const txHash = await sendTransfer(recipient, token.assetId, atomicAmount, token.precision);
      setSendResult(txHash);
      // Refresh balances after successful send
      setTimeout(() => refetch(), 3000);
    } catch (e: any) {
      // PIN-confirm cancellation is user-initiated — show a calm message
      // instead of an alarming error popup.
      if (e instanceof TxConfirmationCancelled) {
        setSendError(t('tx_confirm_cancelled'));
      } else {
        setSendError(e?.message || t('error'));
      }
    } finally {
      setSendPending(false);
    }
  };

  const openReceive = () => {
    setReceiveOpen(true);
    setCopyHint(false);
  };

  const closeReceive = () => {
    setReceiveOpen(false);
    setCopyHint(false);
  };

  const copyAddress = async () => {
    const addr = walletAddress();
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopyHint(true);
      setTimeout(() => setCopyHint(false), 2000);
    } catch {
      // Clipboard API rejected — fall through silently.
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
        <div class="portfolio-header-actions">
          <Show when={authStatus() === 'ready'}>
            <button class="portfolio-action-btn" onClick={openReceive} title={t('portfolio_receive')}>
              ↓ {t('portfolio_receive')}
            </button>
          </Show>
          <button class="portfolio-refresh-btn" onClick={() => {
            // Re-fetch balances AND retry the price/forex resources.
            // Both bump independently — balances always refresh, price
            // resources also re-arm after a failed initial fetch.
            refetch();
            setPriceRefreshKey((n) => n + 1);
          }} title={t('portfolio_refresh')}>
            ↻
          </button>
        </div>
      </div>

      <Show when={authStatus() === 'ready'}>
        <div class="portfolio-sublink">
          <button class="portfolio-link" onClick={() => navigate('/wallet')}>
            {t('portfolio_account_security_link')} →
          </button>
        </div>
      </Show>

      <Show when={authStatus() !== 'ready'}>
        <div class="portfolio-connect">
          <p>{t('portfolio_connect_wallet')}</p>
          <button class="wallet-btn primary" onClick={() => navigate('/wallet')}>
            {t('wallet_connect')}
          </button>
        </div>
      </Show>

      <Show when={authStatus() === 'ready'}>
        {/* KLV + fiat total summary */}
        <div class="portfolio-summary">
          <div class="portfolio-summary-row">
            <span class="portfolio-klv-label">KLV</span>
            <span class="portfolio-klv-value">{totalKlvValue()}</span>
          </div>
          <Show when={totalFiat() !== null && totalFiat()! > 0}>
            <div class="portfolio-summary-fiat">
              <span class="portfolio-fiat-label">{t('portfolio_total_value')}</span>
              <span class="portfolio-fiat-total">
                {formatFiat(totalFiat()!, currency(), currentLanguage())}
              </span>
            </div>
          </Show>
          <Show when={totalFiat() === null && !prices.loading && !forex.loading}>
            <div class="portfolio-fiat-warning">{t('portfolio_fiat_unavailable')}</div>
          </Show>
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
          <div class="portfolio-table with-fiat">
            <div class="portfolio-table-header">
              <button class="col-token col-sort" onClick={() => cycleSort('token')}>
                {t('portfolio_token')}{sortIndicator('token')}
              </button>
              <button class="col-balance col-sort" onClick={() => cycleSort('balance')}>
                {t('portfolio_balance')}{sortIndicator('balance')}
              </button>
              <button class="col-fiat col-sort" onClick={() => cycleSort('fiat')}>
                {t('portfolio_fiat_value')}{sortIndicator('fiat')}
              </button>
              <span class="col-actions"></span>
            </div>

            <Show when={sortedBalances().length === 0}>
              <div class="portfolio-empty">{t('portfolio_empty')}</div>
            </Show>

            <For each={sortedBalances()}>
              {(token) => {
                const fiat = () => fiatFor(token);
                const change = () => changeFor(token);
                return (
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
                  <div class="col-balance">
                    <span class="balance-amount">{formatBalance(token.balance, token.precision)}</span>
                    <Show when={token.frozenBalance > 0}>
                      <span class="balance-frozen">
                        {t('portfolio_frozen')}: {formatBalance(token.frozenBalance, token.precision)}
                      </span>
                    </Show>
                  </div>
                  <div class="col-fiat">
                    <Show when={fiat() !== null} fallback={<span class="fiat-na">—</span>}>
                      <span class="fiat-amount">{formatFiat(fiat()!, currency(), currentLanguage())}</span>
                      <Show when={change() !== null && Number.isFinite(change()!)}>
                        <span
                          class="change-pill"
                          classList={{
                            'change-up': change()! > 0,
                            'change-down': change()! < 0,
                            'change-flat': change() === 0,
                          }}
                        >
                          {change()! > 0 ? '+' : ''}{change()!.toFixed(2)}%
                        </span>
                      </Show>
                    </Show>
                  </div>
                  <div class="col-actions">
                    <button
                      class="token-send-btn"
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
              );
              }}
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

        {/* Receive dialog — show wallet address for inbound transfers. */}
        <Show when={receiveOpen()}>
          <div class="send-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeReceive(); }}>
            <div class="send-dialog">
              <div class="send-dialog-header">
                <h3>{t('portfolio_receive_title')}</h3>
                <button class="send-close-btn" onClick={closeReceive}>✕</button>
              </div>
              <p class="receive-warning">{t('portfolio_receive_warning')}</p>
              <div class="receive-address-box">
                <code class="receive-address">{walletAddress() || ''}</code>
              </div>
              <button class="wallet-btn primary send-confirm-btn" onClick={copyAddress}>
                {copyHint() ? t('portfolio_copied') : t('portfolio_copy_address')}
              </button>
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
          margin-bottom: var(--spacing-sm);
          min-height: 56px;
        }
        .portfolio-header h2 {
          font-size: var(--font-size-xl);
          margin: 0;
        }
        .portfolio-header-actions {
          display: flex;
          gap: var(--spacing-xs);
          align-items: center;
        }
        .portfolio-action-btn {
          padding: var(--spacing-xs) var(--spacing-md);
          border-radius: var(--radius-md);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          font-size: var(--font-size-sm);
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .portfolio-action-btn:hover { opacity: 0.85; }
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
        .portfolio-sublink {
          margin-bottom: var(--spacing-md);
        }
        .portfolio-link {
          background: none;
          padding: 0;
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          cursor: pointer;
        }
        .portfolio-link:hover { color: var(--color-accent-primary); }

        .portfolio-connect {
          text-align: center;
          padding: var(--spacing-xl);
          color: var(--color-text-secondary);
        }
        .portfolio-connect p { margin-bottom: var(--spacing-md); }

        .portfolio-summary {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-xs);
          padding: var(--spacing-md) var(--spacing-lg);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-lg);
          margin-bottom: var(--spacing-lg);
        }
        .portfolio-summary-row {
          display: flex;
          align-items: baseline;
          gap: var(--spacing-sm);
        }
        .portfolio-summary-fiat {
          display: flex;
          align-items: baseline;
          gap: var(--spacing-sm);
          border-top: 1px solid var(--color-border);
          padding-top: var(--spacing-xs);
          margin-top: var(--spacing-xs);
        }
        .portfolio-klv-label, .portfolio-fiat-label {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          font-weight: 600;
        }
        .portfolio-klv-value {
          font-size: var(--font-size-xxl, 1.75rem);
          font-weight: 700;
          color: var(--color-text-primary);
        }
        .portfolio-fiat-total {
          font-size: var(--font-size-lg);
          font-weight: 700;
          color: var(--color-accent-primary);
        }
        .portfolio-fiat-warning {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          font-style: italic;
          padding-top: var(--spacing-xs);
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
          grid-template-columns: 2fr 1.2fr 1.2fr 140px;
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
          grid-template-columns: 2fr 1.2fr 1.2fr 140px;
          padding: var(--spacing-sm) var(--spacing-md);
          align-items: center;
          border-top: 1px solid var(--color-border);
          transition: background 0.1s;
        }
        .portfolio-row:hover {
          background: var(--color-bg-tertiary);
        }

        /* Clickable column headers — small chevron next to the label
           reflects current sort key/direction. */
        .col-sort {
          background: none;
          padding: 0;
          text-align: inherit;
          font: inherit;
          color: inherit;
          text-transform: inherit;
          letter-spacing: inherit;
          cursor: pointer;
          user-select: none;
          transition: color 0.1s;
        }
        .col-sort:hover { color: var(--color-text-primary); }
        .portfolio-table-header .col-balance,
        .portfolio-table-header .col-fiat {
          text-align: right;
          padding-right: var(--spacing-md);
        }

        .col-token {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          min-width: 0;
        }
        .col-balance, .col-fiat {
          font-family: monospace;
          font-size: var(--font-size-sm);
          text-align: right;
          padding-right: var(--spacing-md);
        }
        .col-balance { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        .balance-amount { color: var(--color-text-primary); }
        .balance-frozen {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          font-family: monospace;
        }
        .col-fiat { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        .fiat-amount { color: var(--color-text-primary); font-weight: 600; }
        .fiat-na { color: var(--color-text-secondary); }
        .change-pill {
          display: inline-block;
          font-size: var(--font-size-xs);
          font-weight: 600;
          padding: 0 6px;
          border-radius: var(--radius-sm);
          font-family: inherit;
        }
        .change-up   { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 12%, transparent); }
        .change-down { color: var(--color-error);   background: color-mix(in srgb, var(--color-error)   12%, transparent); }
        .change-flat { color: var(--color-text-secondary); background: var(--color-bg-tertiary); }
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

        /* Per-row Send button — deliberately a distinct class from the
           chat composer's .send-btn so the design-style overrides for the
           chat send icon don't shape this into a tiny circle.
           Resting color is a darkened mix of accent-primary so the button
           recedes against the dark surface; hover lifts it back to the
           full accent so the affordance reads. Works across every color
           scheme (blue, orange, teal, purple) because the mix is derived
           from the active --color-accent-primary token. */
        .token-send-btn {
          padding: 6px 16px;
          min-height: 30px;
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          font-weight: 600;
          background: color-mix(in srgb, var(--color-accent-primary) 72%, #000);
          color: var(--color-text-inverse, #fff);
          cursor: pointer;
          transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
          white-space: nowrap;
        }
        .token-send-btn:hover:not(:disabled) {
          background: var(--color-accent-primary);
          transform: translateY(-1px);
          box-shadow: 0 2px 8px color-mix(in srgb, var(--color-accent-primary) 35%, transparent);
        }
        .token-send-btn:active:not(:disabled) { transform: translateY(0); }
        .token-send-btn:disabled {
          background: color-mix(in srgb, var(--color-accent-primary) 40%, #000);
          opacity: 0.5;
          cursor: not-allowed;
        }

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

        .receive-warning {
          font-size: var(--font-size-sm);
          color: var(--color-warning);
          margin: 0 0 var(--spacing-md);
          line-height: 1.5;
        }
        .receive-address-box {
          padding: var(--spacing-md);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          margin-bottom: var(--spacing-md);
          text-align: center;
        }
        .receive-address {
          font-family: monospace;
          font-size: var(--font-size-sm);
          color: var(--color-accent-primary);
          word-break: break-all;
          display: inline-block;
        }
      `}</style>
    </div>
  );
};
