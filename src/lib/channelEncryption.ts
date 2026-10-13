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
export type ChannelInfoState = 'unresolved' | 'pending' | 'ready' | 'refreshing' | 'errored';

export interface ChannelEncryptionFields {
  encryption_enabled?: boolean | null;
  channel_type?: number | null;
}

export function resolveIsEncrypted(
  state: ChannelInfoState,
  channel: ChannelEncryptionFields | null | undefined,
  privateChannelType: number,
): boolean {
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
