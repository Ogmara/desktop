/**
 * Auth state — reactive Solid.js signals for wallet authentication.
 *
 * Desktop-specific: only supports built-in wallet mode (no Klever
 * extension, no K5 delegation). All signing uses the vault's WalletSigner.
 */

import { createSignal } from 'solid-js';
import type { WalletSigner } from '@ogmara/sdk';
import {
  vaultInit,
  vaultStore,
  vaultGenerate,
  vaultWipe,
  vaultGetSigner,
  vaultGetAddress,
} from './vault';
import { getClient } from './api';
import { getSetting, setSetting } from './settings';
import { ensureDeviceEncBinding, wipeDeviceEncKey } from './deviceEnc';
import {
  setWalletScope,
  wipeWalletScope,
  runWalletScopeMigrationOnce,
  runWalletSwitchResets,
} from './walletScope';
import { vaultMigrationsReady } from './vaultMigration';

export type AuthStatus = 'none' | 'loading' | 'locked' | 'ready';
export type WalletSource = 'builtin' | null;

const [authStatus, setAuthStatus] = createSignal<AuthStatus>('none');
const [walletAddress, setWalletAddress] = createSignal<string | null>(null);
const [walletSource, setWalletSource] = createSignal<WalletSource>(null);
const [isRegistered, setIsRegistered] = createSignal(false);
/** The L2 signing address. Same as walletAddress for built-in wallets. */
const [l2Address, setL2Address] = createSignal<string | null>(null);
/** True if device registration on the L2 node failed. */
const [deviceMappingFailed, setDeviceMappingFailed] = createSignal(false);
/** Error message from the last failed device registration attempt. */
const [deviceMappingError, setDeviceMappingError] = createSignal<string | null>(null);
/** True when a wallet was just created/imported this session (triggers PIN setup prompt). */
const [walletJustCreated, setWalletJustCreated] = createSignal(false);

export { authStatus, walletAddress, walletSource, isRegistered, l2Address, deviceMappingFailed, deviceMappingError, walletJustCreated };

/** Get the current signer (from vault). */
export function getSigner(): WalletSigner | null {
  return vaultGetSigner();
}

/** Initialize auth on app startup. Loads vault, attaches signer to client. */
export async function initAuth(): Promise<void> {
  setAuthStatus('loading');
  try {
    // BEFORE anything reads or creates a wallet. The adoption migration claims
    // the pre-namespacing global keys for whoever last owned them, and must run
    // exactly once while no account is scoped — running it later, with a
    // different account active, would irreversibly adopt the previous
    // account's channels, topic groups and hidden DMs into the new namespace.
    runWalletScopeMigrationOnce();
    // Shares the memoized run with `App.tsx`, which starts independently.
    await vaultMigrationsReady();
    const address = await vaultInit();
    if (address) {
      const signer = vaultGetSigner();
      if (signer) {
        getClient().withSigner(signer);

        // Restore wallet source and address from persisted settings
        const savedSource = getSetting('walletSource');
        const savedAddress = getSetting('walletAddress');

        // Point per-account storage at this wallet BEFORE any per-account
        // setting is read below.
        setWalletScope(address);
        // L2 address is always the device key (signer) address
        setL2Address(address);

        if (savedSource === 'builtin' && savedAddress) {
          setWalletAddress(address);
          setWalletSource('builtin');
          setAuthStatus('ready');
          checkRegistrationStatus();
        } else {
          // Vault has a valid key but localStorage was cleared (e.g., Tauri
          // dev restart, cache clear). The OS keyring is the source of truth
          // for desktop — if a key exists, it's a built-in wallet.
          setWalletAddress(address);
          setWalletSource('builtin');
          setSetting('walletSource', 'builtin');
          setSetting('walletAddress', address);
          setAuthStatus('ready');
          checkRegistrationStatus();
        }
        // Publish this device's encryption-key binding (E2E P0, §2.4).
        // Best-effort + idempotent: a failure retries on the next login.
        void ensureDeviceEncBinding().catch((e) =>
          console.warn('[deviceEnc] binding failed:', e),
        );
        return;
      }
    }
    setAuthStatus('none');
  } catch {
    setAuthStatus('none');
  }
}

/** Connect with a hex-encoded private key (import). */
export async function connectWithKey(hexKey: string): Promise<string> {
  const address = await vaultStore(hexKey);
  const signer = vaultGetSigner()!;
  getClient().withSigner(signer);
  setWalletAddress(address);
  // Before the per-account `setSetting` calls below, or they land in the
  // previous account's namespace (or the bare key with none active).
  setWalletScope(address);
  setL2Address(address);
  setWalletSource('builtin');
  setSetting('walletSource', 'builtin');
  setSetting('walletAddress', address);
  setAuthStatus('ready');
  setWalletJustCreated(true);
  checkRegistrationStatus();
  // Publish this wallet's device encryption-key binding (E2E P0, §2.4) so peers
  // can wrap DM keys to it on the FIRST session — not only after a restart.
  void ensureDeviceEncBinding().catch((e) =>
    console.warn('[deviceEnc] binding failed:', e),
  );
  return address;
}

