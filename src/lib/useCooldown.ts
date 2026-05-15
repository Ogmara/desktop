/**
 * Shared cooldown timer hook for PIN-protected screens.
 *
 * Both LockScreen and TxConfirmModal need to disable PIN entry while the
 * app-lock cooldown is active (after consecutive wrong-PIN attempts).
 * This module centralizes the polling logic so the two screens cannot
 * drift apart in behavior.
 */

import { createSignal, onCleanup } from 'solid-js';
import { getRemainingCooldown, getCooldownSeconds, getFailedAttempts } from './appLock';

export interface CooldownState {
  /** Current remaining cooldown seconds (0 when ready to accept input). */
  remaining: () => number;
  /**
   * Re-check cooldown after a failed PIN attempt. Reads the latest failed
   * attempt count, computes the new cooldown, and starts the countdown
   * timer if non-zero.
   */
  refreshAfterFailure: () => Promise<void>;
  /** Force-stop the countdown — used when the modal closes mid-cooldown. */
  stop: () => void;
}

/**
 * Create a cooldown-tracking signal scoped to the calling component.
 * Auto-cleans up on dispose. Reads the initial state synchronously
 * (no flicker) by exposing a `prime()` method the caller can `await`.
 */
export function useCooldown(): CooldownState {
  const [remaining, setRemaining] = createSignal(0);
  let interval: ReturnType<typeof setInterval> | undefined;
  // Guard against late async resolutions starting a timer after the
  // component has unmounted. Without this, the initial `getRemainingCooldown`
  // promise could resolve after `onCleanup` fired and leak an interval.
  let disposed = false;

  function stopTimer() {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  }

  function startTimer() {
    if (disposed) return;
    stopTimer();
    interval = setInterval(async () => {
      if (disposed) { stopTimer(); return; }
      const r = await getRemainingCooldown();
      if (disposed) { stopTimer(); return; }
      setRemaining(r);
      if (r <= 0) stopTimer();
    }, 1000);
  }

  // Prime: read any cooldown that was already in effect when the component
  // mounted (e.g. user reopens the modal during an existing cooldown).
  getRemainingCooldown().then((r) => {
    if (disposed) return;
    if (r > 0) {
      setRemaining(r);
      startTimer();
    }
  });

  onCleanup(() => {
    disposed = true;
    stopTimer();
  });

  return {
    remaining,
    stop: stopTimer,
    async refreshAfterFailure() {
      const failures = await getFailedAttempts();
      if (disposed) return;
      const cd = getCooldownSeconds(failures);
      if (cd > 0) {
        setRemaining(cd);
        startTimer();
      }
    },
  };
}
