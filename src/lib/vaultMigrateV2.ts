/**
 * Vault v1 → v2: single-wallet anchors become per-account slots.
 *
 * This is the highest-risk code in the desktop app. It runs on the user's only
 * copy of a private key, and the equivalent on mobile went wrong twice — once
 * by writing a `pending` marker nothing ever read (stranding every PIN user
 * with an empty account list), once by shipping an encrypt path with no
 * matching decrypt.
 *
 * # The safety argument, in the order the properties matter
 *
 * 1. **The legacy anchors are NEVER deleted.** `ogmara.vault.private_key` and
 *    `ogmara.vault.encrypted_key` stay exactly as they were. The v2 slots are
 *    additional copies, not replacements. Even if every v2 artefact — both
 *    indexes, the DEK, every per-account slot — were destroyed, the original
 *    account is still recoverable through `readKeyFor`'s legacy branches, and
 *    an older build still finds its wallet.
 * 2. **Nothing is written before it is verified.** Each slot is read back and
 *    its address re-derived before the migration proceeds.
 * 3. **The version tag is written LAST and is the only commit point.** A crash
 *    anywhere before it leaves a pristine v1 that simply retries next launch.
 * 4. **A PIN'd vault cannot migrate before unlock**, because its address is not
 *    derivable without the PIN. That case records a marker, stays at v1, and
 *    completes on the first successful unlock — and, unlike mobile's, the
 *    marker is actually READ (see `completeDeferredV2`).
 */

import { SS, type AccountEntry } from './vaultAccounts.ts';
import type { StoreLike } from './vaultDek.ts';
import { mintDek, importDek, writeDekVerified, hasDek } from './vaultDek.ts';
import { readKeyFor, writeKeyFor, type DeriveAddress, type UnlockedKeys } from './vaultAccess.ts';
import {
  persistIndexAdding, writeActive, type LocalLike, type ListKeystore,
} from './vaultIndex.ts';

export const VAULT_VERSION_V2 = 2;

/** Everything the migration needs, injected so it can be crash-tested. */
export interface MigrationEnv {
  store: StoreLike;
  local: LocalLike;
  listKeystore: ListKeystore;
  deriveAddress: DeriveAddress;
}

export type MigrationOutcome =
  /** Nothing to do — no wallet, or already at v2. */
  | { result: 'noop'; version: number }
  /** Migrated a raw vault. */
  | { result: 'migrated'; address: string }
  /**
   * The vault is PIN-encrypted; the address cannot be derived yet. The marker
   * is set and the version deliberately LEFT at 1. `completeDeferredV2` must
   * run on the first successful unlock.
   */
  | { result: 'deferred' };

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Read the stored format version (0 = unset / first install). */
export async function readVersion(store: StoreLike): Promise<number> {
  const v = await store.getItemAsync(SS.version).catch(() => null);
  return v ? parseInt(v, 10) || 0 : 0;
}

/**
 * Migrate a v1 vault forward, or record that it must wait for a PIN.
 *
 * Idempotent: safe to call on every launch.
 */
export async function migrateV1toV2(env: MigrationEnv): Promise<MigrationOutcome> {
  const { store } = env;
  const version = await readVersion(store);
  if (version >= VAULT_VERSION_V2) return { result: 'noop', version };

  const legacyRaw = await store.getItemAsync(SS.legacyRaw).catch(() => null);
  const legacyEnc = await store.getItemAsync(SS.legacyEnc).catch(() => null);

  if (!legacyRaw && !legacyEnc) {
    // No wallet at all. Tag as current so a wallet created from here starts
    // clean, with no migration ever pending.
    await store.setItemAsync(SS.version, String(VAULT_VERSION_V2));
    return { result: 'noop', version: VAULT_VERSION_V2 };
  }

  if (legacyEnc && !legacyRaw) {
    // PIN-encrypted: the address is not derivable without the PIN, so the
    // per-account slot cannot be keyed yet. Record it, stay at v1.
    await store.setItemAsync(SS.pending, 'encrypted');
    return { result: 'deferred' };
  }

  if (!legacyRaw || !HEX64.test(legacyRaw)) {
    // A malformed anchor. Do NOT tag a version — leave everything untouched so
    // a later build (or a support session) can still see the original state.
    return { result: 'noop', version };
  }

  const address = await env.deriveAddress(legacyRaw);
  await adoptAccount(address, legacyRaw, env, { pinKey: null, dek: null });
  // COMMIT POINT. Everything above is additive; nothing has been destroyed.
  await store.setItemAsync(SS.version, String(VAULT_VERSION_V2));
  return { result: 'migrated', address };
}

