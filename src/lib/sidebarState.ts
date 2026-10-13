/**
 * Pure pieces of the Sidebar's per-account state handling, extracted so the
 * account-ownership rules are unit-testable (see sidebarState.test.ts). The
 * Sidebar never unmounts on an account switch, which is why each of these
 * carries an explicit owner instead of relying on component lifetime.
 */

/**
 * Whether the channel list currently held by the Sidebar may drive a WRITE
 * into the active account's storage (joined-channels sync, the fresh-account
 * unread baseline).
 *
 * Only a list fetched LIVE for exactly this wallet qualifies: not one still in
 * flight (Solid keeps showing the previous value — possibly the previous
 * account's — while loading), not a cached fallback (`liveOwner` null), and
 * not one fetched for another wallet.
 */
export function canUseLiveChannelList(args: {
  loading: boolean;
  liveOwner: string | null;
  wallet: string | null | undefined;
  authReady: boolean;
}): boolean {
  const { loading, liveOwner, wallet, authReady } = args;
  return !loading && authReady && !!wallet && liveOwner === wallet;
}

/**
 * Route memory that belongs to ONE account. Every read and write names the
 * wallet asking; if it differs from the owner, the memory is reset to its
 * defaults first, so one account can never read (or append to) another's.
 */
export interface OwnedMemory<T> {
  /** Current value for `wallet` (resets first if `wallet` isn't the owner). */
  read(wallet: string | null): T;
  /** Merge `patch` into `wallet`'s memory (resets first if not the owner). */
  write(wallet: string | null, patch: Partial<T>): void;
  /** Reset to defaults and make `wallet` the owner. */
  reset(wallet: string | null): void;
  /** The wallet the memory currently belongs to. */
  owner(): string | null;
}

export function createOwnedMemory<T extends object>(
  defaults: () => T,
  initialOwner: string | null,
): OwnedMemory<T> {
  let owner = initialOwner;
  let value = defaults();
  const ensure = (wallet: string | null) => {
    if (wallet !== owner) {
      owner = wallet;
      value = defaults();
    }
  };
  return {
    read(wallet) { ensure(wallet); return value; },
    write(wallet, patch) { ensure(wallet); value = { ...value, ...patch }; },
    reset(wallet) { owner = wallet; value = defaults(); },
    owner: () => owner,
  };
}
