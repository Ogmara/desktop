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
  buildDeviceEncRevoke,
  type WalletSignFn,
} from '@ogmara/sdk';
import { getItemAsync, setItemAsync, deleteItemAsync } from './secureStore';
import { getSetting, setSetting } from './settings';
import { SS, isValidAddress } from './vaultAccounts';
import { vaultActiveAddress, vaultGetAddress } from './vault';
import { signMessage } from './klever';
import { getClient } from './api';
import { e2elog, withRetry } from './e2eDebug';

const ENC_PRIV_KEY = 'ogmara.vault.enc_private_key';

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Stable per-install device identifier (32-byte hex). Public, persisted once.
 *
 * ACCEPTED SPEC DEVIATION (protocol §2.4): §2.4 defines `device_id` as the
 * device's Ed25519 *signing* key. The desktop built-in-wallet model has no
 * separate device signing key (it signs with the embedded wallet key directly),
 * so we mint a random stable per-install `device_id` instead. The node accepts
 * this (router validation only checks the value is 32-byte hex), and §2.4/§5.3
 * should acknowledge that built-in-wallet clients use a random per-install
 * device_id. Behavior is intentional — do not "fix" by deriving from a key.
 */
export function getOrCreateDeviceId(): string {
  let id = getSetting('deviceId');
  if (!id) {
    id = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    setSetting('deviceId', id);
  }
  return id;
}

/**
 * This account's X25519 encryption secret slot.
 *
 * PER ACCOUNT, not per install. `enc_pub` is published to the node's directory
 * in the clear, so one secret shared across accounts publishes the SAME
 * `enc_pub` for all of them — proving to the node, and to anyone who reads the
 * directory, that they are the same person. It also means a ciphertext wrapped
 * to account A is decryptable by account B on this device, so "one account
 * cannot read another's keys" holds by construction rather than by argument.
 * See protocol spec §2.4.
 *
 * Falls back to the legacy device-global slot only when no account is active.
 */
function encPrivKeyFor(): string {
  const addr = vaultActiveAddress();
  return addr && isValidAddress(addr) ? SS.encPrivFor(addr) : ENC_PRIV_KEY;
}

/**
 * Load or create THIS ACCOUNT's X25519 encryption keypair.
 *
 * Reading the legacy device-global slot is fine — it is the pre-v2 key, and
 * `claimDeviceIdentityOnce` copies it to the first account that needs it.
 * CREATING into it is not: with no account scoped there is no account to own
 * the key, and minting one there would hand a shared identity to whichever
 * account is activated next. Refuse instead; the caller retries once an
 * account is active.
 */
export async function getOrCreateEncKeypair(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const slot = encPrivKeyFor();
  const stored = await getItemAsync(slot);
  if (stored) {
    const privateKey = hexToBytes(stored);
    return { privateKey, publicKeyHex: encPublicKeyHex(privateKey) };
  }
  if (slot === ENC_PRIV_KEY) {
    throw new Error('No account is active — refusing to create a device encryption key');
  }
  const kp = generateDeviceEncKeypair();
  // Re-read before writing. Two concurrent callers can both see an empty slot
  // and both mint; the loser's write would overwrite the winner's live secret,
  // orphaning every envelope wrapped to its `enc_pub`. Whoever lost adopts the
  // stored key instead. (Web closed the same race in 0.75.2.)
  const raced = await getItemAsync(slot);
  if (raced) {
    const privateKey = hexToBytes(raced);
    return { privateKey, publicKeyHex: encPublicKeyHex(privateKey) };
  }
  await setItemAsync(slot, bytesToHex(kp.privateKey));
  return kp;
}

/**
 * Give `addr` the pre-v2 device identity, exactly once.
 *
 * COPIES, never moves. Without this, `ensureDeviceEncBinding` finds the new
 * per-account slot empty, mints a fresh keypair, publishes a new binding, and
 * `revokeStaleEncKeys` retires the old `enc_pub` — making every channel-key
 * envelope already wrapped to it permanently undecryptable.
 *
 * Gated on its OWN marker, deliberately separate from the preference-scope
 * migration: a device that already ran that one has its marker set, so folding
 * these together would skip this entirely.
 */
export async function claimDeviceIdentityOnce(addr: string): Promise<void> {
  if (!isValidAddress(addr)) return;
  const MARKER = 'ogmara.vault.enc_identity_claimed';
  try {
    if (await getItemAsync(MARKER)) return;
    const legacy = await getItemAsync(ENC_PRIV_KEY);
    if (legacy) {
      const target = SS.encPrivFor(addr);
      // Never overwrite a key this account already has.
      if (!(await getItemAsync(target))) {
        await setItemAsync(target, legacy);
      }
    }
    // The legacy slot is NOT deleted: it stays readable for an older build,
    // and a half-finished claim can be retried.
    await setItemAsync(MARKER, '1');
  } catch {
    // Leave the marker unset so a later launch retries.
  }
}

