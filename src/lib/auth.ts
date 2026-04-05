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

/** Guard: throws if no signer is available. Use in action handlers. */
export function requireAuth(): WalletSigner {
  const signer = vaultGetSigner();
  if (!signer) throw new Error('Wallet not connected');
  return signer;
}

/** Initialize auth on app startup. Loads vault, attaches signer to client. */
export async function initAuth(): Promise<void> {
  setAuthStatus('loading');
  try {
    const address = await vaultInit();
    if (address) {
      const signer = vaultGetSigner();
      if (signer) {
        getClient().withSigner(signer);

        // Restore wallet source and address from persisted settings
        const savedSource = getSetting('walletSource');
        const savedAddress = getSetting('walletAddress');

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
  setL2Address(address);
  setWalletSource('builtin');
  setSetting('walletSource', 'builtin');
  setSetting('walletAddress', address);
  setAuthStatus('ready');
  setWalletJustCreated(true);
  checkRegistrationStatus();
  return address;
}

/** Generate a new wallet and connect. */
export async function generateWallet(): Promise<string> {
  const address = await vaultGenerate();
  const signer = vaultGetSigner()!;
  getClient().withSigner(signer);
  setWalletAddress(address);
  setL2Address(address);
  setWalletSource('builtin');
  setWalletJustCreated(true);
  setSetting('walletSource', 'builtin');
  setSetting('walletAddress', address);
  setAuthStatus('ready');
  checkRegistrationStatus();
  return address;
}

/** Disconnect wallet and wipe vault. */
export async function disconnectWallet(): Promise<void> {
  await vaultWipe();
  setSetting('walletSource', '');
  setSetting('walletAddress', '');
  setSetting('deviceRegistered', '');
  setWalletAddress(null);
  setL2Address(null);
  setWalletSource(null);
  setAuthStatus('none');
  setIsRegistered(false);
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
  } catch {
    setIsRegistered(false);
  }
}
