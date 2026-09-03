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
import { wipeWalletScope } from './walletScope';
import { AS, SS, MAX_ACCOUNTS, isValidAddress, type AccountEntry } from './vaultAccounts';
import { importDek, loadDek, hasDek, deleteDek, type StoreLike } from './vaultDek';
import {
  readKeyFor, writeKeyFor, keyArtefactsFor,
  type UnlockedKeys,
} from './vaultAccess';
import {
  readIndex, readActive, writeActive, persistIndexAdding, persistIndexRemoving,
  browserLocal, type ListKeystore,
} from './vaultIndex';
import { completeDeferredV2, type MigrationEnv } from './vaultMigrateV2';
import { encryptAllWithPin, decryptAllToRaw, type PinOpsDeps } from './vaultPinOps';

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

  const targets = keyArtefactsFor(addr);

  // The v1 anchors are retained by the MIGRATION as a recovery backstop — but
  // that backstop exists for a crash mid-migration, not forever after the user
  // deliberately removes the account. Leaving them meant removal deleted the
  // per-account slots while the key stayed on disk in the anchor, `readKeyFor`
  // branches 3/4 re-opened it, and the recovery scan put the address back in
  // the list: the account returned, fully usable, and the confirmation text
  // ("removes the account and its data from this device") was simply false.
  //
  // Only removed when the anchor actually belongs to THIS account — never on a
  // guess, since deleting another account's anchor would destroy its key.
  const provenAnchors = await legacyAnchorsBelongingTo(addr);
  if (provenAnchors.length > 0) {
    // The anchors only. NOT `VAULT_MODE_KEY`: that flag is VAULT-level, and
    // `legacyAnchorBelongsTo` proves nothing about it. Deleting it made
    // `vaultIsEncrypted()` false while the lock stayed enabled, so `App.tsx`'s
    // `encrypted && lockOn` gate failed and the next launch walked past the
    // lock screen for the accounts that remain — reopening the bypass that
    // `encryptAllWithPin`'s unconditional write exists to close.
    // Only the anchor that was actually proven. The comment claimed as much
    // while the code deleted both; in practice a mode switch removes the other
    // one, but "proven" must mean proven.
    targets.push(...provenAnchors);
  }

  await SecureStore.deleteManyAsync(targets);
  await persistIndexRemoving(addr, store, browserLocal, listKeystore);

  // Without this the account's `<base>::<addr>` preference keys survive and
  // the index's recovery scan resurrects the address on the next read.
  wipeWalletScope(addr);

  // A stale `active` pointer would have `vaultInit` try to activate an account
  // that no longer exists.
  if ((await readActive(store).catch(() => null)) === addr) {
    await SecureStore.deleteItemAsync(SS.active).catch(() => {});
  }

  if (activeAddress === addr) {
    cachedSigner = null;
    cachedKeyHex = null;
    activeAddress = null;
  }
}

/**
 * Which legacy v1 anchors hold THIS account's key.
 *
 * Answers only when it can prove it: the raw anchor is derived directly, and
 * the encrypted anchor is opened with the session PIN key. An anchor that
 * cannot be opened returns `false` — leaving key material behind is
 * recoverable, deleting someone else's anchor is not.
 */
async function legacyAnchorsBelongingTo(addr: string): Promise<string[]> {
  // EVERY proven anchor, not the first. Both cleanup deletes swallow their
  // errors (`.catch(() => {})` in `encryptAllWithPin` and `vaultStore`), so a
  // poisoned store can leave the raw and encrypted anchors holding the same
  // account's key. Returning early left the second one behind, and the
  // unlock fallback then reopened the account that had just been "removed".
  const proven: string[] = [];
  const raw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
    try {
      if ((await deriveAddress(raw)) === addr) proven.push(VAULT_RAW_KEY);
    } catch {
      /* fails closed */
    }
  }
  const enc = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY).catch(() => null);
  if (enc && keys.pinKey) {
    try {
      const hex = await decryptWithKey(keys.pinKey, enc);
      if (/^[0-9a-fA-F]{64}$/.test(hex) && (await deriveAddress(hex)) === addr) {
        proven.push(VAULT_ENCRYPTED_KEY);
      }
    } catch {
      /* wrong or absent PIN key — fails closed */
    }
  }
  return proven;
}

