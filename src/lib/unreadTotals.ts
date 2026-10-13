/**
 * Unread totals limited to what the user can actually see.
 *
 * The node's `/channels/unread` returns a count for EVERY public channel the
 * account can read — capped per channel (≈99), including channels it has never
 * opened or joined. Summing that raw map put several hundred phantom unreads
 * on the tray badge and the collapsed Channels header for any account, and
 * nothing the user could click would ever clear them.
 *
 * This sums only the ids in `visibleIds` (the sidebar's rendered channel set).
 * It is a pure READ-side filter: the raw map stays untouched, and this view
 * must never be written back over it (a filtered view persisted over the
 * source drops counts for channels that merely weren't listed yet).
 */
export function sumVisibleUnread(
  map: Readonly<Record<string, number>> | null | undefined,
  ids: ReadonlySet<string>,
): number {
  if (!map) return 0;
  let total = 0;
  for (const id of ids) {
    const n = map[id];
    // Ignore anything that isn't a sane non-negative count rather than
    // letting one malformed entry poison the whole badge (NaN / negative).
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}
