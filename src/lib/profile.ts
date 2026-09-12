/**
 * Shared profile resolution with caching and in-flight deduplication.
 *
 * Used by NewsView, NewsDetailView, BookmarksView, and any component
 * that needs to resolve a Klever address to a display name + avatar.
 */

import { getClient } from './api';

export interface CachedProfile {
  display_name?: string;
  avatar_cid?: string;
  verified?: boolean;
  /**
   * The wallet self-declared itself automated (protocol §3.11).
   *
   * Orthogonal to `verified` and never merged with it in a UI: `verified` is
   * paid and on-chain, `is_bot` is free and self-declared. Shown for every bot,
   * verified or not.
   */
  is_bot?: boolean;
}

interface CacheEntry {
  profile: CachedProfile;
  timestamp: number;
}

/** Cache TTL: 5 minutes for populated profiles, 30 seconds for empty (not-found). */
const TTL_POPULATED = 5 * 60 * 1000;
const TTL_EMPTY = 30 * 1000;

const profileCache = new Map<string, CacheEntry>();
const profileInflight = new Map<string, Promise<CachedProfile>>();

/** Invalidate cached profile for an address (e.g., after on-chain registration). */
export function invalidateProfile(address: string): void {
  profileCache.delete(address);
}

function isCacheValid(entry: CacheEntry): boolean {
  const ttl = entry.profile.display_name ? TTL_POPULATED : TTL_EMPTY;
  return Date.now() - entry.timestamp < ttl;
}

/**
 * Resolve a Klever address to a cached profile. Deduplicates in-flight
 * requests so multiple components requesting the same address only
 * trigger one API call. Cached entries expire after TTL.
 */
export async function resolveProfile(address: string): Promise<CachedProfile> {
  const cached = profileCache.get(address);
  if (cached && isCacheValid(cached)) return cached.profile;
  if (profileInflight.has(address)) return profileInflight.get(address)!;
  const promise = (async () => {
    try {
      const client = getClient();
      const resp = await client.getUserProfile(address);
      const pk = resp.user?.public_key;
      const profile: CachedProfile = {
        display_name: resp.user?.display_name,
        avatar_cid: resp.user?.avatar_cid,
        verified: !!(pk && pk.length > 0),
        // `GET /users/{address}` is a JSON passthrough of the node's user
        // record, so this arrives without any node-side handler change
        // (l2-node 0.127.0+). Absent on older nodes, which reads as false.
        is_bot: !!(resp.user as { is_bot?: boolean } | undefined)?.is_bot,
      };
      profileCache.set(address, { profile, timestamp: Date.now() });
      return profile;
    } catch {
      const empty: CachedProfile = {};
      profileCache.set(address, { profile: empty, timestamp: Date.now() });
      return empty;
    } finally {
      profileInflight.delete(address);
    }
  })();
  profileInflight.set(address, promise);
  return promise;
}
