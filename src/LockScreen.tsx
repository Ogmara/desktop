/**
 * Lock Screen — shown when the vault is encrypted and locked.
 * User must enter their PIN to unlock and decrypt the private key.
 */

import { Component, createSignal, Show, onCleanup } from 'solid-js';
import { t } from './i18n';
import { verifyPin, getRemainingCooldown, getFailedAttempts, getCooldownSeconds } from './lib/appLock';
import { vaultUnlockWithPin } from './lib/vault';

interface LockScreenProps {
  onUnlock: () => void;
}

export const LockScreen: Component<LockScreenProps> = (props) => {
  const [pin, setPin] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [cooldown, setCooldown] = createSignal(0);

  // Check initial cooldown state
  getRemainingCooldown().then((cd) => {
    if (cd > 0) {
      setCooldown(cd);
      startCooldownTimer();
    }
  });

  let cooldownInterval: ReturnType<typeof setInterval> | undefined;

  onCleanup(() => {
    if (cooldownInterval) clearInterval(cooldownInterval);
  });

  function startCooldownTimer() {
    if (cooldownInterval) clearInterval(cooldownInterval);
    cooldownInterval = setInterval(async () => {
      const remaining = await getRemainingCooldown();
      setCooldown(remaining);
      if (remaining <= 0 && cooldownInterval) {
        clearInterval(cooldownInterval);
        cooldownInterval = undefined;
      }
    }, 1000);
  }

  async function handleUnlock() {
    const currentPin = pin();
    if (currentPin.length < 6) return;

    // Check cooldown first
    const remaining = await getRemainingCooldown();
    if (remaining > 0) {
      setCooldown(remaining);
      startCooldownTimer();
      return;
    }

    setLoading(true);
    setError('');

    try {
      const key = await verifyPin(currentPin);
      if (!key) {
        setPin('');
        // Check if cooldown was triggered
        const failures = await getFailedAttempts();
        const cd = getCooldownSeconds(failures);
        if (cd > 0) {
          setCooldown(cd);
          startCooldownTimer();
        } else {
          setError(t('lock_wrong_pin'));
        }
        return;
      }

      const address = await vaultUnlockWithPin(key);
      if (address) {
        props.onUnlock();
      } else {
        setError(t('lock_wrong_pin'));
        setPin('');
      }
    } catch {
      setError(t('lock_wrong_pin'));
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleUnlock();
  }

  return (
    <div class="lock-screen">
      <div class="lock-card">
        <svg class="lock-logo" viewBox="0 0 512 512">
          <defs>
            <linearGradient id="lbg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#0f0f1a" />
              <stop offset="100%" stop-color="#1a0f2e" />
            </linearGradient>
            <linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#a855f7" />
              <stop offset="50%" stop-color="#6366f1" />
              <stop offset="100%" stop-color="#3b82f6" />
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="96" fill="url(#lbg)" />
          <circle cx="256" cy="256" r="120" fill="none" stroke="url(#lg)" stroke-width="36" stroke-linecap="round" stroke-dasharray="300 50 200 50" transform="rotate(-30 256 256)" />
          <rect x="236" y="236" width="40" height="40" rx="4" fill="url(#lg)" transform="rotate(45 256 256)" />
        </svg>

        <h1>{t('lock_title')}</h1>
        <p class="lock-subtitle">{t('lock_enter_pin')}</p>

        <Show when={cooldown() > 0} fallback={
          <div class="lock-form">
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={20}
              value={pin()}
              onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
              onKeyDown={handleKeyDown}
              placeholder="------"
              class="pin-input"
              disabled={loading()}
              autofocus
            />
            <Show when={error()}>
              <p class="lock-error">{error()}</p>
            </Show>
            <button
              class="btn-primary"
              onClick={handleUnlock}
              disabled={loading() || pin().length < 6}
            >
              {loading() ? '...' : t('lock_unlock')}
            </button>
          </div>
        }>
          <p class="lock-cooldown">
            {t('lock_cooldown').replace('{{seconds}}', cooldown().toString())}
          </p>
        </Show>
      </div>
    </div>
  );
};
