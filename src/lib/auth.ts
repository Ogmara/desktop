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
  vaultActivate,
  vaultListAccounts,
  vaultRemoveAccount,
  vaultAddAccount,
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

/**
 * Tear down everything bound to the CURRENT account, before another takes over.
 *
 * Ordering is load-bearing, in this order:
 *
 *   1. The WebSocket closes FIRST. A switch re-renders the tree, and a socket
 *      left open delivers the previous account's frames into the new account's
 *      mounted views.
 *   2. Pending tx-confirm prompts are cancelled — one armed under account A
 *      that resolves after the switch would sign with B's key.
 *   3. The E2E and media caches are cleared and AWAITED, not fired and
 *      forgotten. A cache that clears after the new account's session starts
 *      is the same bug with a shorter window.
 */
export async function tearDownAccountSession(): Promise<void> {
  const { closeWs } = await import('./ws');
  closeWs();

  const { cancelAllPending } = await import('./txConfirm');
  cancelAllPending();

  await Promise.all([
    import('./dmCrypto').then(({ clearDmKeyCache }) => clearDmKeyCache()),
    import('./channelCrypto').then(({ clearChannelKeyCache }) => clearChannelKeyCache()),
    import('./keyVault').then(({ clearKeyVaultSession }) => clearKeyVaultSession()),
    import('./mediaCrypto').then(({ clearMediaObjectUrls }) => clearMediaObjectUrls()),
    import('./ownAvatar').then(({ clearOwnAvatar }) => clearOwnAvatar()),
  ]).catch(() => {
    /* a cache that refuses to clear must not strand the user mid-switch */
  });
}

/**
 * Switch to another account held on this device.
 *
 * The order below is the fix for the worst class of bug here:
 *
 *   - `runWalletSwitchResets()` runs BEFORE `vaultActivate`. Activation moves
 *     the vault's notion of the active account, and a debounced upload timer
 *     firing between that and the scope flip resolves `vaultExportKey()` — the
 *     NEW account's key — while still holding the OLD account's data, writing
 *     a blob nothing can open.
 *   - `vaultActivate` runs BEFORE the teardown. A failed activation must not
 *     leave the session gutted with no signer; if the key will not load, this
 *     throws having changed nothing.
 */
export async function switchAccount(addr: string): Promise<void> {
  if (addr === walletAddress()) return;

  runWalletSwitchResets();

  const loaded = await vaultActivate(addr);
  if (!loaded) throw new Error('That account could not be unlocked on this device');

  await tearDownAccountSession();

  const signer = vaultGetSigner();
  if (!signer) throw new Error('No signer after activation');

  // Scope, client and state together, so nothing observes a half-switched app.
  setWalletScope(loaded);
  getClient().withSigner(signer);
  setWalletAddress(loaded);
  setL2Address(loaded);
  setWalletSource('builtin');
  setAuthStatus('ready');
  setIsRegistered(false);

  // These are global, and identify WHICH account is active.
  setSetting('walletSource', 'builtin');
  setSetting('walletAddress', loaded);

  const { initWs } = await import('./ws');
  initWs(signer);

  void ensureDeviceEncBinding().catch((e) =>
    console.warn('[deviceEnc] binding failed after switch:', e),
  );
  void checkRegistrationStatus();
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

  // Removes THIS account only, and hands over to another held wallet.
  //
  // It used to call the total `vaultWipe()`. Under multi-account that is a
  // two-click path — whose confirmation still says "your wallet", singular —
  // that would erase every wallet on the device with no per-account export
  // gate. A total wipe is a separate, differently-worded action.
  const others = (await vaultListAccounts().catch(() => [])).filter((e) => e.a !== leaving);

  // `wipeDeviceEncKey` WRITES empty markers, so it must precede the scope wipe
  // or it recreates the very breadcrumbs that wipe just removed — and the
  // recovery scan would resurrect the removed address.
  // The DESTRUCTIVE step first, because it is the one that can fail or be
  // refused: removing the last wallet key raises a native confirmation the
  // webview cannot dismiss, and the user may cancel it. Tearing the session
  // down first would leave the app with a closed socket and cleared caches
  // while the account is still there — signed in to nothing.
  await wipeDeviceEncKey().catch(() => {});
  if (leaving) {
    await vaultRemoveAccount(leaving);
  } else {
    // No active account to scope to — fall back to the total wipe.
    await vaultWipe();
  }

  // Only now: close the socket and clear the DM/channel/media/key-vault caches
  // for the departing account. Before any handover below — an earlier version
  // cleared them fire-and-forget at the END, which under a handover would have
  // wiped the INCOMING account's freshly-populated caches instead.
  await tearDownAccountSession();
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

  // Another wallet is still held — activate it rather than leaving the app
  // signed out, which would misrepresent what just happened.
  if (others.length > 0) {
    try {
      await switchAccount(others[0].a);
    } catch {
      /* leave signed out rather than half-switched */
    }
  }
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
    // The account can change across that await; applying afterwards would show
    // one account's verified state for another, and cache one account's avatar
    // under the other's (now namespaced) key.
    if (walletAddress() !== addr) return;
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
