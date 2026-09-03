/**
 * Vault — secure key isolation layer ("firewall" for private keys).
 *
 * The private key NEVER leaves this module. When PIN lock is enabled,
 * the key is AES-256-GCM encrypted with a PBKDF2-derived key before
 * storage. The raw key is only in memory after successful PIN entry.
 *
 * Architecture:
 *   App -> Vault API (sign, getAddress) -> OS credential store
 *         ^ key never exposed outward  ^
 *         When PIN enabled: stored key is encrypted with PIN-derived AES key
 *
 * Desktop version: uses Tauri keyring commands instead of expo-secure-store.
 * Per spec 05-clients.md sections 5.5.1 (Vault Isolation Layer).
 */

import * as SecureStore from './secureStore';
import { WalletSigner, type NodeBinding } from '@ogmara/sdk';
import { encryptWithKey, decryptWithKey } from './appLock';
import { cancelAllPending as cancelPendingTxConfirms } from './txConfirm';
import { AS, SS, MAX_ACCOUNTS, isValidAddress, type AccountEntry } from './vaultAccounts';
import { importDek, loadDek, hasDek, deleteDek, type StoreLike } from './vaultDek';
import {
  readKeyFor, writeKeyFor, hasSlot, keyArtefactsFor,
  type UnlockedKeys,
} from './vaultAccess';
import {
  readIndex, readActive, writeActive, persistIndexAdding, persistIndexRemoving,
  browserLocal, type ListKeystore,
} from './vaultIndex';
import { completeDeferredV2, type MigrationEnv } from './vaultMigrateV2';

/** The secure store, as the injectable shape the key modules take. */
const store: StoreLike = SecureStore;

/** Addresses proven to have a key slot, from the enumerable native store. */
const listKeystore: ListKeystore = () => SecureStore.listVaultAccounts();

/** Deriving an address is the SDK's job; the key modules stay SDK-free. */
const deriveAddress = async (hex: string) => (await WalletSigner.fromHex(hex)).address;

/** Everything the migration and index need. */
function env(): MigrationEnv {
  return { store, local: browserLocal, listKeystore, deriveAddress };
}

/**
 * Session keys.
 *
 * The PIN key is held for the session so switching accounts after unlock does
 * not re-prompt; both are cleared by `vaultLock()`. `deriveKeyFromPin` creates
 * it non-extractable, and the raw key hex is already held in memory while
 * unlocked, so this is not a new exposure class.
 */
const keys: UnlockedKeys = { pinKey: null, dek: null };

/** The account whose key is currently loaded. */
let activeAddress: string | null = null;

const VAULT_RAW_KEY = 'ogmara.vault.private_key';
const VAULT_ENCRYPTED_KEY = 'ogmara.vault.encrypted_key';
const VAULT_MODE_KEY = 'ogmara.vault.mode'; // 'raw' | 'encrypted'

/** Internal signer — never exported directly. */
let cachedSigner: WalletSigner | null = null;
/** Cached raw key hex — kept in memory while unlocked for export/sync. */
let cachedKeyHex: string | null = null;

/**
 * Initialize the vault WITHOUT PIN (for apps without PIN lock).
 * Returns the public address if a wallet exists, null otherwise.
 */
export async function vaultInit(): Promise<string | null> {
  // If signer is already loaded (e.g., from vaultUnlockWithPin), return it
  if (cachedSigner) return cachedSigner.address;

  // Prefer the recorded active account; fall back to the first indexed one so
  // a lost `active` pointer does not look like a lost wallet.
  const recorded = await readActive(store);
  const candidates = recorded ? [recorded] : [];
  for (const e of await vaultListAccounts()) {
    if (!candidates.includes(e.a)) candidates.push(e.a);
  }
  for (const addr of candidates) {
    const loaded = await vaultActivate(addr);
    if (loaded) return loaded;
  }

  // No per-account slot opened. Fall back to the legacy anchor, which is how a
  // vault that has not migrated yet (or one whose index was wiped) still
  // loads.
  const mode = await SecureStore.getItemAsync(VAULT_MODE_KEY).catch(() => null);
  if (mode === 'encrypted') return null; // needs vaultUnlockWithPin()
  try {
    const hex = await SecureStore.getItemAsync(VAULT_RAW_KEY);
    if (hex) {
      cachedSigner = await WalletSigner.fromHex(hex);
      cachedKeyHex = hex;
      activeAddress = cachedSigner.address;
      return cachedSigner.address;
    }
  } catch {
    cachedSigner = null;
  }
  return null;
}