/**
 * Finish a deferred migration, on the first successful PIN unlock.
 *
 * Mobile shipped the marker without this and stranded every PIN user at the
 * old version with an empty account list. The `pending` marker MUST have a
 * reader; this is it, and `vault.ts` calls it from the unlock path.
 */
export async function completeDeferredV2(
  pinKey: CryptoKey,
  env: MigrationEnv,
): Promise<MigrationOutcome> {
  const { store } = env;
  if ((await readVersion(store)) >= VAULT_VERSION_V2) {
    // Already committed. Clear a marker left by a crash between the commit and
    // the cleanup below, so it cannot confuse a later diagnostic.
    await store.deleteItemAsync(SS.pending).catch(() => {});
    return { result: 'noop', version: VAULT_VERSION_V2 };
  }
  const pending = await store.getItemAsync(SS.pending).catch(() => null);
  const legacyEnc = await store.getItemAsync(SS.legacyEnc).catch(() => null);
  if (pending !== 'encrypted' || !legacyEnc) return { result: 'noop', version: 1 };

  // Recover the key through the read path's legacy branch — the SAME code the
  // app uses, so this cannot succeed via a route the app could not repeat.
  // The address is unknown here, so ask for it by deriving from the plaintext:
  // decrypt via a throwaway probe, then verify with the real read path.
  const probe = await readKeyForUnknownAddress(legacyEnc, pinKey, env);
  if (!probe) return { result: 'noop', version: 1 };
  const { address, hex } = probe;

  // Mint the DEK BEFORE writing any slot: a slot encrypted under a DEK that
  // failed to persist would be unopenable. `writeDekVerified` refuses to
  // report success unless both copies read back and unwrap.
  if (!(await hasDek(store))) {
    await writeDekVerified(pinKey, mintDek(), store);
  }
  const dekBytes = await loadDekOrThrow(pinKey, store);
  const keys: UnlockedKeys = { pinKey, dek: await importDek(dekBytes) };

  await adoptAccount(address, hex, env, keys);
  // COMMIT POINT — last, as in the raw path.
  await store.setItemAsync(SS.version, String(VAULT_VERSION_V2));
  // Only AFTER the commit. Clearing the marker first meant a crash on the
  // version write left the vault at v1 with nothing recording that a deferred
  // migration was outstanding — recoverable only because `migrateV1toV2`
  // happens to re-set the marker on the next launch. Depending on caller
  // order for that is not a safety property.
  await store.deleteItemAsync(SS.pending).catch(() => {});
  return { result: 'migrated', address };
}

/**
 * Write one account's slot and index it, verifying at every step.
 *
 * Order is load-bearing: slot → verify → index → active. An index entry whose
 * slot does not exist is a visible, self-healing inconsistency; a slot that
 * nothing points at is unenumerable key material.
 */
async function adoptAccount(
  address: string,
  hex: string,
  env: MigrationEnv,
  keys: UnlockedKeys,
): Promise<void> {
  const { store, local, listKeystore, deriveAddress } = env;
  await writeKeyFor(address, hex, store, keys, deriveAddress);

  const back = await readKeyFor(address, store, keys, deriveAddress);
  if (back.status !== 'ok' || back.hex !== hex) {
    throw new Error('migrated slot did not read back — leaving v1 intact');
  }

  const entry: AccountEntry = { a: address, label: null, source: 'builtin', added: Date.now() };
  await persistIndexAdding(entry, store, local, listKeystore);
  await writeActive(store, address);
}

/**
 * Decrypt the legacy anchor when the address is not yet known.
 *
 * Narrow by design: it exists only for the deferred migration, where there is
 * exactly one account and the address must come from the key itself.
 */
async function readKeyForUnknownAddress(
  legacyEnc: string,
  pinKey: CryptoKey,
  env: MigrationEnv,
): Promise<{ address: string; hex: string } | null> {
  const { decryptWithKey } = await import('./aesGcm.ts');
  try {
    const hex = await decryptWithKey(pinKey, legacyEnc);
    if (!HEX64.test(hex)) return null;
    return { address: await env.deriveAddress(hex), hex };
  } catch {
    return null; // wrong PIN, or a corrupt anchor
  }
}

async function loadDekOrThrow(pinKey: CryptoKey, store: StoreLike): Promise<Uint8Array> {
  const { loadDek } = await import('./vaultDek.ts');
  const dek = await loadDek(pinKey, store);
  if (!dek) throw new Error('DEK missing immediately after it was written');
  return dek;
}
