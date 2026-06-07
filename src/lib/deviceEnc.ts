/**
 * Device encryption keys (E2E P0, protocol §2.4).
 *
 * Each install holds an X25519 *encryption* keypair. The wallet authorizes the
 * binding (desktop signs with the embedded vault key), and the binding lets other
 * users wrap message keys to this device. Desktop has no separate device *signing*
 * key (it signs with the wallet directly), so we mint a stable random `device_id`
 * as the device's public identifier.
 *
 * NOTE (P1 prerequisite): the enc private key is stored raw in the secure store
 * (0600). It is not yet used to decrypt anything (message encryption lands in P1).
 * Before P1 ships, encrypt it at rest under the app-lock key like the wallet key,
 * and fold it into the wallet-encrypted key vault (P3, protocol §2.5).
 */
import {
  generateDeviceEncKeypair,
  encPublicKeyHex,
  buildDeviceEncBinding,
} from '@ogmara/sdk';
import { getItemAsync, setItemAsync, deleteItemAsync } from './secureStore';
import { getSetting, setSetting } from './settings';
import { vaultGetAddress } from './vault';
import { signMessage } from './klever';
import { getClient } from './api';

const ENC_PRIV_KEY = 'ogmara.vault.enc_private_key';

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Stable per-install device identifier (32-byte hex). Public, persisted once. */
function getOrCreateDeviceId(): string {
  let id = getSetting('deviceId');
  if (!id) {
    id = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    setSetting('deviceId', id);
  }
  return id;
}

/** Load or create the device X25519 encryption keypair, persisting the secret. */
async function getOrCreateEncKeypair(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const stored = await getItemAsync(ENC_PRIV_KEY);
  if (stored) {
    const privateKey = hexToBytes(stored);
    return { privateKey, publicKeyHex: encPublicKeyHex(privateKey) };
  }
  const kp = generateDeviceEncKeypair();
  await setItemAsync(ENC_PRIV_KEY, bytesToHex(kp.privateKey));
  return kp;
}

/** Hex of this device's X25519 encryption public key (creates the keypair if absent). */
export async function getDeviceEncPublicKeyHex(): Promise<string> {
  return (await getOrCreateEncKeypair()).publicKeyHex;
}

/**
 * Ensure this device's encryption key is bound to the wallet on the node.
 * Idempotent: skips when already published for this (wallet, enc_pub). Best-effort —
 * a failure (offline node, PoW) leaves the marker unset so the next login retries.
 */
export async function ensureDeviceEncBinding(): Promise<void> {
  const wallet = vaultGetAddress();
  if (!wallet) return;

  const kp = await getOrCreateEncKeypair();
  const marker = `${wallet}:${kp.publicKeyHex}`;
  if (getSetting('encKeyBound') === marker) return;

  const deviceId = getOrCreateDeviceId();
  const envelope = await buildDeviceEncBinding({
    walletAddress: wallet,
    encPubHex: kp.publicKeyHex,
    deviceIdHex: deviceId,
    // signMessage returns 128-char hex; the SDK normalizes it internally.
    walletSign: (claim) => signMessage(claim),
  });
  await getClient().publishEncKeyEnvelope(wallet, envelope);
  setSetting('encKeyBound', marker);
}

/** Wipe the device encryption key + binding markers (on wallet disconnect). */
export async function wipeDeviceEncKey(): Promise<void> {
  await deleteItemAsync(ENC_PRIV_KEY);
  setSetting('encKeyBound', '');
  setSetting('deviceId', '');
}
