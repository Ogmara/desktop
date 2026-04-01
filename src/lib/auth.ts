/**
 * Auth state — reactive Solid.js signals for wallet authentication.
 *
 * Manages device-to-wallet identity mapping for the desktop app.
 * When connected to a Klever Extension wallet, the local device key
 * is registered on the L2 node under the wallet address.
 */

import { createSignal } from 'solid-js';
import type { WalletSigner } from '@ogmara/sdk';
import { buildDeviceClaim } from '@ogmara/sdk';
import {
  vaultInit,
  vaultGenerate,
  vaultGetSigner,
  vaultGetAddress,
  vaultWipe,
} from './vault';

export type WalletSource = 'builtin' | 'klever-extension' | null;

const [walletAddress, setWalletAddress] = createSignal<string | null>(null);
const [walletSource, setWalletSource] = createSignal<WalletSource>(null);
const [l2Address, setL2Address] = createSignal<string | null>(null);
const [deviceMappingFailed, setDeviceMappingFailed] = createSignal(false);

export { walletAddress, walletSource, l2Address, deviceMappingFailed };

/** Initialize auth on startup — restore wallet state from localStorage. */
export async function initAuth(): Promise<string | null> {
  const address = await vaultInit();
  if (!address) return null;

  const signer = vaultGetSigner();
  if (!signer) return null;

  setL2Address(address);

  const savedSource = localStorage.getItem('ogmara.walletSource');
  const savedAddress = localStorage.getItem('ogmara.walletAddress');

  if (savedSource === 'klever-extension' && savedAddress) {
    setWalletAddress(savedAddress);
    setWalletSource('klever-extension');
    signer.walletAddress = savedAddress;
  } else {
    setWalletAddress(address);
    setWalletSource('builtin');
  }

  return address;
}

/** Connect with built-in wallet (device key = wallet key). */
export function setBuiltinWallet(address: string): void {
  setWalletAddress(address);
  setL2Address(address);
  setWalletSource('builtin');
  localStorage.setItem('ogmara.walletSource', 'builtin');
  localStorage.setItem('ogmara.walletAddress', address);
}

/**
 * Connect via Klever Extension + register device on L2 node.
 *
 * @param extensionAddress - The extension wallet's klv1... address
 * @param signMessage - Function to sign a message via the extension
 * @param client - The OgmaraClient instance for API calls
 */
export async function connectExtensionWallet(
  extensionAddress: string,
  signMessage: (message: string) => Promise<string>,
  client: { registerDevice(sig: string, addr: string, ts: number): Promise<unknown> },
): Promise<void> {
  // Reuse existing device key if available, otherwise generate
  let deviceAddress = await vaultInit();
  if (!deviceAddress) {
    deviceAddress = await vaultGenerate();
  }
  const signer = vaultGetSigner()!;

  // Register device on L2 node (skip if cached)
  const cacheKey = `${extensionAddress}:${deviceAddress}`;
  const cached = localStorage.getItem('ogmara.deviceRegistered');
  if (cached !== cacheKey) {
    try {
      const { claimString, timestamp } = buildDeviceClaim(
        signer.publicKeyHex,
        extensionAddress,
      );
      const walletSigHex = await signMessage(claimString);
      await client.registerDevice(walletSigHex, extensionAddress, timestamp);
      localStorage.setItem('ogmara.deviceRegistered', cacheKey);
      setDeviceMappingFailed(false);
    } catch (e) {
      console.warn('Device registration failed, continuing without mapping:', e);
      setDeviceMappingFailed(true);
    }
  }

  signer.walletAddress = extensionAddress;
  setWalletAddress(extensionAddress);
  setL2Address(deviceAddress);
  setWalletSource('klever-extension');
  localStorage.setItem('ogmara.walletSource', 'klever-extension');
  localStorage.setItem('ogmara.walletAddress', extensionAddress);
}

/** Disconnect wallet. */
export async function disconnectWallet(): Promise<void> {
  const source = walletSource();
  if (source !== 'klever-extension') {
    // Built-in wallet: wipe vault
    await vaultWipe();
  }
  setWalletAddress(null);
  setL2Address(null);
  setWalletSource(null);
  setDeviceMappingFailed(false);
  localStorage.removeItem('ogmara.walletSource');
  localStorage.removeItem('ogmara.walletAddress');
  localStorage.removeItem('ogmara.deviceRegistered');
}
