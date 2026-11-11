/**
 * The keyring decisions of the channel key FLOWS (desktop 1.85.0), pulled out
 * of `channelCrypto.ts` so they are tested by behaviour against the real SDK
 * keyring (`channelKeyFlows.test.ts`) instead of by source greps:
 *  - how a verified wrap from our own enc-key slot is put (`ownSlot` only when
 *    its verified author is OUR wallet; other members' wraps bounded by the
 *    node's highest + 256);
 *  - how a node-served legacy key is put and what a refusal means;
 *  - how the node's commitment answer marks a key FINAL (only our own
 *    verified pair, compared exactly with the node's winner).
 * Every put takes the switch generation the FLOW captured (its `DeviceCtx`),
 * never the current one.
 */
import { keyCommitmentFromHex, keyCommitmentsEqual, type KeyCommitmentInfo } from '@ogmara/sdk';
import type { ChannelKeys, KeyPutOpts } from './channelKeyStore.ts';
import type { KeyMeta } from './epochKeys.ts';

/**
 * Put options for a wrap `verifyChannelKeyWrap` verified from OUR OWN slot:
 * `ownSlot` exactly when the wrap's verified author wallet is ours (a key we
 * established, on any of our devices) — never member-capped; another member's
 * wrap is bounded by the node's highest + 256 and the member caps.
 */
export function ownSlotWrapOpts(
  authorWallet: string, selfWallet: string, meta: KeyMeta, nodeHighest: number,
): KeyPutOpts {
  return { source: 'wrap', meta, verified: true, ownSlot: authorWallet === selfWallet, nodeHighest };
}

/**
 * Hold a node-served commitment-less (legacy) key for decryption: source
 * `legacy`, bounded by the node's highest + 256, for the CAPTURED generation.
 * `held`: the epoch now has a key; `missing`: dropped (account switched, or
 * refused by the keyring's caps / ceiling and nothing else held there) — the
 * caller then asks the vault restore, it never uses the key on the side.
 */
export function putLegacyKey(
  keys: ChannelKeys, scopeHex: string, epoch: number, key: Uint8Array, generation: number, nodeHighest: number,
): 'held' | 'missing' {
  const r = keys.put(scopeHex, epoch, key, generation, { source: 'legacy', nodeHighest });
  if (r === 'stale') return 'missing';
  if (r === 'refused' || r === 'invalid') return keys.holds(scopeHex, epoch) ? 'held' : 'missing';
  return 'held';
}

/**
 * Apply the node's commitment answer for `epoch`: mark FINAL the held key
 * whose AUTHOR-VERIFIED, pair-consistent pair equals the node's FINAL winner
 * exactly (`keyTs` and commitment). The node's pair is only compared, never
 * used: a key whose pair differs is never marked. True when one was marked.
 */
export function markFinalFromCommitment(
  keys: ChannelKeys, scopeHex: string, epoch: number, info: KeyCommitmentInfo, generation: number,
): boolean {
  if (info.epoch !== epoch || info.state !== 'arbitrated' || info.final !== true
      || typeof info.key_commitment !== 'string' || !Number.isSafeInteger(info.key_ts)) return false;
  const c = keyCommitmentFromHex(info.key_commitment);
  if (!c) return false;
  for (const e of keys.entriesAt(scopeHex, epoch)) {
    if (!e.authorVerified || !e.verified || !e.pair) continue;
    if (e.pair.keyTs !== info.key_ts || !keyCommitmentsEqual(e.pair.commitment, c)) continue;
    const r = keys.markFinal(scopeHex, epoch, e.key, { keyTs: e.pair.keyTs, keyCommitment: e.pair.commitment }, generation);
    return r === 'verified' || r === 'promoted';
  }
  return false;
}
