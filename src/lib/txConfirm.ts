/**
 * Transaction confirmation broker.
 *
 * When app-lock (PIN) is enabled, every outgoing on-chain transaction
 * is gated by a re-prompt for the PIN. The gate lives at the broadcast
 * layer (`buildSignBroadcast` in `klever.ts`) so it covers transfers,
 * tips, smart-contract calls, and any future broadcast path uniformly.
 *
 * The broker is decoupled from the modal UI: it raises a SolidJS signal
 * carrying a `{summary, resolve, reject}` triple. A top-level
 * `<TxConfirmModal />` (mounted in App.tsx) reacts to the signal and
 * renders the prompt. This way `klever.ts` stays UI-free.
 *
 * No-PIN case:
 *   `isLockEnabled()` is false → the broker resolves immediately. We do
 *   not force PIN setup at broadcast time; Settings already warns the
 *   user that an unencrypted vault is unprotected.
 *
 * Queueing:
 *   If a second request arrives while the first modal is open, the
 *   second is queued (FIFO) and shown after the first resolves. Two
 *   modals never stack.
 *
 * Lock interaction:
 *   `cancelAllPending()` is called from `vaultLock()` so the idle-lock
 *   sweep cleanly rejects any modal that was open when the timeout
 *   fired — no zombie modals after re-unlock.
 */

import { createSignal } from 'solid-js';
import { isLockEnabled } from './appLock';

export class TxConfirmationCancelled extends Error {
  constructor() {
    super('Transaction cancelled');
    this.name = 'TxConfirmationCancelled';
  }
}

export interface PendingConfirmation {
  /** Short, user-visible description of what they're about to authorize. */
  summary: string;
  /** Resolve when the user enters the correct PIN. */
  resolve: () => void;
  /** Reject when the user cancels or the vault locks. */
  reject: (err: Error) => void;
}

const [activeConfirmation, setActiveConfirmation] =
  createSignal<PendingConfirmation | null>(null);

const queue: PendingConfirmation[] = [];

/** Reactive signal observed by `<TxConfirmModal />`. */
export { activeConfirmation };

function dequeue(): void {
  const next = queue.shift();
  if (next) {
    setActiveConfirmation(next);
  } else {
    setActiveConfirmation(null);
  }
}

/**
 * Gate an outgoing transaction on PIN re-entry. Resolves when the user
 * confirms, throws `TxConfirmationCancelled` if they cancel.
 *
 * If app-lock is not enabled, returns immediately with no prompt — the
 * vault is unencrypted on disk anyway, so adding a re-prompt here would
 * be security theatre.
 *
 * @param summary - Specific description to display above the PIN field
 *   (e.g. "Send 1.5 KLV to klv1abc…xyz"). Keep under ~120 chars.
 */
export async function requireTxConfirmation(summary: string): Promise<void> {
  const lockOn = await isLockEnabled();
  if (!lockOn) return;

  return new Promise<void>((resolve, reject) => {
    const entry: PendingConfirmation = { summary, resolve, reject };
    if (activeConfirmation() === null) {
      setActiveConfirmation(entry);
    } else {
      queue.push(entry);
    }
  });
}

/** Called by `<TxConfirmModal />` when the user enters a correct PIN. */
export function approveActive(): void {
  const cur = activeConfirmation();
  if (!cur) return;
  cur.resolve();
  dequeue();
}

/** Called by `<TxConfirmModal />` when the user clicks Cancel. */
export function cancelActive(): void {
  const cur = activeConfirmation();
  if (!cur) return;
  cur.reject(new TxConfirmationCancelled());
  dequeue();
}

/**
 * Reject every pending confirmation. Called from `vaultLock()` to clean
 * up modal state when the idle timer fires while a prompt is open.
 */
export function cancelAllPending(): void {
  const cur = activeConfirmation();
  if (cur) {
    cur.reject(new TxConfirmationCancelled());
  }
  while (queue.length) {
    const e = queue.shift()!;
    e.reject(new TxConfirmationCancelled());
  }
  setActiveConfirmation(null);
}
