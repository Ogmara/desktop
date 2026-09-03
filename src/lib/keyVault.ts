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
import { signMessage } from './klever';
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
import { vaultActiveAddress } from './vault';

let bk: Uint8Array | null = null;
let bkWallet: string | null = null;
let bkInflight: Promise<Uint8Array | null> | null = null;

/** Derive (once per session) and cache the wallet backup key. Dedupes concurrent
 *  callers so restore + backup racing produce a single wallet popup. */
async function ensureBackupKey(): Promise<Uint8Array | null> {
  const wallet = walletAddress();
  if (!wallet) return null;
  if (bk && bkWallet === wallet) return bk;
  if (bkInflight) return bkInflight;
  bkInflight = (async () => {
    try {
      const sig = await signMessage(VAULT_SIGN_CLAIM); // SDK normalizes hex/base64
      bk = deriveVaultBackupKey(sig);
      bkWallet = wallet;
      return bk;
    } catch (e) {
      e2elog('keyvault: backup-key derivation failed/declined', { err: (e as Error)?.message });
      return null;
    } finally {
      bkInflight = null;
    }
  })();
  return bkInflight;
}

/** Forget the cached backup key + all session state (call on wallet disconnect/switch).
 *  Cancels any pending backup so a debounced publish can't fire under a NEW wallet. */
export function clearKeyVaultSession(): void {
  bk?.fill(0);
  bk = null;
  bkWallet = null;
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
  const sealWallet = walletAddress();
  const keyring = currentKeyring();
  if (isEmptyKeyring(keyring)) return; // nothing to back up
  const key = await ensureBackupKey();
  if (!key) return; // no wallet / user declined the signMessage
  // Guard a wallet switch between scheduling and now: only seal under the wallet
  // the keyring + backup key belong to (defence-in-depth alongside the disconnect
  // timer cancel — never write account A's keys into account B's vault).
  if (walletAddress() !== sealWallet || bkWallet !== sealWallet) return;
  publishing = true;
  try {
    const sealed = sealKeyVault(key, keyring);
    await getClient().syncKeyVault(sealed);
    e2elog('keyvault: backup published', {
      conv: Object.keys(keyring.conv).length,
      chan: Object.keys(keyring.chan).length,
      bytes: sealed.encrypted_vault.length,
    });
  } catch (e) {
    e2elog('keyvault: backup failed', { err: (e as Error)?.message });
  } finally {
    publishing = false;
  }
}

// --- restore (session-once, background) -------------------------------------

let restoreState: 'idle' | 'inflight' | 'done' = 'idle';

/** Pull + decrypt the vault and merge restored keys into the in-memory caches.
 *  Session-once and idempotent; safe to call from a decrypt-miss render path. A
 *  transient fetch failure resets to `idle` (retried on the next trigger); only a
 *  genuine 404 or an unrecoverable blob is terminal (`done`). */
export function tryRestoreKeyVault(): void {
  if (restoreState !== 'idle') return;
  restoreState = 'inflight';
  void (async () => {
    // Which account this restore belongs to. `importConvKeysFromVault` and
    // `importChannelKeysFromVault` write the SHARED DM/channel key caches, so
    // applying after a switch would load one account's conversation keys into
    // the other account's session.
    const forWallet = vaultActiveAddress();
    try {
      const key = await ensureBackupKey();
      if (vaultActiveAddress() !== forWallet) { restoreState = 'idle'; return; }
      if (!key) {
        restoreState = 'idle'; // no wallet / declined popup — allow a later retry
        return;
      }
      let resp;
      try {
        resp = await getClient().getKeyVault(); // null only on a true 404
      } catch (e) {
        restoreState = 'idle'; // transient (network/5xx) — retry on next trigger
        e2elog('keyvault: restore fetch failed (will retry)', { err: (e as Error)?.message });
        return;
      }
      if (vaultActiveAddress() !== forWallet) { restoreState = 'idle'; return; }
      if (resp) {
        try {
          const keyring = openKeyVault(key, resp);
          // Re-checked immediately before the writes themselves.
          if (vaultActiveAddress() !== forWallet) { restoreState = 'idle'; return; }
          const conv = importConvKeysFromVault(keyring.conv);
          const chan = importChannelKeysFromVault(keyring.chan);
          e2elog('keyvault: restored', { conv, chan });
        } catch (e) {
          // Corrupt/foreign/auth-fail blob — terminal; don't re-pop the wallet.
          e2elog('keyvault: restore decrypt failed', { err: (e as Error)?.message });
        }
      }
      restoreState = 'done';
    } finally {
      // If a key was cached while restore was in flight, publish now that the
      // remote keyring is merged (no longer at risk of clobbering it).
      if (restoreState === 'done' && pendingBackup) {
        pendingBackup = false;
        scheduleBackup();
      }
    }
  })();
}

// Register into the crypto caches at module load (imported for side effects).
setKeyringChangeListener(scheduleBackup);
setVaultRestoreRequester(tryRestoreKeyVault);