/**
 * Load one account's key into memory and make it active.
 *
 * Returns the address on success, or `null` when the slot is missing or still
 * locked. NEVER falls back to another account: handing back a different
 * account's key would have `settings-sync` seal one account's data under
 * another's, unrecoverable on every device.
 */
export async function vaultActivate(addr: string): Promise<string | null> {
  if (!isValidAddress(addr)) return null;
  const got = await readKeyFor(addr, store, keys, deriveAddress);
  if (got.status !== 'ok') return null;
  cachedSigner = await WalletSigner.fromHex(got.hex);
  cachedKeyHex = got.hex;
  activeAddress = addr;
  await writeActive(store, addr).catch(() => {});
  return addr;
}

/** The address whose key is loaded, independent of the signer object. */
export function vaultActiveAddress(): string | null {
  return activeAddress;
}

/**
 * Every account held on this device.
 *
 * Returns the persisted UNION. Slot presence is probed only to annotate the
 * result, never to filter it: a failed read is indistinguishable from an
 * absent slot, and on a poisoned store every read fails, so filtering would
 * make the account list empty exactly when the user most needs it.
 */
export async function vaultListAccounts(): Promise<AccountEntry[]> {
  return readIndex(store, browserLocal, listKeystore);
}

/**
 * Add an account from a private key and index it.
 *
 * Writes and verifies the slot BEFORE indexing: an index entry with no slot is
 * a visible, self-healing inconsistency, whereas a slot nothing points at is
 * unenumerable key material.
 */
export async function vaultAddAccount(privateKeyHex: string): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('Invalid private key format');
  }
  const addr = await deriveAddress(privateKeyHex);
  const existing = await vaultListAccounts();
  if (!existing.some((e) => e.a === addr) && existing.length >= MAX_ACCOUNTS) {
    throw new Error(`At most ${MAX_ACCOUNTS} accounts can be held on one device`);
  }
  await writeKeyFor(addr, privateKeyHex, store, keys, deriveAddress);
  await persistIndexAdding(
    { a: addr, label: null, source: 'builtin', added: Date.now() },
    store, browserLocal, listKeystore,
  );
  return addr;
}

/**
 * Remove ONE account: its key material, then its index entry.
 *
 * Slots first — an orphan index entry is harmless and self-heals, an orphan
 * slot is key material nothing can reach. Deleted as one batch so the native
 * last-key guard evaluates once and raises at most one dialog.
 */
export async function vaultRemoveAccount(addr: string): Promise<void> {
  if (!isValidAddress(addr)) return;
  await SecureStore.deleteManyAsync(keyArtefactsFor(addr));
  await persistIndexRemoving(addr, store, browserLocal, listKeystore);
  if (activeAddress === addr) {
    cachedSigner = null;
    cachedKeyHex = null;
    activeAddress = null;
  }
}

/** Export a SPECIFIC account's key, without activating it. */
export async function vaultExportKeyFor(addr: string): Promise<string | null> {
  const got = await readKeyFor(addr, store, keys, deriveAddress);
  return got.status === 'ok' ? got.hex : null;
}

/** Whether `addr` has key material on this device. */
export async function vaultHasSlot(addr: string): Promise<boolean> {
  return hasSlot(addr, store);
}

/**
 * Check if the vault has a stored wallet (encrypted or raw).
 */
export async function vaultHasWallet(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  const enc = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY).catch(() => null);
  if (raw || enc) return true;
  // A migrated vault may have no legacy anchor at all if it was created after
  // v2; checking only the anchors would report "no wallet" and offer to create
  // one over a device that already holds several.
  return (await vaultListAccounts().catch(() => [])).length > 0;
}

/**
 * Check if the vault is in encrypted (PIN-locked) mode.
 */
export async function vaultIsEncrypted(): Promise<boolean> {
  const mode = await SecureStore.getItemAsync(VAULT_MODE_KEY).catch(() => null);
  return mode === 'encrypted';
}

/**
 * Unlock the vault with a PIN-derived CryptoKey.
 * Decrypts the stored private key and loads it into memory.
 * Returns the public address on success, null on failure.
 */
