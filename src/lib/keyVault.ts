/**
 * E2E key-recovery vault wiring (P3, protocol §2.5). Persists this wallet's symmetric
 * content keys — DM `conv_key`s and channel epoch `channel_key`s — to the node, sealed
 * under a backup key derived from `signMessage("ogmara-keyvault-v1")`, so a fresh
 * device / reinstall can restore full message history. The node stores the blob
 * opaquely (it never holds the backup key).
 *
 * Flow (state machine in lib/keyVaultCore.ts `createVaultController`, same design as
 * web 0.84.0):
 *  - **Backup:** whenever a content key is cached, `scheduleBackup` debounces a
 *    `sealKeyVault` → `syncKeyVault` publish (one LWW record per wallet) — but only
 *    once restore is `done` for this account, so a publish never overwrites a vault
 *    this session hasn't read (or confirmed verifiably empty). A key cached during an
 *    in-flight publish gets one follow-up publish; a failed publish retries with
 *    backoff (60 s / 5 min / 15 min, at most 3 times).
 *  - **Restore:** a decrypt-miss (key wrapped only to a prior device) triggers a
 *    session-once, coalesced background pull → `openKeyVault` → merge into the
 *    in-memory caches.
 *  - **Blocked:** a vault our own key can't open, or a 404 for a vault this device has
 *    seen before (`keyVaultSeen`), pauses backups until the user presses Retry or
 *    confirms "Replace backup" (`KeyVaultBanner`).
 *
 * The wallet backup key is derived ONCE per session from the built-in vault signer
 * (silent, no popup) via `signMessageAs(wallet, …)`, which refuses to sign as any
 * account other than the one the key is being derived for.
 */
import { createSignal } from 'solid-js';
import {
  deriveVaultBackupKey,
  sealKeyVault,
  openKeyVault,
  VAULT_SIGN_CLAIM,
  type VaultKeyring,
} from '@ogmara/sdk';
import { getClient } from './api';
import { walletAddress } from './auth';
import { signMessageAs } from './klever';
import {
  setKeyringChangeListener,
  setVaultRestoreRequester,
  exportConvKeysForVault,
  importConvKeysFromVault,
} from './dmCrypto';
import {
  exportChannelKeysForVault,
  importChannelKeysFromVault,
} from './channelCrypto';
import { e2elog } from './e2eDebug';
import { currentSwitchGeneration, getWalletScope } from './walletScope';
import { getSetting, setSetting } from './settings';
import {
  createBackupKeyCache,
  createVaultController,
  type PublishOutcome,
} from './keyVaultCore';

/** What the user needs to act on, if anything (drives `KeyVaultBanner`). */
export type KeyVaultIssueKind = 'unreadable' | 'missing';
export interface KeyVaultIssue {
  kind: KeyVaultIssueKind;
  /** The connected wallet the issue is about. */
  wallet: string;
}

const [issueRaw, setIssueRaw] = createSignal<KeyVaultIssue | null>(null);

/**
 * The current key-vault problem for the connected wallet, or null. Reactive
 * (Solid signal); an issue recorded for another wallet reads as null.
 */
export function keyVaultIssue(): KeyVaultIssue | null {
  const issue = issueRaw();
  const w = walletAddress();
  return issue && w && issue.wallet === w ? issue : null;
}

/** Per-wallet backup-key cache (keyVaultCore.ts): a key is tagged with the
 *  wallet it was derived for, an in-flight derivation is only shared with
 *  callers asking for the SAME wallet, and clearing the session abandons it.
 *  Derivation signs strictly as that wallet (`signMessageAs`), so a switch
 *  that re-points the vault signer mid-flight cannot produce another
 *  account's key labelled as this one's. */
const backupKeys = createBackupKeyCache(
  async (wallet) => deriveVaultBackupKey(await signMessageAs(wallet, VAULT_SIGN_CLAIM)), // SDK normalizes hex/base64
  (e) => e2elog('keyvault: backup-key derivation failed/declined', { err: (e as Error)?.message }),
);

