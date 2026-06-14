/**
 * Joined-channel tracking — the client-side sidebar visibility filter.
 *
 * There is no on-chain or server-side "joined" state for public channels, so
 * the set of channels a user keeps in their sidebar is a purely local list,
 * backed by localStorage and exposed as a SolidJS signal so the sidebar memo
 * reacts to join/leave changes.
 *
 * Extracted from `components/Sidebar.tsx` so library code (settings-sync,
 * channel-org) can auto-join channels without importing a UI component.
 */

import { createSignal } from 'solid-js';
import { DEFAULT_CHANNEL_SLUG } from './channel-org';

const STORAGE_KEY = 'ogmara_joined_channels';

function loadJoinedFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch { /* ignore */ }
  return new Set();
}

/** Whether the joined-set has ever been initialized on this device. */
export function storageInitialized(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

const [joinedSignal, setJoinedSignal] = createSignal<Set<number>>(loadJoinedFromStorage());

/** Reactive accessor for the joined-channel id set. */
export { joinedSignal };

function persistJoined(ids: Set<number>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  setJoinedSignal(new Set(ids));
}

export function addJoinedChannel(channelId: number): void {
  const ids = new Set(joinedSignal());
  if (ids.has(channelId)) return;
  ids.add(channelId);
  persistJoined(ids);
}

/** Add several channel ids at once (one persist). No-op if all already present. */
export function addJoinedChannels(channelIds: number[]): void {
  const ids = new Set(joinedSignal());
  let changed = false;
  for (const id of channelIds) {
    if (!ids.has(id)) { ids.add(id); changed = true; }
  }
  if (changed) persistJoined(ids);
}

export function removeJoinedChannel(channelId: number): void {
  const ids = new Set(joinedSignal());
  ids.delete(channelId);
  persistJoined(ids);
}

/**
 * Sync the joined set with the API channel list.
 * - Private channels in the list → user IS a member (L2 node pre-filters) → auto-add
 * - First-time init (fresh device / cleared storage): seed ONLY the default
 *   channel + private channels — NOT the whole public catalogue.
 *
 * The joined-set is purely a client-side sidebar visibility filter — there is no
 * on-chain or server-side "joined" state for public channels. A brand-new account
 * should land on just the default `ogmara` channel and discover/join other public
 * channels explicitly, rather than having every public channel pre-populated. We
 * still persist on first init (even if only the default matched) so storage is
 * marked initialised and we don't reseed on the next load.
 */
export function syncJoinedWithApi(
  apiChannels: { channel_id: number; channel_type: number; slug: string }[],
): void {
  const current = new Set(joinedSignal());
  let changed = false;

  if (!storageInitialized() && apiChannels.length > 0) {
    // Brand-new account: do NOT auto-populate the sidebar with the entire public
    // catalogue. Seed only the default channel + any private channels the node
    // returned (private = membership-gated, so the user really is a member). The
    // user discovers and joins other public channels explicitly. We still persist
    // below (changed=true) so storage is marked initialised and we don't reseed.
    for (const ch of apiChannels) {
      if ((ch.slug === DEFAULT_CHANNEL_SLUG || ch.channel_type === 2) && !current.has(ch.channel_id)) {
        current.add(ch.channel_id);
      }
    }
    changed = true;
  } else {
    for (const ch of apiChannels) {
      if (ch.channel_type === 2 && !current.has(ch.channel_id)) {
        current.add(ch.channel_id);
        changed = true;
      }
    }
  }

  if (changed) persistJoined(current);
}