export async function vaultUnlockWithPin(pinKey: CryptoKey): Promise<string | null> {
  try {
    // Hold the PIN key for the session: switching accounts after unlock must
    // not re-prompt, and the legacy-anchor branch of the read path needs it.
    keys.pinKey = pinKey;

    // The DEK unwraps every per-account slot. Absent on a vault that has not
    // migrated yet, which is not an error — the legacy branch still opens it.
    try {
      const dek = await loadDek(pinKey, store);
      keys.dek = dek ? await importDek(dek) : null;
    } catch {
      // Present but unopenable (wrong PIN, or a corrupt pair). Leave it null
      // and let the legacy anchor decide — it is the backstop for exactly
      // this.
      keys.dek = null;
    }

    // Finish a migration that had to wait for the PIN. Best-effort: a failure
    // here must not block unlocking a wallet that is otherwise fine.
    try {
      await completeDeferredV2(pinKey, env());
      if (!keys.dek) {
        const dek = await loadDek(pinKey, store).catch(() => null);
        if (dek) keys.dek = await importDek(dek);
      }
    } catch {
      /* stays at v1 and retries next unlock */
    }

    const recorded = await readActive(store);
    if (recorded) {
      const loaded = await vaultActivate(recorded);
      if (loaded) return loaded;
    }
    for (const e of await vaultListAccounts()) {
      const loaded = await vaultActivate(e.a);
      if (loaded) return loaded;
    }

    // Legacy anchor, for a vault whose migration has not run.
    const encrypted = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY);
    if (!encrypted) return null;
    const hex = await decryptWithKey(pinKey, encrypted);
    cachedSigner = await WalletSigner.fromHex(hex);
    cachedKeyHex = hex;
    activeAddress = cachedSigner.address;
    return cachedSigner.address;
  } catch {
    keys.pinKey = null;
    keys.dek = null;
    return null; // wrong PIN or corrupted data
  }
}

/**
 * Store a new private key in the vault (raw mode, no PIN encryption).
 * Returns the derived public address.
 */
export async function vaultStore(privateKeyHex: string): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('Invalid private key format');
  }

  const signer = await WalletSigner.fromHex(privateKeyHex);

  await SecureStore.setItemAsync(VAULT_RAW_KEY, privateKeyHex);
  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'raw');
  // Clean up any encrypted version
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY).catch(() => {});

  // Also write the per-account slot and index it, so the onboarding path and
  // the multi-account path converge on the same state. Without this, a wallet
  // created here would be invisible to the account list until a migration
  // happened to run.
  await writeKeyFor(signer.address, privateKeyHex, store, keys, deriveAddress).catch(() => {});
  await persistIndexAdding(
    { a: signer.address, label: null, source: 'builtin', added: Date.now() },
    store, browserLocal, listKeystore,
  ).catch(() => {});
  await writeActive(store, signer.address).catch(() => {});

  cachedSigner = signer;
  cachedKeyHex = privateKeyHex;
  activeAddress = signer.address;
  return signer.address;
}

// The single-account `vaultEncryptWithPin` / `vaultDecryptToRaw` were removed
// with the multi-account vault. They only ever touched the legacy anchor, so
// under v2 wiring either one back would encrypt the anchor while leaving every
// per-account slot in plaintext (or the reverse on removal) — while the UI
// reported the vault as protected. `vaultEncryptAllWithPin` and
// `vaultDecryptAllToRaw` below are the replacements; they operate on the full
// account set and refuse to act on a subset.

/**
 * Encrypt EVERY account's slot under a PIN-derived key.
 *
 * The multi-account replacement for `vaultEncryptWithPin`, which only ever
 * touched the legacy anchor — under v2 that would have left every per-account
 * slot sitting in plaintext while the UI reported the vault as PIN-protected.
 *
 * Ordering, and why each step is where it is:
 *
 *   A. Read every account's key FIRST. If any one cannot be read, abort before
 *      writing anything and name it. Encrypting a subset is precisely the
 *      mobile 0.47.0 finding — it leaves accounts the PIN does not protect
 *      while claiming it does.
 *   B. Mint and persist the DEK, verified. A slot sealed under a DEK that
 *      never persisted is unopenable forever.
 *   C. Write each ciphertext slot and verify it by decrypting. Plaintext is
 *      still present throughout, so a failure here is recoverable.
 *   D. Only then destroy the plaintext.
 *
 * The caller commits the PIN record AFTER this returns — see `PinSetup`.
 */
