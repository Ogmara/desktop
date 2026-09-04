/**
 * Per-wallet namespacing for locally cached account state.
 *
 * The project rule is that ALL data is indexed under the wallet address. The
 * vault and E2E layers already honour it; the profile/preference layer did not
 * — topic groups, channel organisation, joined channels, hidden DMs, mutes and
 * news read positions all lived under GLOBAL localStorage keys. Disconnecting
 * one wallet and connecting another therefore left the previous account's
 * lists on screen: confusing, and a privacy leak between accounts on a shared
 * browser.
 *
 * Keys resolved through here become `<base>::<address>`, so two accounts never
 * collide and reconnecting restores what that account had.
 *
 * DEVICE-level settings (language, theme, node URL, font size, sidebar width…)
 * deliberately do NOT go through here: they belong to the browser profile, not
 * to the account.
 *
 * Desktop holds SEVERAL accounts and switches between them at runtime (see
 * `vaultAccounts.ts`), so unlike the web client this is not only a
 * disconnect-time concern: every switch must repoint storage and reload the
 * stores in the same tick, or the previous account's lists stay on screen and
 * the first edit persists them under the new account.
 *
 * Ported from mobile (`mobile/src/lib/walletScope.ts`), which is the reference
 * for this pattern. localStorage is synchronous here, so the reads and writes
 * are too — which removes the microtask window mobile's async AsyncStorage
 * version had to fight.
 */

/** Separator chosen so it cannot occur in a bech32 address or an existing key. */
export const SEP = '::';

/** Set once the legacy global keys have been claimed. Never migrate twice. */
const MIGRATED_MARKER = 'ogmara.walletScope.migrated';

let activeWallet: string | null = null;

/**
 * Monotonic counter, bumped synchronously at the very START of every account
 * switch/disconnect — before `vaultActivate()`, before any await.
 *
 * Exists because a switch does NOT flip every "who's active" signal at once:
 * `vaultActiveAddress()`/`vaultGetSigner()` (vault.ts) flip the instant
 * `vaultActivate()` returns, while `walletAddress()` (auth.ts) and the API
 * client's attached signer don't flip until `tearDownAccountSession()`
 * finishes, several awaits later. An async chain that reads one of those
 * signals, captures it, awaits, and rechecks the SAME signal can still pass
 * every check while straddling the switch, if the signal it happens to use
 * hasn't flipped yet at capture time but has by the time it resolves — or
 * vice versa. A generation bumped before ANY of those signals move closes
 * that regardless of which one a given call site reads, because it changes
 * strictly before the earliest of them does.
 *
 * Found via a real cross-account E2E key leak (2026-09-04): `keyVault.ts`'s
 * restore guarded on `vaultActiveAddress()`, which had already flipped to
 * the new account while the fetch itself was still running as the OLD
 * account (tied to `walletAddress()`/the signer) — so the guard always
 * compared the new account against itself and never caught the mismatch.
 */
let switchGeneration = 0;

/** Bump the generation. Call FIRST in a switch/disconnect, before anything else. */
export function bumpSwitchGeneration(): number {
  return ++switchGeneration;
}

/** The generation as of right now — capture before an async chain, recheck after. */
export function currentSwitchGeneration(): number {
  return switchGeneration;
}

/**
 * Caches and armed timers that must be dropped the instant the active wallet
 * changes.
 *
 * A REGISTRY rather than direct imports, because those stores import from here
 * — calling back into them directly would be an import cycle. Each store
 * registers itself at module load.
 */
const switchResets = new Set<() => void>();

/** Register a cache/timer to be cleared on every wallet-scope change. */
export function registerWalletSwitchReset(fn: () => void): void {
  switchResets.add(fn);
}

/**
 * Fire the resets WITHOUT changing scope.
 *
 * Needed before a disconnect: an armed settings-sync upload timer that fires
 * mid-teardown reads the key via `vaultExportKey()` and would seal the OLD
 * account's data under whatever key is current by then. Cancel first, tear
 * down second.
 */
export function runWalletSwitchResets(): void {
  for (const reset of switchResets) {
    try {
      reset();
    } catch {
      /* one bad reset must not block the rest */
    }
  }
}

/**
 * Point per-wallet storage at `address`, or clear it on sign-out.
 *
 * Must be called BEFORE any per-wallet read, so the boot path sets it as soon
 * as the persisted wallet address is known.
 */
export function setWalletScope(address: string | null): void {
  const next = address && address.length > 0 ? address : null;
  const changed = next !== activeWallet;
  activeWallet = next;
  // Namespacing storage is not enough on its own: stores that memoize in
  // memory hold the previous account's data for the life of the PAGE, so after
  // a switch the old lists still render — and the first edit persists them
  // under the new wallet and syncs them to the node.
  //
  // Runs SYNCHRONOUSLY, in the same tick as the scope flip. A deferred reset
  // (`import(...).then(...)`) leaves a window where `activeWallet` is already
  // the new account while the caches still hold the old one; any read in that
  // window returns the wrong account's data.
  if (changed) {
    for (const reset of switchResets) {
      try {
        reset();
      } catch {
        /* one bad reset must not block the rest of the switch */
      }
    }
  }
}

