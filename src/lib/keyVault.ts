/**
 * E2E key-recovery vault wiring (P3, protocol §2.5). Persists this wallet's symmetric
 * content keys — DM `conv_key`s and channel epoch `channel_key`s — to the node, sealed
 * under a backup key derived from `signMessage("ogmara-keyvault-v1")`, so a fresh
 * device / reinstall can restore full message history. The node stores the blob
 * opaquely (it never holds the backup key).
 *
 * Flow:
 *  - **Backup:** whenever a content key is cached, {@link scheduleBackup} debounces a
 *    `sealKeyVault` → `syncKeyVault` publish (one LWW record per wallet).
 *  - **Restore:** a decrypt-miss (key wrapped only to a prior device) triggers a
 *    session-once background pull → `openKeyVault` → merge into the in-memory caches.
 *
 * The wallet backup key `bk` is derived ONCE per session (a `signMessage` popup) and
 * cached in memory.
 */
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
import { currentSwitchGeneration } from './walletScope';
import { createBackupKeyCache, runRestore, runPublish } from './keyVaultCore';

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

/** Forget the cached backup key + all session state (call on wallet disconnect/switch).
 *  Cancels any pending backup so a debounced publish can't fire under a NEW wallet,
 *  and abandons any in-flight backup-key derivation. */
export function clearKeyVaultSession(): void {
  backupKeys.clear();
  restoreRun++; // an in-flight restore from before this clear must not write restoreState
  restoreState = 'idle';
  pendingBackup = false;
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
}

function currentKeyring(): VaultKeyring {
  return { conv: exportConvKeysForVault(), chan: exportChannelKeysForVault() };
}

const isEmptyKeyring = (kr: VaultKeyring): boolean =>
  Object.keys(kr.conv).length === 0 && Object.keys(kr.chan).length === 0;

// --- backup (debounced) -----------------------------------------------------

const BACKUP_DEBOUNCE_MS = 4_000;
let backupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBackup = false;
let publishing = false;

/**
 * Arm a debounced backup. CRITICAL ordering: never publish before the remote vault
 * has been pulled + merged this session, or a fresh device would clobber its own
 * history (LWW) with a partial keyring. While restore is not yet `done`, record the
 * intent and kick restore; the restore completion re-arms the backup.
 */
function scheduleBackup(): void {
  if (restoreState !== 'done') {
    pendingBackup = true;
    tryRestoreKeyVault();
    return;
  }
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void publishBackup();
  }, BACKUP_DEBOUNCE_MS);
}

async function publishBackup(): Promise<void> {
  if (publishing) return;
  // Guard a wallet switch between scheduling and now: only seal under the
  // wallet the keyring + backup key belong to (defence-in-depth alongside the
  // disconnect timer cancel — never write account A's keys into account B's
  // vault). The generation check is the tighter one: see `tryRestoreKeyVault()`
  // for why `walletAddress()` alone still leaves a narrow window; here it would
  // mean sealing A's keyring but sending under B's already-attached signer —
  // publishing a backup B can't read AND clobbering B's own real one. The key
  // must also be the one derived FOR this wallet (runPublish checks its tag).
  const sealWallet = walletAddress();
  const sealGeneration = currentSwitchGeneration();
  const keyring = currentKeyring();
  publishing = true;
  try {
    await runPublish({
      sealWallet,
      stale: () => walletAddress() !== sealWallet || currentSwitchGeneration() !== sealGeneration,
      keyring,
      isEmpty: isEmptyKeyring,
      ensureKey: (w) => backupKeys.ensure(w),
      seal: (key, kr) => sealKeyVault(key, kr),
      send: async (sealed) => {
        await getClient().syncKeyVault(sealed);
        e2elog('keyvault: backup published', {
          conv: Object.keys(keyring.conv).length,
          chan: Object.keys(keyring.chan).length,
          bytes: sealed.encrypted_vault.length,
        });
      },
    });
  } catch (e) {
    e2elog('keyvault: backup failed', { err: (e as Error)?.message });
  } finally {
    publishing = false;
  }
}

// --- restore (session-once, background) -------------------------------------

