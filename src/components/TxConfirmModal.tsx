/**
 * TxConfirmModal — PIN re-prompt overlay shown before broadcasting any
 * outgoing transaction when app-lock is enabled.
 *
 * Mounted once at App.tsx root; reacts to the `activeConfirmation` signal
 * from `lib/txConfirm.ts`. Models its cooldown/wrong-PIN handling on
 * `LockScreen.tsx` via the shared `useCooldown` hook so behavior cannot
 * drift between the two screens.
 */

import { Component, createSignal, createEffect, Show } from 'solid-js';
import { t } from '../i18n/init';
import { verifyPin } from '../lib/appLock';
import {
  activeConfirmation,
  approveActive,
  cancelActive,
} from '../lib/txConfirm';
import { useCooldown } from '../lib/useCooldown';

export const TxConfirmModal: Component = () => {
  const [pin, setPin] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const cooldown = useCooldown();

  // Reset form state every time a new confirmation request appears.
  createEffect(() => {
    if (activeConfirmation()) {
      setPin('');
      setError('');
      setBusy(false);
    }
  });

  async function handleAuthorize() {
    const cur = activeConfirmation();
    if (!cur || busy()) return;
    if (cooldown.remaining() > 0) return;
    if (pin().length < 6) return;

    setBusy(true);
    setError('');
    try {
      const key = await verifyPin(pin());
      if (!key) {
        setPin('');
        await cooldown.refreshAfterFailure();
        if (cooldown.remaining() === 0) {
          setError(t('lock_wrong_pin'));
        }
        return;
      }
      // The CryptoKey is intentionally discarded — the vault is already
      // unlocked. This re-prompt is a confirmation layer, not a vault
      // decryption step.
      approveActive();
    } catch (e: any) {
      // Log the raw error to the devtools console so a vault-corruption
      // failure can be diagnosed in the wild. The user-facing message
      // still falls back to "wrong PIN" — there's no useful action they
      // can take for a deeper crypto fault from this dialog anyway.
      console.warn('[TxConfirmModal] verifyPin threw:', e);
      setError(e?.message || t('lock_wrong_pin'));
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setPin('');
    setError('');
    cancelActive();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleAuthorize();
    if (e.key === 'Escape') handleCancel();
  }

  return (
    <Show when={activeConfirmation()}>
      <div class="tx-confirm-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}>
        <div class="tx-confirm-card" role="dialog" aria-modal="true">
          <h2 class="tx-confirm-title">{t('tx_confirm_title')}</h2>
          <p class="tx-confirm-subtitle">{t('tx_confirm_subtitle')}</p>

          <div class="tx-confirm-summary">{activeConfirmation()!.summary}</div>

          <Show when={cooldown.remaining() > 0} fallback={
            <>
              <input
                ref={(el: HTMLInputElement) => {
                  // Defer focus to the next microtask so the input is
                  // attached to the DOM, but without a setTimeout that
                  // could leak if the modal unmounts before it fires.
                  // queueMicrotask runs synchronously after the current
                  // task, well before any user interaction, so the
                  // focus lands on the right element.
                  queueMicrotask(() => el?.focus());
                }}
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={20}
                value={pin()}
                onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
                onKeyDown={handleKeyDown}
                placeholder="------"
                class="tx-confirm-pin"
                disabled={busy()}
                autocomplete="off"
              />
              <Show when={error()}>
                <p class="tx-confirm-error">{error()}</p>
              </Show>
              <div class="tx-confirm-actions">
                <button
                  class="tx-confirm-btn tx-confirm-cancel"
                  onClick={handleCancel}
                  disabled={busy()}
                >
                  {t('tx_confirm_cancel')}
                </button>
                <button
                  class="tx-confirm-btn tx-confirm-authorize"
                  onClick={handleAuthorize}
                  disabled={busy() || pin().length < 6}
                >
                  {busy() ? '...' : t('tx_confirm_authorize')}
                </button>
              </div>
            </>
          }>
            <p class="tx-confirm-cooldown">
              {t('lock_cooldown', { seconds: cooldown.remaining() })}
            </p>
            <div class="tx-confirm-actions">
              <button class="tx-confirm-btn tx-confirm-cancel" onClick={handleCancel}>
                {t('tx_confirm_cancel')}
              </button>
            </div>
          </Show>
        </div>
      </div>

      <style>{`
        .tx-confirm-overlay {
          position: fixed; inset: 0;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
          z-index: 1100;
        }
        .tx-confirm-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
          width: 420px; max-width: 90vw;
          display: flex; flex-direction: column;
          gap: var(--spacing-sm);
        }
        .tx-confirm-title {
          font-size: var(--font-size-lg);
          color: var(--color-text-primary);
          margin: 0;
        }
        .tx-confirm-subtitle {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          margin: 0 0 var(--spacing-xs);
        }
        .tx-confirm-summary {
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          font-size: var(--font-size-sm);
          color: var(--color-text-primary);
          font-family: monospace;
          word-break: break-all;
          margin-bottom: var(--spacing-sm);
        }
        .tx-confirm-pin {
          width: 100%;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-size: var(--font-size-lg);
          font-family: monospace;
          letter-spacing: 0.3em;
          text-align: center;
        }
        .tx-confirm-pin:focus {
          outline: none;
          border-color: var(--color-accent-primary);
        }
        .tx-confirm-error {
          color: var(--color-error);
          font-size: var(--font-size-sm);
          margin: 0;
        }
        .tx-confirm-cooldown {
          color: var(--color-warning);
          font-size: var(--font-size-sm);
          text-align: center;
          margin: var(--spacing-sm) 0;
        }
        .tx-confirm-actions {
          display: flex; gap: var(--spacing-sm);
          margin-top: var(--spacing-sm);
        }
        .tx-confirm-btn {
          flex: 1;
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .tx-confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .tx-confirm-cancel {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
        }
        .tx-confirm-authorize {
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
        }
        .tx-confirm-authorize:hover:not(:disabled) { opacity: 0.85; }
      `}</style>
    </Show>
  );
};