/** The wallet per-wallet storage is currently pointed at. */
export function getWalletScope(): string | null {
  return activeWallet;
}

/**
 * Namespace `base` to the active wallet.
 *
 * Returns `null` when no wallet is active — there is no per-wallet data
 * without a wallet, and callers must treat that as "nothing stored" rather
 * than falling back to the global key. Falling back is exactly what produced
 * the bug this module exists to fix.
 */
export function scopedKey(base: string): string | null {
  return activeWallet ? `${base}${SEP}${activeWallet}` : null;
}

/** Read from the active wallet's namespace. `null` when no wallet is active. */
export function scopedGet(base: string): string | null {
  const k = scopedKey(base);
  if (!k) return null;
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/** Write into the active wallet's namespace. A no-op with no wallet active. */
export function scopedSet(base: string, value: string): void {
  const k = scopedKey(base);
  if (!k) return;
  try {
    localStorage.setItem(k, value);
  } catch {
    /* quota or private-mode failure must not break the app */
  }
}

/** Remove one key from the active wallet's namespace. */
export function scopedRemove(base: string): void {
  const k = scopedKey(base);
  if (!k) return;
  try {
    localStorage.removeItem(k);
  } catch {
    /* best-effort */
  }
}

/**
 * Delete every key belonging to `address` (defaults to the active wallet).
 *
 * Called on disconnect so a signed-out account leaves nothing behind in the
 * browser. Namespacing alone would keep the data addressable forever; wiping
 * alone would lose it on every reconnect. Doing both means an account's data
 * survives the extension switching away and back, but not a deliberate
 * disconnect.
 */
export function wipeWalletScope(address?: string | null): void {
  const target = address ?? activeWallet;
  if (!target) return;
  const suffix = `${SEP}${target}`;
  try {
    // Collect first: removing while iterating localStorage's live index skips
    // entries, which would leave some of the account's data behind.
    const mine: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.endsWith(suffix)) mine.push(k);
    }
    for (const k of mine) localStorage.removeItem(k);
  } catch {
    /* best-effort */
  }
}

/**
 * Every global key that predates namespacing — from `settings.ts` and the
 * standalone stores alike. One list, so the one-shot migration cannot miss a
 * store.
 */
const ALL_LEGACY_BASES = [
  // settings.ts, per-wallet entries
  'ogmara.pinnedChannels',
  'ogmara.mutedChannels',
  'ogmara.mutedUsers',
  'ogmara.deviceRegistered',
  'ogmara.encKeyBound',
  'ogmara.deviceId',
  'ogmara.newsLastReadGlobal',
  'ogmara.newsLastReadFollowing',
  'ogmara.newsLastViewedAt',
  'ogmara.lastSeenNotifTs',
  'ogmara.lastChannel',
  // standalone stores
  'ogmara.topicGroups',
  'ogmara.channelOrg',
  'ogmara.groupCollapsed',
  'ogmara.hiddenDms',
  'ogmara.ownAvatar',
  // NOTE the underscore — this store predates the dotted convention.
  'ogmara_joined_channels',
] as const;

/**
 * Claim the pre-namespacing global keys for the wallet that owned them —
 * exactly once, ever.
 *
 * **Must run before any wallet is connected or restored in a session.**
 * The naive version (migrate on every boot, into whatever wallet is active) is
 * actively dangerous: on a browser that still holds an old account's global
 * keys — which is every browser upgrading to this build — a user who connects
 * a DIFFERENT wallet would have the old account's channels and topic groups
 * permanently adopted into the new namespace. That is the reported bug, made
 * worse and made irreversible.
 *
 * The owner of the legacy data is whoever was last active, i.e. the persisted
 * global `ogmara.walletAddress`. With no owner the data is orphaned and is
 * discarded rather than handed to the next wallet to appear.
 */
export function runWalletScopeMigrationOnce(): void {
  try {
    if (localStorage.getItem(MIGRATED_MARKER)) return;
    // Read the GLOBAL key directly — it predates namespacing by definition.
    // Stored JSON-encoded by settings.ts, so unwrap the quotes.
    const rawOwner = localStorage.getItem('ogmara.walletAddress');
    let owner: string | null = null;
    if (rawOwner) {
      try {
        const parsed = JSON.parse(rawOwner);
        owner = typeof parsed === 'string' && parsed ? parsed : null;
      } catch {
        owner = rawOwner || null;
      }
    }
    for (const base of ALL_LEGACY_BASES) {
      const legacy = localStorage.getItem(base);
      if (legacy === null) continue;
      if (owner) {
        const target = `${base}${SEP}${owner}`;
        // Never overwrite data already under the wallet.
        if (localStorage.getItem(target) === null) {
          localStorage.setItem(target, legacy);
        }
      }
      // Remove either way: leaving it lets the next account inherit it.
      localStorage.removeItem(base);
    }
    localStorage.setItem(MIGRATED_MARKER, '1');
  } catch {
    // Never block startup. The marker stays unset, so a later load retries.
  }
}

/** Read another account's namespace without switching scope. */
export function scopedGetFor(address: string, base: string): string | null {
  if (!address) return null;
  try {
    return localStorage.getItem(`${base}${SEP}${address}`);
  } catch {
    return null;
  }
}
