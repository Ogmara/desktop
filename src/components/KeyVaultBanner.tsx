/**
 * Key-vault banner — surfaces when message-key backups are paused to protect
 * the remote key vault (lib/keyVault.ts). Desktop counterpart of web's
 * `KeyVaultBanner` (web 0.84.0), without the wallet-mismatch state: desktop
 * only has the built-in signer, which always signs as the connected account.
 *
 *  - `unreadable` / `missing`: the node's vault can't be opened with this
 *    wallet's key, or the node has no copy of a vault this device has seen.
 *    Backups wait. Retry re-reads the node's vault (e.g. after switching
 *    node); "Replace backup" (behind a confirm) overwrites the node's vault
 *    with this device's keys, which can lose keys only the old backup had.
 *
 * The confirm is the app's own `confirmDialog` — `window.confirm` is broken
 * in the Tauri webview (see components/Dialogs.tsx).
 */

import { Component, Show, createSignal, createEffect } from 'solid-js';
import { t } from '../i18n/init';
import { authStatus } from '../lib/auth';
import { keyVaultIssue, retryKeyVault, replaceKeyVault } from '../lib/keyVault';
import { replaceResultMessageKey } from '../lib/keyVaultCore';
import { confirmDialog } from './Dialogs';

export const KeyVaultBanner: Component = () => {
  const [busy, setBusy] = createSignal(false);
  const [resultMsg, setResultMsg] = createSignal('');
  // Dismissible per occurrence: a NEW issue (kind or wallet change) re-shows it.
  const [dismissed, setDismissed] = createSignal(false);
  let lastKey = '';
  createEffect(() => {
    const issue = keyVaultIssue();
    const key = issue ? `${issue.kind}:${issue.wallet}` : '';
    if (key !== lastKey) {
      setDismissed(false);
      if (key) setResultMsg('');
    }
    lastKey = key;
  });

  const visible = () => authStatus() === 'ready' && !!keyVaultIssue() && !dismissed();

  const body = () => {
    const issue = keyVaultIssue();
    if (!issue) return '';
    return issue.kind === 'unreadable' ? t('keyvault_unreadable_body') : t('keyvault_missing_body');
  };

  const handleRetry = () => {
    setResultMsg('');
    retryKeyVault();
  };

  const handleReplace = async () => {
    // The confirmation is for THIS account: capture it before the (modal,
    // unbounded) wait so a switch while the dialog is open can't redirect it.
    const issue = keyVaultIssue();
    if (!issue) return;
    if (!(await confirmDialog(t('keyvault_replace_confirm')))) return;
    setBusy(true);
    setResultMsg('');
    try {
      const out = await replaceKeyVault(issue.wallet);
      // 'empty' unblocked backups but published nothing: never claim "replaced".
      const msgKey = replaceResultMessageKey(out);
      if (msgKey) setResultMsg(t(msgKey));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Show when={visible()}>
        <div class="keyvault-banner" role="alert">
          <div class="keyvault-banner-text">
            <strong>{t('keyvault_blocked_title')}</strong>
            <span>{body()}</span>
          </div>
          <div class="keyvault-banner-actions">
            <button type="button" class="keyvault-banner-btn" onClick={handleRetry} disabled={busy()}>
              {t('keyvault_retry')}
            </button>
            <button
              type="button"
              class="keyvault-banner-btn-secondary"
              onClick={handleReplace}
              disabled={busy()}
            >
              {t('keyvault_replace')}
            </button>
            <button
              type="button"
              class="keyvault-banner-dismiss"
              title={t('keyvault_dismiss')}
              aria-label={t('keyvault_dismiss')}
              onClick={() => setDismissed(true)}
            >
              ✕
            </button>
          </div>
        </div>
      </Show>
      <Show when={resultMsg()}>
        <div class="keyvault-banner keyvault-banner-result" role="status" aria-live="polite">
          <span>{resultMsg()}</span>
          <button
            type="button"
            class="keyvault-banner-dismiss"
            title={t('keyvault_dismiss')}
            aria-label={t('keyvault_dismiss')}
            onClick={() => setResultMsg('')}
          >
            ✕
          </button>
        </div>
      </Show>
      <style>{`
        .keyvault-banner {
          display: flex; flex-wrap: wrap; gap: var(--spacing-md);
          align-items: center; justify-content: space-between;
          padding: var(--spacing-sm) var(--spacing-md);
          background: color-mix(in srgb, var(--color-warning) 14%, var(--color-bg-secondary));
          border-bottom: 1px solid var(--color-warning);
          color: var(--color-text-primary);
          font-size: var(--font-size-sm);
          flex-shrink: 0;
        }
        .keyvault-banner-result {
          background: var(--color-bg-secondary);
          border-bottom: 1px solid var(--color-border);
        }
        .keyvault-banner-text {
          display: flex; flex-direction: column; gap: 2px;
          flex: 1; min-width: 240px;
        }
        .keyvault-banner-text strong { font-weight: 600; }
        .keyvault-banner-actions { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); flex-shrink: 0; }
        .keyvault-banner-btn {
          background: var(--color-warning); color: #1a1a1a;
          border: none; padding: 6px 14px; border-radius: var(--radius-sm);
          font-weight: 600; cursor: pointer; font-size: var(--font-size-sm);
        }
        .keyvault-banner-btn-secondary {
          background: transparent; color: var(--color-text-primary);
          border: 1px solid var(--color-border);
          padding: 6px 14px; border-radius: var(--radius-sm);
          cursor: pointer; font-size: var(--font-size-sm);
        }
        .keyvault-banner-btn:disabled,
        .keyvault-banner-btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }
        .keyvault-banner-dismiss {
          background: transparent; color: var(--color-text-secondary);
          border: none; padding: 4px 8px; border-radius: var(--radius-sm);
          cursor: pointer; font-size: var(--font-size-md); line-height: 1;
        }
        .keyvault-banner-dismiss:hover { color: var(--color-text-primary); }
        .keyvault-banner button:focus-visible {
          outline: 2px solid var(--color-accent-primary); outline-offset: 2px;
        }
      `}</style>
    </>
  );
};
