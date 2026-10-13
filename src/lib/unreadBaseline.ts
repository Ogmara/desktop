/**
 * Per-account "unread baseline pending" flag for BRAND-NEW wallets.
 *
 * A freshly generated wallet has never read the default channel, so the node
 * reports it as fully unread (capped ≈99) and the tray badge opens on a
 * three-digit number for an account that has done nothing yet. The flag is set
 * ONLY on the create-new paths (`generateWallet`, Add Account → Create) — an
 * imported or restored wallet has real history whose unread state must be left
 * alone — and consumed by the Sidebar once that wallet's first live channel
 * list arrives: it marks the default channel read, then clears the flag.
 *
 * Keys are addressed EXPLICITLY by wallet (`<base>::<address>`, the same layout
 * `walletScope.ts` uses, so `wipeWalletScope` removes it with the account)
 * rather than through the active scope: it is written before the switch to the
 * new account and cleared after an await, and both must hit that account's
 * namespace regardless of which account is active at that instant.
 */

import { SEP } from './walletScope.ts';

const BASE = 'ogmara.unreadBaselinePending';

function keyFor(address: string): string | null {
  return address ? `${BASE}${SEP}${address}` : null;
}

/** Mark `address` as a brand-new wallet whose default channel starts read. */
export function markUnreadBaselinePending(address: string): void {
  const k = keyFor(address);
  if (!k) return;
  try { localStorage.setItem(k, '1'); } catch { /* best-effort */ }
}

/** Whether `address` still owes its first-run baseline. */
export function isUnreadBaselinePending(address: string | null | undefined): boolean {
  const k = address ? keyFor(address) : null;
  if (!k) return false;
  try { return localStorage.getItem(k) === '1'; } catch { return false; }
}

/** Clear the flag once the baseline has been applied. */
export function clearUnreadBaselinePending(address: string): void {
  const k = keyFor(address);
  if (!k) return;
  try { localStorage.removeItem(k); } catch { /* best-effort */ }
}
