/**
 * PIN Setup — modal flow for creating a new PIN code.
 * Two-step: enter PIN, then confirm. On success, encrypts the vault.
 */

import { Component, createSignal, Show, onCleanup, onMount } from 'solid-js';
import { t } from './i18n/init';
import { setupPin } from './lib/appLock';
import { vaultEncryptWithPin } from './lib/vault';

interface PinSetupProps {
  onComplete: () => void;
  onCancel: () => void;
}

export const PinSetup: Component<PinSetupProps> = (props) => {
  const [step, setStep] = createSignal<'enter' | 'confirm'>('enter');
  const [pin, setPin] = createSignal('');
  const [confirmPin, setConfirmPin] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  let enterRef: HTMLInputElement | undefined;
  let confirmRef: HTMLInputElement | undefined;

  // Clear sensitive PIN data from signals on unmount
  onCleanup(() => {
    setPin('');
    setConfirmPin('');
  });

  // Auto-focus the first input on mount
  onMount(() => {
    setTimeout(() => enterRef?.focus(), 50);
  });

  function handleNext() {
    if (pin().length < 6) return;
    setStep('confirm');
    setConfirmPin('');
    setError('');
    // Focus confirm input after SolidJS renders the new view
    setTimeout(() => confirmRef?.focus(), 50);
  }

  async function handleConfirm() {
    if (confirmPin() !== pin()) {
      setError(t('pin_setup_mismatch'));
      setConfirmPin('');
      setTimeout(() => confirmRef?.focus(), 50);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const key = await setupPin(pin());
      await vaultEncryptWithPin(key);
      setPin('');
      setConfirmPin('');
      props.onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set up PIN');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (step() === 'enter') handleNext();
      else handleConfirm();
    }
    if (e.key === 'Escape') {
      if (step() === 'confirm') {
        setStep('enter');
        setConfirmPin('');
        setError('');
        setTimeout(() => enterRef?.focus(), 50);
      } else {
        props.onCancel();
      }
    }
  }

  return (
    <div class="pin-setup-overlay">
      <div class="pin-setup-card">
        <h2>{t('pin_setup_title')}</h2>
        <p class="pin-setup-desc">{t('pin_setup_desc')}</p>

        <Show when={step() === 'enter'} fallback={
          <div class="lock-form">
            <label class="pin-label">{t('pin_setup_confirm')}</label>
            <input
              ref={confirmRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={20}
              value={confirmPin()}
              onInput={(e) => setConfirmPin(e.currentTarget.value.replace(/\D/g, ''))}
              onKeyDown={handleKeyDown}
              placeholder="------"
              class="pin-input"
              disabled={loading()}
            />
            <Show when={error()}>
              <p class="lock-error">{error()}</p>
            </Show>
            <div class="pin-setup-actions">
              <button
                class="btn-secondary"
                onClick={() => {
                  setStep('enter');
                  setConfirmPin('');
                  setError('');
                  setTimeout(() => enterRef?.focus(), 50);
                }}
                disabled={loading()}
              >
                {t('pin_setup_cancel')}
              </button>
              <button
                class="btn-primary"
                onClick={handleConfirm}
                disabled={loading() || confirmPin().length < 6}
              >
                {loading() ? '...' : t('pin_setup_save')}
              </button>
            </div>
          </div>
        }>
          <div class="lock-form">
            <label class="pin-label">{t('pin_setup_enter')}</label>
            <input
              ref={enterRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={20}
              value={pin()}
              onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
              onKeyDown={handleKeyDown}
              placeholder="------"
              class="pin-input"
            />
            <div class="pin-setup-actions">
              <button class="btn-secondary" onClick={props.onCancel}>
                {t('pin_setup_cancel')}
              </button>
              <button
                class="btn-primary"
                onClick={handleNext}
                disabled={pin().length < 6}
              >
                {t('pin_setup_confirm')}
              </button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};