/** Export a SPECIFIC account's key, without activating it. */
export async function vaultExportKeyFor(addr: string): Promise<string | null> {
  const got = await readKeyFor(addr, store, keys, deriveAddress);
  return got.status === 'ok' ? got.hex : null;
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
    if (!encrypted) {
      // Nothing opened. Clear the session keys rather than leaving a PIN key
      // installed for an unlock that failed — a later `writeKeyFor` would
      // otherwise believe a PIN is in force for this session.
      keys.pinKey = null;
      keys.dek = null;
      return null;
    }
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

  // Refuse when a PIN is in force. This writes a plaintext anchor, flips the
  // vault to raw, and DELETES the encrypted anchor — which, for a user whose
  // deferred v2 migration has not completed, is their only key copy. The
  // current callers are gated on there being no wallet, so this is not live
  // today; the function had no guard of its own, and the next caller would
  // not know.
  if (await SecureStore.getItemAsync('ogmara.app_lock.pin_verify').catch(() => null)) {
    throw new Error('A PIN is set — use "Add account" instead of replacing the vault');
  }

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
 * Whether stored-but-uncommitted PIN credentials can be discarded.
 *
 * True only when nothing is sealed under them: no DEK, and no account holds a
 * ciphertext slot. Then a fresh salt loses nothing.
 */
export async function pinCredentialsDiscardable(): Promise<boolean> {
  // Every read fails CLOSED. This function authorises deleting the salt, so a
  // storage failure must read as "something might be sealed", never as
  // "nothing is". Previously each `.catch` pointed the other way and a single
  // failed read could green-light discarding the key to a sealed anchor.
  try {
    if (await hasDek(store)) return false;
    for (const a of await SecureStore.listVaultAccountsStrict()) {
      if (await SecureStore.getItemAsync(SS.encFor(a))) return false;
    }
    return !(await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY));
  } catch {
    return false;
  }
}

/** Shared dependency bundle for the PIN sequences. */
function pinOpsDeps(): PinOpsDeps {
  return {
    store,
    keys,
    deriveAddress,
    listAccounts: async () => (await vaultListAccounts()).map((e) => e.a),
    // STRICT: these guards authorise destruction, so a failed listing must
    // throw rather than read as "nothing to worry about".
    listKeystore: () => SecureStore.listVaultAccountsStrict(),
  };
}

/**
 * Encrypt every account's slot under a PIN-derived key.
 *
 * Delegates to `vaultPinOps`, which is where the ordering lives and where the
 * crash-injection tests run — so the tested code is the shipped code rather
 * than a copy of it.
 *
 * The caller MUST persist the PIN salt before calling and arm the lock only
 * after it returns; see `PinSetup.tsx`.
 */
export async function vaultEncryptAllWithPin(pinKey: CryptoKey): Promise<void> {
  await encryptAllWithPin(pinKey, pinOpsDeps());
}

/** Decrypt every account back to plaintext, for PIN removal. */
export async function vaultDecryptAllToRaw(pinKey: CryptoKey): Promise<void> {
  await decryptAllToRaw(pinKey, pinOpsDeps());
  keys.pinKey = null;
  keys.dek = null;
}

/**
 * Clear a PIN-operation journal whose work is demonstrably complete.
 *
 * The journal marks an encrypt/decrypt that was interrupted, and
 * `verifyVaultIntegrity` reports the vault unhealthy while it is set. Nothing
 * read it, so a single failed attempt left the vault permanently "unhealthy"
 * with no way back — the marker outlived the condition it described.
 *
 * This does not replay anything: both operations are already idempotent and
 * re-runnable from the UI. It only retires a marker whose invariant now holds,
 * which is checked against the STORE rather than assumed:
 *   - `encrypt` is done when no account still has a plaintext slot;
 *   - `decrypt` is done when no account still has a ciphertext slot.
 */
export async function reconcilePinJournal(): Promise<void> {
  const raw = await SecureStore.getItemAsync(SS.pinMigration).catch(() => null);
  if (!raw) return;
  let op: string | null = null;
  try {
    op = JSON.parse(raw)?.op ?? null;
  } catch {
    // Unparseable: it cannot describe outstanding work, so it is noise.
    await SecureStore.deleteItemAsync(SS.pinMigration).catch(() => {});
    return;
  }

  // A FAILED listing is not an empty one. Treating it as empty made the loop
  // below vacuous and retired a journal that might still describe outstanding
  // work — the silent-fallback shape.
  let addrs: string[];
  try {
    addrs = await SecureStore.listVaultAccountsStrict();
  } catch {
    return; // cannot tell; leave the journal for a later boot
  }
  let settled = true;
  for (const a of addrs) {
    const key = op === 'encrypt' ? SS.rawFor(a) : SS.encFor(a);
    if (await SecureStore.getItemAsync(key).catch(() => null)) {
      settled = false;
      break;
    }
  }
  if (settled) await SecureStore.deleteItemAsync(SS.pinMigration).catch(() => {});
}

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

/**
 * Decrypt every account back to plaintext slots, for PIN removal.
 *
 * Mirror image of the above with the OPPOSITE commit point: everything is
 * written in the clear and verified BEFORE the caller removes the PIN record,
 * so a crash before that leaves the PIN still required and all ciphertext
 * intact.
 */

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

  // Enumerated NATIVELY, by prefix. The hand-built target list here was
  // incomplete three audits running — it missed the DEK, then the app-lock
  // record, then the pre-v2 device-global X25519 secret and its claim marker,
  // each time leaving key material on disk after a wipe the UI called total.
  // One native call removes everything under `ogmara.vault.` and
  // `ogmara.app_lock.`, so a key added later cannot be forgotten, and it
  // raises exactly one confirmation.
  await SecureStore.wipeVaultStore();

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
