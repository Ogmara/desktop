/**
 * Own-avatar cache.
 *
 * The user's own avatar image is cached LOCALLY (as a data URL in
 * localStorage) so it renders on ANY node — even one we just switched to that
 * has no IPFS backend, or that hasn't synced this user's media yet. Profile
 * *details* (display name, etc.) propagate between nodes via gossip once the
 * user posts, but the avatar *image* lives in IPFS, which may not be active on
 * every node — so the owner caches their own image client-side.
 *
 * The cache is keyed by CID, so `avatarUrl(cid)` transparently serves the
 * cached copy wherever the OWN avatar's CID appears (burger menu, profile,
 * own posts) and falls through to the node for everyone else.
 */

import { createSignal } from 'solid-js';
import { getClient } from './api';

const STORAGE_KEY = 'ogmara.ownAvatar';
/** Don't cache images larger than this (localStorage is ~5 MB). Avatars are
 *  tiny; anything bigger is almost certainly not an avatar. */
const MAX_CACHE_BYTES = 1024 * 1024;

interface OwnAvatar {
  cid: string;
  dataUrl: string;
}

function load(): OwnAvatar | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OwnAvatar) : null;
  } catch {
    return null;
  }
}

const [ownAvatar, setOwnAvatarSignal] = createSignal<OwnAvatar | null>(load());
export { ownAvatar };

/** Persist + publish the cached own avatar. */
export function setOwnAvatar(cid: string, dataUrl: string): void {
  const v: OwnAvatar = { cid, dataUrl };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* quota — keep the in-memory copy at least */
  }
  setOwnAvatarSignal(v);
}

/** Drop the cached avatar (e.g. on wallet disconnect). */
export function clearOwnAvatar(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  setOwnAvatarSignal(null);
}

/**
 * Resolve an avatar image URL for a CID. If the CID matches the cached OWN
 * avatar, return the local data URL (renders on any node); otherwise fall
 * back to the current node's media endpoint. Reactive — re-runs when the
 * cache updates, so the UI swaps to the cached copy as soon as it's stored.
 */
export function avatarUrl(cid: string): string {
  const cached = ownAvatar();
  if (cached && cached.cid === cid) return cached.dataUrl;
  return getClient().getMediaUrl(cid);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * Fetch + cache the user's own avatar from the current node if THIS CID isn't
 * already cached. Best-effort: call after the own profile is known and while
 * connected to a node that has the image (e.g. right after login / profile
 * load). Once cached it survives node switches via localStorage, so the
 * avatar keeps showing on nodes that lack the image.
 */
export async function ensureOwnAvatarCached(cid: string | undefined | null): Promise<void> {
  if (!cid) return;
  if (ownAvatar()?.cid === cid) return; // already have this one
  try {
    const resp = await fetch(getClient().getMediaUrl(cid));
    if (!resp.ok) return;
    const blob = await resp.blob();
    if (blob.size > MAX_CACHE_BYTES) return;
    setOwnAvatar(cid, await blobToDataUrl(blob));
  } catch {
    /* node may not have it — keep whatever we already cached */
  }
}