export async function vaultEncryptAllWithPin(pinKey: CryptoKey): Promise<void> {
  const accounts = await vaultListAccounts();

  // A — read everything before touching anything.
  const plain = new Map<string, string>();
  for (const e of accounts) {
    const got = await readKeyFor(e.a, store, keys, deriveAddress);
    if (got.status !== 'ok') {
      throw new Error(
        `Cannot read the key for ${e.a.slice(0, 12)}… — refusing to encrypt only some accounts`,
      );
    }
    plain.set(e.a, got.hex);
  }
  // The legacy anchor too, so a vault that has not migrated is not left behind.
  const legacyRaw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);

  await SecureStore.setItemAsync(SS.pinMigration, JSON.stringify({ op: 'encrypt', at: Date.now() }));

  // B — the DEK, verified in both copies before anything depends on it.
  if (!(await hasDek(store))) {
    const { mintDek, writeDekVerified } = await import('./vaultDek');
    await writeDekVerified(pinKey, mintDek(), store);
  }
  const dekBytes = await loadDek(pinKey, store);
  if (!dekBytes) throw new Error('DEK missing immediately after it was written');
  keys.pinKey = pinKey;
  keys.dek = await importDek(dekBytes);

  // C + D — writeKeyFor seals under the DEK, verifies by reading back, and
  // only then removes that account's plaintext slot.
  for (const [addr, hex] of plain) {
    await writeKeyFor(addr, hex, store, keys, deriveAddress);
  }

  // The legacy anchor moves to its encrypted form the same way: write the new
  // one, verify, and only then delete the old. Never the reverse.
  if (legacyRaw) {
    const blob = await encryptWithKey(pinKey, legacyRaw);
    await SecureStore.setItemAsync(VAULT_ENCRYPTED_KEY, blob);
    if ((await decryptWithKey(pinKey, blob)) !== legacyRaw) {
      throw new Error('legacy anchor failed encryption verification');
    }
    await SecureStore.setItemAsync(VAULT_MODE_KEY, 'encrypted');
    await SecureStore.deleteItemAsync(VAULT_RAW_KEY).catch(() => {});
  }

  await SecureStore.deleteItemAsync(SS.pinMigration).catch(() => {});
}

/**
 * Decrypt every account back to plaintext slots, for PIN removal.
 *
 * Mirror image of the above with the OPPOSITE commit point: everything is
 * written in the clear and verified BEFORE the caller removes the PIN record,
 * so a crash before that leaves the PIN still required and all ciphertext
 * intact.
 */
export async function vaultDecryptAllToRaw(pinKey: CryptoKey): Promise<void> {
  keys.pinKey = pinKey;
  if (!keys.dek) {
    const dekBytes = await loadDek(pinKey, store).catch(() => null);
    if (dekBytes) keys.dek = await importDek(dekBytes);
  }

  const accounts = await vaultListAccounts();
  const plain = new Map<string, string>();
  for (const e of accounts) {
    const got = await readKeyFor(e.a, store, keys, deriveAddress);
    if (got.status !== 'ok') {
      throw new Error(
        `Cannot read the key for ${e.a.slice(0, 12)}… — refusing to remove the PIN with an account left encrypted`,
      );
    }
    plain.set(e.a, got.hex);
  }

  await SecureStore.setItemAsync(SS.pinMigration, JSON.stringify({ op: 'decrypt', at: Date.now() }));

  // Drop the DEK from the session so `writeKeyFor` takes the raw branch.
  const dekHeld = keys.dek;
  keys.dek = null;
  try {
    for (const [addr, hex] of plain) {
      await writeKeyFor(addr, hex, store, keys, deriveAddress);
      await SecureStore.deleteItemAsync(SS.encFor(addr)).catch(() => {});
    }
    const legacyEnc = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY).catch(() => null);
    if (legacyEnc) {
      const hex = await decryptWithKey(pinKey, legacyEnc);
      await SecureStore.setItemAsync(VAULT_RAW_KEY, hex);
      await SecureStore.setItemAsync(VAULT_MODE_KEY, 'raw');
      await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY).catch(() => {});
    }
    await deleteDek(store);
    keys.pinKey = null;
  } catch (e) {
    keys.dek = dekHeld; // put it back so the session keeps working
    throw e;
  }
  await SecureStore.deleteItemAsync(SS.pinMigration).catch(() => {});
}

