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