function currentKeyring(): VaultKeyring {
  return { conv: exportConvKeysForVault(), chan: exportChannelKeysForVault() };
}

const isEmptyKeyring = (kr: VaultKeyring): boolean =>
  Object.keys(kr.conv).length === 0 && Object.keys(kr.chan).length === 0;

/** `keyVaultSeen` holds the wallet address itself, read only while per-account
 *  storage points at that wallet (null = can't tell now). */
function seenMarker(wallet: string): boolean | null {
  if (getWalletScope() !== wallet) return null;
  return getSetting('keyVaultSeen') === wallet;
}

/** Set the marker — only while per-account storage points at `wallet`, so it
 *  can never land in another account's namespace. */
function markSeen(wallet: string): void {
  if (getWalletScope() !== wallet) return;
  if (getSetting('keyVaultSeen') !== wallet) setSetting('keyVaultSeen', wallet);
}

// `walletAddress()` (not `vaultActiveAddress()`) + the switch generation: the
// identity the API client's signer and `signMessageAs` are bound to, and a
// counter bumped synchronously at the very top of every switch — see
// walletScope.ts `bumpSwitchGeneration()` for the 2026-09-04 leak this closes.
const controller = createVaultController({
  currentWallet: walletAddress,
  generation: currentSwitchGeneration,
  ensureBackupKey: () => backupKeys.ensure(walletAddress()),
  log: e2elog,
  fetchVault: () => getClient().getKeyVault(), // null only on a true 404
  open: openKeyVault,
  importKeys: (keyring) => ({
    conv: importConvKeysFromVault(keyring.conv),
    chan: importChannelKeysFromVault(keyring.chan),
  }),
  seenMarker,
  markSeen,
  snapshot: currentKeyring,
  isEmpty: isEmptyKeyring,
  seal: sealKeyVault,
  publish: async (sealed) => {
    await getClient().syncKeyVault(sealed);
    e2elog('keyvault: backup published', { bytes: sealed.encrypted_vault.length });
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onStateChange: () => refreshIssue(),
});

function refreshIssue(): void {
  const w = walletAddress();
  if (!w) {
    setIssueRaw(null);
    return;
  }
  const st = controller.status();
  setIssueRaw(st.restore === 'blocked' && st.blockReason ? { kind: st.blockReason, wallet: w } : null);
}

/** Forget the cached backup key + all session state (call on wallet disconnect/switch).
 *  Cancels any pending backup / backoff retry so a debounced publish can't fire under
 *  a NEW wallet, and abandons any in-flight backup-key derivation and restore. */
export function clearKeyVaultSession(): void {
  backupKeys.clear();
  controller.clearSession();
  refreshIssue();
}

/** Pull + decrypt the vault and merge restored keys into the in-memory caches.
 *  Session-once, coalesced and idempotent; safe to call from a decrypt-miss render
 *  path. A transient failure stays retryable; `blocked` waits for the user. */
export function tryRestoreKeyVault(): void {
  controller.tryRestore();
}

/** User Retry (banner): re-check a blocked vault (e.g. after switching node). */
export function retryKeyVault(): void {
  controller.retry();
  refreshIssue();
}

/** User-confirmed "Replace backup" (banner, behind a confirm): overwrite an
 *  unreadable / missing remote vault with this device's keyring. Only acts while
 *  restore is `blocked`, and — when `forWallet` is given — only while that is
 *  still the connected wallet (the confirmation was for that account). */
export async function replaceKeyVault(forWallet?: string): Promise<PublishOutcome> {
  if (forWallet !== undefined && walletAddress() !== forWallet) return 'stale';
  const out = await controller.replace();
  refreshIssue();
  return out;
}

// Register into the crypto caches at module load (imported for side effects).
setKeyringChangeListener(() => controller.scheduleBackup());
setVaultRestoreRequester(tryRestoreKeyVault);