/**
 * Generate a new random wallet in the vault (raw mode).
 * Returns the derived public address.
 */
export async function vaultGenerate(): Promise<string> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return vaultStore(hex);
}

/** Get the WalletSigner (only available after init or PIN unlock). */
export function vaultGetSigner(): WalletSigner | null {
  return cachedSigner;
}

/** Get the wallet address without exposing the signer. */
export function vaultGetAddress(): string | null {
  return cachedSigner?.address ?? null;
}

/** Check if the vault is unlocked (signer loaded in memory). */
export function vaultIsUnlocked(): boolean {
  return cachedSigner !== null;
}

/** Lock the vault — clear signer and key from memory without wiping storage. */
export function vaultLock(): void {
  cachedSigner = null;
  cachedKeyHex = null;
  activeAddress = null;
  // The session keys go too. Leaving them would let a locked app still decrypt
  // every account's slot, which is the whole thing the lock is for.
  keys.pinKey = null;
  keys.dek = null;
  // Reject any in-flight tx-confirm prompts so they don't stay open over
  // the lock screen and resolve against a now-empty signer after re-unlock.
  cancelPendingTxConfirms();
}

/** Wipe the wallet from memory and all storage. */
export async function vaultWipe(): Promise<void> {
  cachedSigner = null;
  cachedKeyHex = null;
  activeAddress = null;
  keys.pinKey = null;
  keys.dek = null;

  // Enumerate the UNION plus the recorded active account, uncapped: a wipe
  // must reach every account, including any beyond the display cap and any
  // known only to the keystore. Anything missed is key material left on disk
  // that nothing can ever remove.
  const every = new Set<string>();
  for (const e of await vaultListAccounts().catch(() => [] as AccountEntry[])) every.add(e.a);
  const recorded = await readActive(store).catch(() => null);
  if (recorded) every.add(recorded);

  const targets: string[] = [];
  for (const a of every) targets.push(...keyArtefactsFor(a));
  targets.push(VAULT_RAW_KEY, VAULT_ENCRYPTED_KEY, VAULT_MODE_KEY, SS.active, SS.mirror, SS.pending);
  // One batch: the native guard evaluates once and raises at most one dialog,
  // instead of one per account for a user who would learn to click through.
  await SecureStore.deleteManyAsync(targets).catch(() => {});
  await deleteDek(store).catch(() => {});
  try {
    browserLocal.setItem(AS.primaryIndex, '[]');
  } catch {
    /* best-effort */
  }
}

/** Export the raw private key hex. Works in raw mode or when unlocked from encrypted mode. */
export async function vaultExportKey(): Promise<string | null> {
  // If key is cached in memory (unlocked encrypted vault or raw vault), return it
  if (cachedKeyHex) return cachedKeyHex;

  // Once an account is active there is NO fallback to the legacy anchor. A
  // transient failure returning a different account's key would have
  // `settings-sync` encrypt one account's settings under another's key —
  // permanently undecryptable on every device — and would upload the wrong
  // account's key vault.
  if (activeAddress) return vaultExportKeyFor(activeAddress);

  const mode = await SecureStore.getItemAsync(VAULT_MODE_KEY).catch(() => null);
  if (mode === 'raw') {
    return await SecureStore.getItemAsync(VAULT_RAW_KEY) ?? null;
  }
  return null;
}

/**
 * Sign an auth request through the vault. `binding` is the target node's
 * `{ network, nodeId }` (audit 2026-06-07 host-binding) — obtain it from the
 * node's `/api/v1/health`; the vault layer stays network-free by taking it as
 * a parameter. Prefer `OgmaraClient.authHeaders()` for client-routed calls.
 */
export async function vaultSignRequest(
  method: string,
  path: string,
  binding: NodeBinding,
): Promise<{ [key: string]: string } | null> {
  if (!cachedSigner) return null;
  const headers = await cachedSigner.signRequest(method, path, binding);
  return { ...headers };
}
