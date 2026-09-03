/**
 * Multi-account index — the pure, storage-agnostic core.
 *
 * Ported from `mobile/src/lib/vaultAccounts.ts`, which is the reference for
 * this pattern. Every rule here encodes a finding from that implementation's
 * audit rounds; the divergences below are deliberate and are the only ones.
 *
 * **Desktop's store is enumerable.** `SecureFileStore` is a `HashMap`
 * persisted to `.secure-store.json`, and `secure_store_list_vault_accounts`
 * exposes the addresses that have a key slot. Mobile's premise — "SecureStore
 * has no enumeration API, so the index is the only way to find a key, which
 * makes it a single point of wallet loss" — therefore does NOT hold here. The
 * index is a metadata cache, and the keystore listing is a fourth source whose
 * presence *proves* a slot exists rather than merely recording that one did.
 *
 * The redundancy is kept anyway, because the Rust call can fail on a poisoned
 * store:
 *   1. the keystore listing (highest provenance — never capped),
 *   2. a primary index in localStorage (carries labels),
 *   3. a mirror in the secure store (addresses only),
 *   4. a RECOVERY SCAN over `<base>::<address>` preference keys (untrusted).
 * `mergeIndexes` unions all four and never silently drops an entry.
 *
 * The pure functions here are unit-tested directly; the storage-touching logic
 * that consumes them lives in `vault.ts`.
 */

/** One account as recorded in the index. */
export interface AccountEntry {
  /** Wallet address (`klv1…`). The identity everything else is keyed by. */
  a: string;
  /** User-supplied label, or null to fall back to the node display name. */
  label: string | null;
  /**
   * How the wallet is held.
   *
   * Always `'builtin'` on desktop — `auth.ts` declares
   * `WalletSource = 'builtin' | null`, with no Klever extension and no K5
   * delegation. Mobile's `'k5-delegation'` variant and its `external` field
   * are deliberately NOT ported: the exclusion filters they require
   * (`switchAccount`, `removeAccount`, the disconnect fallback) would be dead
   * code here that reads as meaningful and misleads the next reviewer.
   */
  source: 'builtin';
  /** Unix ms when the account was added. */
  added: number;
}

/**
 * Secure-store keys.
 *
 * `.` is the separator, matching mobile. A bech32 address is `[a-z0-9]+`, so a
 * `.`-suffixed key is unambiguous. Every key MUST start with `ogmara.vault.`
 * — the Rust `validate_key` allowlist rejects anything else outright, which is
 * why mobile's `ogmara.e2e.*` naming cannot be used for the E2E secret here.
 */
export const SS = {
  legacyRaw: 'ogmara.vault.private_key',
  legacyEnc: 'ogmara.vault.encrypted_key',
  legacyMode: 'ogmara.vault.mode',
  version: 'ogmara.vault.version',
  mirror: 'ogmara.vault.accounts',
  active: 'ogmara.vault.active',
  /** Deferred v1→v2 marker, set when the vault is PIN'd at migration time. */
  pending: 'ogmara.vault.v2_pending',
  /** Journal for setupPin / removePin / changePin, so a crash can be resumed. */
  pinMigration: 'ogmara.vault.pin_migration',
  /** PIN-wrapped data-encryption key, and its redundant copy. */
  dek: 'ogmara.vault.dek',
  dekMirror: 'ogmara.vault.dek.mirror',
  rawFor: (a: string) => `ogmara.vault.private_key.${a}`,
  encFor: (a: string) => `ogmara.vault.encrypted_key.${a}`,
  modeFor: (a: string) => `ogmara.vault.mode.${a}`,
  /** Per-account X25519 E2E secret. Under `ogmara.vault.` for the allowlist. */
  encPrivFor: (a: string) => `ogmara.vault.enc_private_key.${a}`,
} as const;

/** localStorage keys. `::` is the established scope separator there. */
export const AS = {
  primaryIndex: 'ogmara.vault.accounts.index',
  legacyWalletAddress: 'ogmara.walletAddress',
  legacyWalletSource: 'ogmara.walletSource',
} as const;

/**
 * Hard cap on accounts.
 *
 * A UI choice, NOT a storage constraint: `secure_store_set` allows 64 KB per
 * value, so the mirror has no realistic size pressure (mobile's cap existed to
 * fit expo-secure-store's 2048-byte limit). It bounds the account picker and
 * the untrusted recovery scan.
 */
