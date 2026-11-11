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
  ChannelKeyringError,
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
  prepareChannelExport,
  commitChannelExport,
  channelKeyringEmpty,
  importChannelKeysFromVault,
  planChannelKeyPrune,
  applyChannelKeyPrune,
} from './channelCrypto';
import type { PruneLevel, PrunePlan } from './channelKeyStore';
import { e2elog } from './e2eDebug';
import { currentSwitchGeneration, getWalletScope } from './walletScope';
import { getSetting, setSetting } from './settings';
import {
  createBackupKeyCache,
  createVaultController,
  createTwoStepSnapshot,
  guardedForStamp,
  type PauseReason,
  type PublishOutcome,
} from './keyVaultCore';

/**
 * What the user needs to act on, if anything (drives `KeyVaultBanner`):
 * `unreadable` / `missing` — restore is blocked; `paused` — the channel
 * keyring refused to export, so NOTHING is being backed up (see `pause`).
 */
export type KeyVaultIssueKind = 'unreadable' | 'missing' | 'paused';
export interface KeyVaultIssue {
  kind: KeyVaultIssueKind;
  /** The connected wallet the issue is about. */
  wallet: string;
  /** Why backups are paused (only for `paused`). */
  pause?: PauseReason;
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

/**
 * The keyring to seal, for the account `generation` captured by the run —
 * step 1 of the TWO-STEP channel export (nothing is marked persisted until
 * `commit` after the node accepted it, with the generation it was prepared
 * for). Throws when the channel keyring refuses to export
 * (`ChannelKeyringError` `vault_too_large` / `opaque_overflow` / `stale`):
 * the controller then reports the backup as PAUSED (or stale), never as done.
 */
const twoStep = createTwoStepSnapshot(prepareChannelExport, commitChannelExport, exportConvKeysForVault);

/** Map a refused export to the controller's pause reason. */
function snapshotRefusal(e: unknown): PauseReason | 'stale' {
  if (e instanceof ChannelKeyringError) {
    if (e.code === 'stale') return 'stale';
    if (e.code === 'vault_too_large') return 'too_large';
    if (e.code === 'opaque_overflow') return 'overflow';
  }
  return 'error';
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
  importKeys: (keyring, generation) => ({
    conv: importConvKeysFromVault(keyring.conv),
    chan: importChannelKeysFromVault(keyring.chan, generation),
  }),
  seenMarker,
  markSeen,
  snapshot: (generation) => twoStep.snapshot(generation),
  snapshotRefusal,
  commit: (kr) => twoStep.commit(kr),
  quickEmpty: () => Object.keys(exportConvKeysForVault()).length === 0 && channelKeyringEmpty(),
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
  if (st.restore === 'blocked' && st.blockReason) setIssueRaw({ kind: st.blockReason, wallet: w });
  else if (st.paused) {
    e2elog('keyvault: backup PAUSED — keys are not being backed up', { reason: st.paused });
    setIssueRaw({ kind: 'paused', wallet: w, pause: st.paused });
  } else setIssueRaw(null);
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

/**
 * The next prune step to offer while backups are paused as too large — a DRY
 * RUN (nothing changes), least risky level first from `from` on — for the
 * connected account, or null (nothing removable, signed out, mid-switch).
 * The banner shows its per-class counts in the confirmation.
 */
export function previewKeyVaultPrune(from?: PruneLevel): PrunePlan | null {
  if (!walletAddress()) return null;
  try {
    return planChannelKeyPrune(currentSwitchGeneration(), from);
  } catch {
    return null; // stale: the account changed
  }
}

/**
 * Apply a USER-CONFIRMED prune plan (whose dry run the confirm showed) — only
 * while `forWallet` / `forGeneration` (captured BEFORE the confirmation) are
 * still the active account — then retry the backup. The keyring remembers the
 * pruned keys for the session, so re-merging the remote before the seal does
 * not bring them back. Returns how many keys were removed, `'changed'` when a
 * fresh dry run would remove more than the confirmation showed (nothing
 * removed), or null when the account changed.
 */
export function pruneAndRetryBackup(forWallet: string, forGeneration: number, plan: PrunePlan): number | 'changed' | null {
  let n: number | 'changed' | null;
  try {
    n = guardedForStamp(
      { currentWallet: walletAddress, generation: currentSwitchGeneration },
      { wallet: forWallet, generation: forGeneration },
      () => applyChannelKeyPrune(plan, forGeneration),
    );
  } catch {
    return null; // stale
  }
  if (n === null) return null;
  if (n === 'changed') return n; // more to remove than the user confirmed: show the new counts
  e2elog('keyvault: user pruned channel keys', { level: plan.level, removed: n });
  controller.retry();
  refreshIssue();
  return n;
}

/** The account-switch generation now (captured by the banner before a confirmation). */
export function keyVaultGeneration(): number {
  return currentSwitchGeneration();
}

/** User-confirmed "Replace backup" (banner, behind a confirm): overwrite an
 *  unreadable / missing remote vault with this device's keyring. Only acts while
 *  restore is `blocked`, and — when `forWallet` is given — only while that is
 *  still the connected wallet (the confirmation was for that account). */
export async function replaceKeyVault(forWallet?: string, forGeneration?: number): Promise<PublishOutcome> {
  if (forWallet !== undefined && walletAddress() !== forWallet) return 'stale';
  if (forGeneration !== undefined && currentSwitchGeneration() !== forGeneration) return 'stale';
  const out = await controller.replace(
    forWallet !== undefined && forGeneration !== undefined ? { wallet: forWallet, generation: forGeneration } : undefined,
  );
  refreshIssue();
  return out;
}

// Register into the crypto caches at module load (imported for side effects).
setKeyringChangeListener(() => controller.scheduleBackup());
setVaultRestoreRequester(tryRestoreKeyVault);
