/**
 * Auto-join for encrypted PUBLIC channels — at most once per account, per
 * channel, per session.
 *
 * Reading or posting in an encrypted channel requires membership: the node
 * only wraps the epoch key to members, and anyone may join a public channel
 * permissionlessly. So opening an encrypted public channel joins it.
 *
 * What this module does NOT decide is WHETHER a channel qualifies — that is
 * `shouldAutoJoinEncryptedChannel` (channelEncryption.ts), which requires
 * positive evidence (a resolved, non-restricted, non-private record with
 * `encryption_enabled === true`). The previous inline version keyed the
 * decision off the fail-CLOSED `isEncrypted()` and so fired a real,
 * server-side `joinChannel` for any channel whose record was still loading or
 * failed to fetch — including another account's private channel carried over
 * by a stale route after an account switch.
 *
 * The de-dup set is keyed `${wallet}:${channelId}` and dropped on every wallet
 * switch, so one account's "already joined" never suppresses (or stands in
 * for) another account's join. A failed join removes its key so the next
 * attempt can retry.
 */

import { getWalletScope, registerWalletSwitchReset } from './walletScope.ts';

/** Signature of the network join call. Supplied by the caller (the API
 *  client lives there), so this module never awaits anything between the
 *  wallet check and the call — see `ensureEncryptedChannelMembership`. */
export type JoinFn = (channelId: number) => Promise<unknown>;

const attempted = new Set<string>();

/** Upper bound so a pathological session cannot grow the set without limit.
 *  Clearing only re-allows idempotent joins; it never suppresses one. */
const MAX_TRACKED = 2000;

registerWalletSwitchReset(() => attempted.clear());

/**
 * Join `channelId` as `wallet` unless this account already tried it this
 * session. Returns `true` when a join was started by this call.
 *
 * No-op when `wallet` is not the account storage is currently scoped to: the
 * client signs as the active account, so a caller holding a stale address
 * must never produce a join attributed to whoever is active now.
 *
 * The scope check and the `join` invocation run in the SAME synchronous turn
 * (an earlier version awaited a lazy `import('./api')` in between, so the
 * check could pass for one account and the join be signed by the next).
 */
export function ensureEncryptedChannelMembership(
  channelId: number,
  wallet: string,
  join: JoinFn,
): boolean {
  if (!Number.isSafeInteger(channelId) || channelId <= 0 || !wallet) return false;
  const key = `${wallet}:${channelId}`;
  if (attempted.has(key)) return false;
  if (getWalletScope() !== wallet) return false;
  if (attempted.size >= MAX_TRACKED) attempted.clear();
  attempted.add(key);
  let p: Promise<unknown>;
  try {
    p = join(channelId);
  } catch {
    attempted.delete(key);
    return false;
  }
  void Promise.resolve(p).catch(() => {
    // Re-arm so a later visit retries (transient network / rate limit). Only
    // OUR key — a wallet switch may already have cleared the set.
    attempted.delete(key);
  });
  return true;
}

/** Test hook: forget every attempt. */
export function __resetAutoJoinForTests(): void {
  attempted.clear();
}
