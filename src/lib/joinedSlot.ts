/**
 * Pure merge for a stored joined-channels slot (a JSON array of channel ids),
 * used by `addJoinedChannelFor` to append to an account that is NOT active.
 * Returns the new serialized value, or `null` when nothing should be written.
 *
 * A MISSING slot (`null`) is left missing: the slot's mere existence is what
 * marks an account's joined set as initialised (`storageInitialized()`), and
 * the first live sync for an uninitialised account seeds the default channel
 * and its private channels. Writing `[id]` there would skip that seeding for
 * good. Kept import-free so it is testable under `node --test`.
 */
export function mergeJoinedSlot(raw: string | null, channelId: number): string | null {
  if (raw === null) return null;
  let ids: number[] = [];
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) ids = arr.filter((x): x is number => typeof x === 'number');
    } catch { /* corrupt slot: start fresh rather than throw */ }
  }
  if (ids.includes(channelId)) return null;
  ids.push(channelId);
  return JSON.stringify(ids);
}