/**
 * Revoke any of MY OWN previously-published enc keys for `deviceId` whose
 * `enc_pub` differs from my current one. The node keys `device_enc_keys` by
 * `enc_pub` (not device_id), so a regenerated enc key would otherwise leave the
 * stale enc_pub *active* — and since `channel_keys` envelopes are keyed by
 * `device_id` (first-write-wins), a sender wrapping to BOTH enc_pubs of one
 * device can have the stale wrapping win, making messages undecryptable.
 * Revoking the stale enc_pub guarantees exactly one active enc_pub per device.
 * Best-effort (also defended in `establishMyKey` by newest-per-device dedup).
 */
async function revokeStaleEncKeys(
  wallet: string,
  deviceId: string,
  currentEncPub: string,
  sign: WalletSignFn,
): Promise<void> {
  try {
    const { keys } = await getClient().getEncKeys(wallet);
    const did = deviceId.toLowerCase();
    const cur = currentEncPub.toLowerCase();
    const stale = keys.filter(
      (k) => (k.device_id ?? '').toLowerCase() === did && (k.enc_pub ?? '').toLowerCase() !== cur,
    );
    const network = await getClient().getNetwork();
    for (const k of stale) {
      const revoke = await buildDeviceEncRevoke({
        walletAddress: wallet,
        encPubHex: k.enc_pub,
        walletSign: sign,
        network,
      });
      await withRetry(() => getClient().publishEncKeyEnvelope(wallet, revoke), 'revoke stale enc-key');
      e2elog('revoked stale enc_pub', { deviceId, staleEncPub: k.enc_pub });
    }
  } catch (e) {
    console.warn('[deviceEnc] stale enc-key revoke skipped:', e);
  }
}

/**
 * Ensure this device's encryption key is bound to the wallet on the node.
 * Idempotent: skips when already published for this (wallet, enc_pub). Best-effort —
 * a failure (offline node, PoW) leaves the marker unset so the next login retries.
 * On a key change, supersedes the old enc_pub (revoke) so the directory holds
 * exactly one active enc_pub per device.
 */
export async function ensureDeviceEncBinding(): Promise<void> {
  const wallet = vaultGetAddress();
  if (!wallet) return;

  const kp = await getOrCreateEncKeypair();
  // The keypair is resolved from the CURRENT account, which may have changed
  // while that await was outstanding — this runs un-awaited on connect. Going
  // on would bind the NEW account's enc_pub to the OLD account's wallet, and
  // the revoke below would retire the old account's real key, making every
  // envelope already wrapped to it permanently undecryptable.
  if (vaultGetAddress() !== wallet) return;
  const marker = `v2:${wallet}:${kp.publicKeyHex}`;
  const deviceId = getOrCreateDeviceId();

  // Registry-verified (not just the local marker): the marker only records what
  // WE last published — it can't see that the node's enc_pub for our device_id
  // diverged from our current local enc_pub (the "can't decrypt" cause). Confirm
  // the node actually has THIS device_id bound to our CURRENT enc_pub; only skip
  // when the registry agrees AND the marker is set.
  let registryOk = false;
  try {
    const { keys } = await getClient().getEncKeys(wallet);
    const mine = keys.find((k) => (k.device_id ?? '').toLowerCase() === deviceId.toLowerCase());
    registryOk = !!mine && (mine.enc_pub ?? '').toLowerCase() === kp.publicKeyHex.toLowerCase();
    e2elog('binding check', {
      wallet, deviceId, localEncPub: kp.publicKeyHex,
      registryEncPub: mine?.enc_pub ?? null, registryOk, markerSet: getSetting('encKeyBound') === marker,
    });
  } catch {
    if (getSetting('encKeyBound') === marker) return;
  }
  if (registryOk && getSetting('encKeyBound') === marker) return;

  // signMessage returns 128-char hex; the SDK normalizes it internally.
  const sign: WalletSignFn = (claim) => signMessage(claim);
  const envelope = await buildDeviceEncBinding({
    walletAddress: wallet,
    encPubHex: kp.publicKeyHex,
    deviceIdHex: deviceId,
    walletSign: sign,
    network: await getClient().getNetwork(),
  });
  await withRetry(() => getClient().publishEncKeyEnvelope(wallet, envelope), 'publish binding');
  e2elog('published binding', { deviceId, encPub: kp.publicKeyHex });
  // Retire any stale enc_pub for this device AFTER the new key is registered, so
  // there is never a window with zero active keys for the device.
  // Re-checked before the DESTRUCTIVE step: revocation is not reversible and
  // the publish above may itself have taken a while.
  if (vaultGetAddress() !== wallet) return;
  await revokeStaleEncKeys(wallet, deviceId, kp.publicKeyHex, sign);
  setSetting('encKeyBound', marker);
}

/** Wipe the device encryption key + binding markers (on wallet disconnect). */
// `wipeDeviceEncKey` was removed with the multi-account vault.
//
// Per-account removal deletes `SS.encPrivFor(addr)` through `keyArtefactsFor`,
// and a total wipe now enumerates natively by prefix — so a separate helper
// that resolved its slot from the ACTIVE account was both redundant and
// dangerous: called after the account was removed it fell back to the shared
// legacy slot and destroyed the pre-v2 identity for every other account.