/** Generate a new wallet and connect. */
export async function generateWallet(): Promise<string> {
  const address = await vaultGenerate();
  const signer = vaultGetSigner()!;
  getClient().withSigner(signer);
  setWalletAddress(address);
  // Before the per-account `setSetting` calls below, or they land in the
  // previous account's namespace (or the bare key with none active).
  setWalletScope(address);
  setL2Address(address);
  setWalletSource('builtin');
  setWalletJustCreated(true);
  setSetting('walletSource', 'builtin');
  setSetting('walletAddress', address);
  setAuthStatus('ready');
  checkRegistrationStatus();
  // Publish this wallet's device encryption-key binding (E2E P0, §2.4).
  void ensureDeviceEncBinding().catch((e) =>
    console.warn('[deviceEnc] binding failed:', e),
  );
  return address;
}

/** Disconnect wallet and wipe vault. */
export async function disconnectWallet(): Promise<void> {
  // Capture before anything clears it — the wipe needs to know which namespace
  // to remove, and `walletAddress()` is nulled part-way through.
  const leaving = walletAddress();
  // Cancel armed settings-sync uploads before tearing anything down: a timer
  // firing mid-teardown resolves `vaultExportKey()` and would seal this
  // account's data under whatever key is current by then, or upload it after
  // the vault is gone.
  runWalletSwitchResets();
  await vaultWipe();
  await wipeDeviceEncKey();
  setSetting('walletSource', '');
  setSetting('walletAddress', '');
  setSetting('deviceRegistered', '');
  // Remove this account's namespaced data. Namespacing alone would keep it
  // addressable on disk forever; wiping alone would lose it on every switch.
  // Doing both means an account's data survives a SWITCH but not a deliberate
  // disconnect.
  if (leaving) wipeWalletScope(leaving);
  setWalletAddress(null);
  setL2Address(null);
  setWalletSource(null);
  setAuthStatus('none');
  setIsRegistered(false);
  // Cleared LAST: this fires the store resets, which reload each signal from
  // the (now empty) namespace, so the UI drops the previous account's lists in
  // the same tick rather than at the next launch.
  setWalletScope(null);
  // Drop the cached own avatar so a different account doesn't inherit it.
  import('./ownAvatar').then(({ clearOwnAvatar }) => clearOwnAvatar()).catch(() => {});
  // Clear E2E session state so a different account can't read this one's keys:
  // the in-memory DM/channel content-key caches and the cached vault backup key.
  Promise.all([
    import('./dmCrypto').then(({ clearDmKeyCache }) => clearDmKeyCache()),
    import('./channelCrypto').then(({ clearChannelKeyCache }) => clearChannelKeyCache()),
    import('./keyVault').then(({ clearKeyVaultSession }) => clearKeyVaultSession()),
    // Revoke decrypted-media object URLs (P5) so a different account can't read
    // this one's decrypted attachments out of the blob: URL cache.
    import('./mediaCrypto').then(({ clearMediaObjectUrls }) => clearMediaObjectUrls()),
  ]).catch(() => {});
}

/** Update on-chain registration status and invalidate profile cache. */
export function setRegistrationStatus(registered: boolean): void {
  // Invalidate profile cache so the verified badge updates immediately
  const addr = walletAddress();
  if (addr && registered) {
    import('./profile').then(({ invalidateProfile }) => invalidateProfile(addr));
  }
  setIsRegistered(registered);
}

/**
 * Check on-chain registration status by querying the L2 node's user profile.
 * A user is "verified" when `registered_at > 0` (set by the chain scanner
 * from a SC UserRegistered event).
 */
export async function checkRegistrationStatus(): Promise<void> {
  const addr = walletAddress();
  if (!addr) return;
  try {
    const resp = await getClient().getUserProfile(addr);
    setIsRegistered(resp.user.registered_at > 0);
    // Cache the user's OWN avatar image locally while we're (presumably) on a
    // node that has it, so it keeps rendering after switching to a node
    // without IPFS / without this user's media. Best-effort, fire-and-forget.
    import('./ownAvatar').then(({ ensureOwnAvatarCached }) =>
      ensureOwnAvatarCached(resp.user.avatar_cid),
    ).catch(() => { /* non-critical */ });
  } catch {
    setIsRegistered(false);
  }
}