export const MAX_ACCOUNTS = 10;

/** The Rust layer's key rule: allowed prefix, 1–256 chars. */
const ALLOWED_PREFIXES = ['ogmara.vault.', 'ogmara.app_lock.'];

/** True if `key` would be accepted by the Rust `validate_key`. */
export function isStorableKey(key: string): boolean {
  return (
    key.length >= 1 &&
    key.length <= 256 &&
    ALLOWED_PREFIXES.some((p) => key.startsWith(p))
  );
}

/**
 * A syntactically usable wallet address that is safe as a secure-store suffix.
 *
 * The colon check is kept from mobile even though desktop's Rust layer has no
 * such rule: it costs nothing and it pins the `.` separator choice, so a future
 * change to `::` here would fail loudly in tests rather than silently produce
 * ambiguous keys.
 */
export function isValidAddress(a: unknown): a is string {
  return (
    typeof a === 'string' &&
    a.startsWith('klv1') &&
    a.length >= 40 &&
    a.length <= 80 &&
    /^[a-z0-9]+$/.test(a) &&
    !a.includes(':') &&
    isStorableKey(SS.rawFor(a))
  );
}

/** Parse the primary index, tolerating any malformed content. */
export function parseIndex(raw: string | null): AccountEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((e) => e && isValidAddress(e.a))
      .map((e) => ({
        a: e.a as string,
        label: typeof e.label === 'string' ? e.label : null,
        // Coerced, not validated: an index written by a future build (or a
        // hand-edited file) must not introduce a source this client cannot
        // act on.
        source: 'builtin' as const,
        added: typeof e.added === 'number' ? e.added : 0,
      }));
  } catch {
    return [];
  }
}

/** Parse the secure-store mirror (addresses only). */
export function parseMirror(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isValidAddress) : [];
  } catch {
    return [];
  }
}

/**
 * Recover addresses from namespaced preference keys (`<base>::<address>`).
 *
 * Any account that ever stored a preference leaves these behind, so this finds
 * accounts even when both indexes are gone. UNTRUSTED: a preference key alone
 * does not prove the private key is present, so the caller probes for a slot
 * before trusting a result, and this is the source a cap applies to.
 */
export function parseAddressesFromScopedKeys(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const i = k.lastIndexOf('::');
    if (i < 0) continue;
    const candidate = k.slice(i + 2);
    if (isValidAddress(candidate)) out.add(candidate);
  }
  return [...out];
}

/**
 * Union the four sources, preserving the richest entry for each address.
 *
 * Order matters only for metadata: the primary index has labels, so it wins on
 * conflict. Nothing is ever dropped for being absent from one source — that is
 * the whole point.
 *
 * `keystore` is NOT capped by callers: its entries prove a key slot exists, so
 * dropping one would hide a real, recoverable account.
 */
export function mergeIndexes(
  primary: AccountEntry[],
  mirror: string[],
  recovered: string[],
  keystore: string[] = [],
): AccountEntry[] {
  const byAddr = new Map<string, AccountEntry>();
  for (const e of primary) byAddr.set(e.a, e);
  for (const a of [...keystore, ...mirror, ...recovered]) {
    if (isValidAddress(a) && !byAddr.has(a)) {
      byAddr.set(a, { a, label: null, source: 'builtin', added: 0 });
    }
  }
  // Order matters for more than the picker: callers CAP the untrusted scan,
  // so whatever sorts last is what gets evicted.
  //
  // Entries recovered from a scan or the mirror have no timestamp
  // (`added: 0`). Sorting purely ascending put those FIRST and evicted every
  // real, indexed account — turning a cap meant to bound work into a way to
  // lose accounts. Real entries (added > 0) now sort ahead of timestamp-less
  // ones, so a cap sheds unconfirmed candidates first.
  return [...byAddr.values()].sort((x, y) => {
    const xReal = x.added > 0 ? 0 : 1;
    const yReal = y.added > 0 ? 0 : 1;
    if (xReal !== yReal) return xReal - yReal;
    return x.added - y.added || x.a.localeCompare(y.a);
  });
}

/** Serialize the mirror. The cap is the UI bound, not a size limit. */
export function serializeMirror(entries: AccountEntry[]): string {
  return JSON.stringify(entries.slice(0, MAX_ACCOUNTS).map((e) => e.a));
}