let restoreState: 'idle' | 'inflight' | 'done' = 'idle';
/** Bumped by every session clear; a restore only records its outcome if no
 *  clear happened since it started (else it would overwrite the NEXT
 *  account's `inflight`/`done` state). */
let restoreRun = 0;

/** Pull + decrypt the vault and merge restored keys into the in-memory caches.
 *  Session-once and idempotent; safe to call from a decrypt-miss render path. A
 *  transient fetch failure resets to `idle` (retried on the next trigger); only a
 *  genuine 404 or an unrecoverable blob is terminal (`done`). */
export function tryRestoreKeyVault(): void {
  if (restoreState !== 'idle') return;
  restoreState = 'inflight';
  const myRun = restoreRun;
  void (async () => {
    // Which account this restore belongs to. `importConvKeysFromVault` and
    // `importChannelKeysFromVault` write the SHARED DM/channel key caches, so
    // applying after a switch would load one account's conversation keys into
    // the other account's session.
    //
    // MUST be `walletAddress()`, not `vaultActiveAddress()`. The two flip at
    // different points of an account switch (`switchAccountInner` in
    // auth.ts): `vaultActivate()` moves `vaultActiveAddress()` to the NEW
    // account immediately, while `walletAddress()` and the API client's
    // attached signer — the things `ensureBackupKey()` and `getKeyVault()`
    // actually use — don't flip until teardown finishes, several awaits
    // later. A restore that starts (e.g. from account A's own decrypt-miss,
    // or WS traffic still arriving before its socket closes) inside that
    // window used to capture `forWallet = vaultActiveAddress()` = the NEW
    // account B while every fetch it performed was still authenticated as
    // and derived from OLD account A — so it fetched and decrypted A's real
    // vault successfully, and every "did the wallet change?" recheck below
    // compared B against B and always passed. The result: A's real DM and
    // channel content keys got merged into the shared caches while B was
    // active, and B's UI could then decrypt — and send into — A's private
    // channels it was never a member of. Gating on `walletAddress()` instead
    // ties this guard to the same identity the fetch itself is bound to, so
    // a switch invalidates the restore the instant the signer actually
    // changes, matching `publishBackup()`'s existing (correct) guard below.
    //
    // `walletAddress()` alone still leaves a narrow residual window: it flips
    // in the SAME statement as the API client's signer, late in the switch,
    // but `tearDownAccountSession()`'s cache clears (the thing this restore
    // would be poisoning) complete strictly BEFORE that point — so a restore
    // resolving in the sliver between "caches cleared" and "walletAddress()
    // flipped" would still read the OLD wallet and pass. `switchGeneration`
    // (walletScope.ts) is bumped synchronously at the very TOP of the switch,
    // before any of that, so it closes the window regardless of exactly when
    // the async pieces interleave.
    const forWallet = walletAddress();
    const forGeneration = currentSwitchGeneration();
    const stale = () => walletAddress() !== forWallet || currentSwitchGeneration() !== forGeneration;
    try {
      // keyVaultCore.ts `runRestore`: also refuses a backup key derived for
      // any other wallet, and never turns a decrypt failure with such a key
      // (or after a switch) into terminal `done`.
      const outcome = await runRestore({
        forWallet,
        stale,
        ensureKey: (w) => backupKeys.ensure(w),
        fetch: () => getClient().getKeyVault(), // null only on a true 404
        open: (key, resp) => openKeyVault(key, resp),
        importKeys: (keyring) => {
          const conv = importConvKeysFromVault(keyring.conv);
          const chan = importChannelKeysFromVault(keyring.chan);
          e2elog('keyvault: restored', { conv, chan });
        },
        log: e2elog,
      });
      if (myRun === restoreRun) restoreState = outcome;
    } catch {
      if (myRun === restoreRun) restoreState = 'idle';
    } finally {
      // If a key was cached while restore was in flight, publish now that the
      // remote keyring is merged (no longer at risk of clobbering it).
      if (myRun === restoreRun && restoreState === 'done' && pendingBackup) {
        pendingBackup = false;
        scheduleBackup();
      }
    }
  })();
}

// Register into the crypto caches at module load (imported for side effects).
setKeyringChangeListener(scheduleBackup);
setVaultRestoreRequester(tryRestoreKeyVault);
