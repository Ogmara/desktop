/**
 * Whether a channel's media/content must be treated as encrypted, extracted
 * as a pure function so this security-critical decision is independently
 * testable (see channelEncryption.test.ts).
 *
 * FAILS CLOSED (2026-08-02): a confidentiality decision must never default to
 * "plaintext" just because the channel record hasn't resolved yet. The bug
 * this fixes — `isEncrypted()` reading `channelInfo()?.channel?.X` directly —
 * returned `false` (plaintext) while `channelInfo` was still loading (initial
 * mount, or a transient `createResource` refetch that briefly clears the
 * resolved value), so an image attached in that window uploaded to IPFS
 * unencrypted even in a private/encrypted channel. Unless the channel record
 * has SUCCESSFULLY resolved (`state === 'ready'`) to a definite plaintext
 * signal, this returns `true`.
 */
import { PRIVATE_CHANNEL_ID_FLOOR } from './privateInvite.ts';

/**
 * Is `id` in the PUBLIC channel-id namespace (`0 < id < PRIVATE_CHANNEL_ID_FLOOR`,
 * a safe integer)? The node enforces `channel_id > floor` for every Private
 * channel and `< floor` for every other type, so an id outside this range can
 * only be private — no node-served `channel_type`/`encryption_enabled` may
 * ever downgrade it (a hostile node reporting `channel_type: 0`). Ids below
 * the floor are only "probably public": legacy pre-floor private rows exist,
 * so the record still decides there.
 */
export function isPublicRangeChannelId(id: unknown): boolean {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id < PRIVATE_CHANNEL_ID_FLOOR;
}

export type ChannelInfoState = 'unresolved' | 'pending' | 'ready' | 'refreshing' | 'errored';

export interface ChannelEncryptionFields {
  encryption_enabled?: boolean | null;
  channel_type?: number | null;
}

export function resolveIsEncrypted(
  state: ChannelInfoState,
  channel: ChannelEncryptionFields | null | undefined,
  privateChannelType: number,
  channelId: number | null | undefined,
): boolean {
  // Private-range id: always encrypted, whatever the node says (desktop 1.85.0).
  if (!isPublicRangeChannelId(channelId)) return true;
  if (state !== 'ready') return true; // still loading / refreshing / errored -> fail closed
  if (!channel) return true; // resolved but no record (e.g. fetch returned null) -> fail closed
  return channel.encryption_enabled === true || channel.channel_type === privateChannelType;
}

/**
 * Whether the channel record is KNOWN — successfully fetched, present, and a
 * full (non-`restricted`) view — so it may drive a SIDE EFFECT such as marking
 * the channel read, remembering it as the last channel, or sending into it.
 *
 * Deliberately separate from `resolveIsEncrypted`: that function answers a
 * confidentiality question and must fail CLOSED (assume encrypted) when the
 * record is unknown. "Unknown ⇒ encrypted" is the right default for
 * encrypt-before-upload, and exactly the wrong one for anything that acts on
 * the channel: it made "record still loading / fetch failed" look identical
 * to "this is an encrypted public channel" and auto-joined channels the
 * account had never been invited to. Side effects need POSITIVE evidence.
 *
 * `restricted` is the node's limited view of a private channel served to a
 * non-member (l2-node `get_channel`): it is a placeholder, not membership.
 * A record must also carry a numeric `channel_type`.
 */
export function isChannelRecordUsable(
  state: ChannelInfoState,
  channel: ChannelEncryptionFields | null | undefined,
  restricted?: boolean | null,
): boolean {
  if (state !== 'ready' || channel == null || restricted === true) return false;
  // A record without a numeric type is not one we understand well enough to
  // act on (and `channel_type ?? 0` elsewhere would silently read it as public).
  return typeof channel.channel_type === 'number';
}

/**
 * The channel-type HINT for key cover (desktop 1.85.0, protocol §3.9.2):
 * `true` = verify each member's signed membership evidence first, `false` =
 * positively public (the node's member list is used, as before), `undefined`
 * = not known yet (cover is DEFERRED — neither verified nor trusted).
 *
 * A private-range id (see {@link isPublicRangeChannelId}) is always `true`,
 * whatever the record says. Below the floor only a resolved, typed record
 * decides; loading / refreshing / errored / absent / untyped → `undefined`
 * (never "public" just because the type wasn't known yet, and never a
 * member-proofs request for what is probably a public channel).
 */
export function resolveIsPrivateForCover(
  state: ChannelInfoState,
  channel: ChannelEncryptionFields | null | undefined,
  privateChannelType: number,
  channelId: number | null | undefined,
): boolean | undefined {
  if (!isPublicRangeChannelId(channelId)) return true;
  if (state !== 'ready' || !channel || typeof channel.channel_type !== 'number') return undefined;
  return channel.channel_type === privateChannelType;
}

/**
 * Whether opening this channel should auto-join it so the account receives
 * the public channel's epoch key.
 *
 * Requires positive evidence on every axis: a usable record, NOT private
 * (private channels are invite-only and must never be joined as a side effect
 * of viewing one), and `encryption_enabled === true` exactly (legacy
 * plaintext channels need no key, so no join). Every unknown answers `false`.
 */
export function shouldAutoJoinEncryptedChannel(
  state: ChannelInfoState,
  channel: ChannelEncryptionFields | null | undefined,
  privateChannelType: number,
  restricted?: boolean | null,
): boolean {
  if (!isChannelRecordUsable(state, channel, restricted)) return false;
  // `channel` is non-null with a numeric type here (isChannelRecordUsable).
  const ch = channel as ChannelEncryptionFields;
  if (ch.channel_type === privateChannelType) return false;
  return ch.encryption_enabled === true;
}
