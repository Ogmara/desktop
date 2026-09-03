/**
 * The account index — reading it as a union, and mutating it without loss.
 *
 * `vaultAccounts.ts` holds the pure merge rules; this module is where they
 * meet storage. The two invariants it exists to enforce, both of which mobile
 * violated and had to fix in a second audit round:
 *
 *   1. **A read is the UNION of every source.** An account absent from one
 *      source is not absent.
 *   2. **A write merges INTO what is persisted**, never over it. Persisting a
 *      probed or display-capped subset erases accounts whose slot was briefly
 *      unreadable — a transient storage failure becomes permanent data loss.
 *
 * Storage and the keystore listing are injected so both can be made to fail in
 * tests, which is the only honest way to check invariant 1.
 */

import {
  AS,
  SS,
  MAX_ACCOUNTS,
  isValidAddress,
  mergeIndexes,
  parseIndex,
  parseMirror,
  parseAddressesFromScopedKeys,
  serializeMirror,
  type AccountEntry,
} from './vaultAccounts.ts';
import type { StoreLike } from './vaultDek.ts';

/** The localStorage half of the index, injected for testability. */
export interface LocalLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Every key, for the `<base>::<address>` recovery scan. */
  keys(): string[];
}

/** How the index learns which addresses have a key slot on disk. */
export type ListKeystore = () => Promise<string[]>;

/**
 * Read the account index as the union of all four sources.
 *
 * Every source is optional and every one is allowed to fail: a poisoned secure
 * store, a cleared localStorage, or an older shell without the keystore
 * command each degrade the result rather than emptying it.
 */
export async function readIndex(
  store: StoreLike,
  local: LocalLike,
  listKeystore: ListKeystore,
): Promise<AccountEntry[]> {
  const primary = parseIndex(safeLocalGet(local, AS.primaryIndex));
  const mirror = parseMirror(await store.getItemAsync(SS.mirror).catch(() => null));
  // The scan is the ONLY untrusted source — a preference key proves someone
  // once stored a setting, not that a key slot exists — so it is the one that
  // gets capped.
  const scanned = parseAddressesFromScopedKeys(safeKeys(local)).slice(0, MAX_ACCOUNTS);
  // The keystore listing proves a slot exists, so it is never capped: dropping
  // one would hide a real, recoverable account.
  let keystore: string[] = [];
  try {
    keystore = (await listKeystore()).filter(isValidAddress);
  } catch {
    /* older shell, or a poisoned store — the other sources still resolve */
  }
  return mergeIndexes(primary, mirror, scanned, keystore);
}

/** The address recorded as active, if it is still usable. */
export async function readActive(store: StoreLike): Promise<string | null> {
  const a = await store.getItemAsync(SS.active).catch(() => null);
  return a && isValidAddress(a) ? a : null;
}

/** Record the active account. */
export async function writeActive(store: StoreLike, addr: string): Promise<void> {
  if (!isValidAddress(addr)) throw new Error('invalid address');
  await store.setItemAsync(SS.active, addr);
}

/**
 * Add or update one entry, merging into what is already persisted.
 *
 * Deliberately re-reads inside: callers hold a list that may be stale or
 * probed, and writing that back is exactly the loss this module prevents.
 */
export async function persistIndexAdding(
  entry: AccountEntry,
  store: StoreLike,
  local: LocalLike,
  listKeystore: ListKeystore,
): Promise<AccountEntry[]> {
  const current = await readIndex(store, local, listKeystore);
  const merged = mergeIndexes([entry, ...current.filter((e) => e.a !== entry.a)], [], [], []);
  await writeIndex(merged, store, local);
  return merged;
}

/**
 * Remove one entry. The ONLY path that may shrink the index.
 *
 * Everything else merges; removal is explicit and always user-initiated, so a
 * missing account can never be the result of a failed read.
 */
export async function persistIndexRemoving(
  addr: string,
  store: StoreLike,
  local: LocalLike,
  listKeystore: ListKeystore,
): Promise<AccountEntry[]> {
  const current = await readIndex(store, local, listKeystore);
  const remaining = current.filter((e) => e.a !== addr);
  await writeIndex(remaining, store, local);
  return remaining;
}

/** Write both index copies. Best-effort each — one failing must not lose the other. */
async function writeIndex(
  entries: AccountEntry[],
  store: StoreLike,
  local: LocalLike,
): Promise<void> {
  try {
    local.setItem(AS.primaryIndex, JSON.stringify(entries));
  } catch {
    /* quota or private mode — the secure-store mirror still carries it */
  }
  await store.setItemAsync(SS.mirror, serializeMirror(entries)).catch(() => {});
}

function safeLocalGet(local: LocalLike, key: string): string | null {
  try {
    return local.getItem(key);
  } catch {
    return null;
  }
}

function safeKeys(local: LocalLike): string[] {
  try {
    return local.keys();
  } catch {
    return [];
  }
}

/** The browser-backed `LocalLike` used in the app. */
export const browserLocal: LocalLike = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  keys: () => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out.push(k);
    }
    return out;
  },
};
