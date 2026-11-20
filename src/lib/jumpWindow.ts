/**
 * Pure helpers for the chat "jump window" — the detached view a permalink
 * (`#/chat/<id>?msg=<hex>`) opens onto (spec 06 §6.5, plan §6.1).
 *
 * A jump issues ONE `getChannelMessages(id, { around, limit })`, then pages
 * `before` / `after` from the window's edges until it meets the live tail.
 * Kept free of Solid / DOM imports so it runs under `node --test`.
 */

import type { MessagesResponse } from '@ogmara/sdk';

/** Rows requested around the target (the node clamps `around` to 1..100). */
export const JUMP_WINDOW_LIMIT = 50;
/** Rows per `before` / `after` page while detached. */
export const JUMP_PAGE_LIMIT = 50;

/**
 * What an `around` response means for the jump:
 * - `found`: the window is centred on the target — render it detached.
 * - `not-on-node`: `target_found: false` — the node does not index this
 *   message in this channel ("This message isn't on your current node"). A
 *   `target_found: true` whose rows do not actually contain the target is
 *   treated the same way (never scroll to a row that is not there).
 * - `legacy`: `target_found` absent — a pre-0.150.0 node ignored `around`
 *   and served the newest page.
 */
export type AroundOutcome = 'found' | 'not-on-node' | 'legacy';

export function classifyAround(
  resp: Pick<MessagesResponse, 'target_found' | 'messages'>,
  targetHex: string,
  idOf: (m: unknown) => string,
): AroundOutcome {
  if (resp.target_found === undefined) return 'legacy';
  if (resp.target_found !== true) return 'not-on-node';
  const rows = Array.isArray(resp.messages) ? resp.messages : [];
  return rows.some((m) => idOf(m) === targetHex) ? 'found' : 'not-on-node';
}

/** Older history beyond the first row? Exact flag, else the legacy `has_more`. */
export function moreBefore(resp: Pick<MessagesResponse, 'has_more' | 'has_more_before'>): boolean {
  return resp.has_more_before ?? !!resp.has_more;
}

/**
 * Newer history beyond the last row? Exact flag when the node sends it; an
 * older node (no flag) is judged by whether the page came back full — a short
 * page means the tail was reached.
 */
export function moreAfter(
  resp: Pick<MessagesResponse, 'has_more_after'>,
  rowsReturned: number,
  limit: number,
): boolean {
  return resp.has_more_after ?? rowsReturned >= limit;
}

/** Result of merging a page into the window. */
export interface MergedWindow<T> {
  rows: T[];
  /** Rows were dropped from the OPPOSITE edge to stay within `max`. */
  trimmed: boolean;
}

/**
 * Merge a page into the window: `older` pages are prepended, `newer` pages
 * appended, rows already present (by id) are skipped. Over `max`, rows are
 * shed from the edge FARTHEST from the page the user just asked for, and
 * `trimmed` tells the caller to re-arm that direction's "has more" flag.
 */
export function mergeWindowPage<T>(
  window: readonly T[],
  page: readonly T[],
  direction: 'older' | 'newer',
  max: number,
  idOf: (m: T) => string,
): MergedWindow<T> {
  const seen = new Set(window.map(idOf));
  const fresh = page.filter((m) => {
    const id = idOf(m);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const rows = direction === 'older' ? [...fresh, ...window] : [...window, ...fresh];
  if (rows.length <= max) return { rows, trimmed: false };
  return {
    rows: direction === 'older' ? rows.slice(0, max) : rows.slice(rows.length - max),
    trimmed: true,
  };
}

/** Result of adding to the held-back live buffer. */
export interface BufferedLive<T> {
  rows: T[];
  /**
   * The oldest row(s) were shed to stay within `max`. Only ever the OLDEST
   * end, so the buffer stays a contiguous run up to the live tail — but the
   * caller must then refetch the newest page on re-attach rather than rely on
   * the buffer alone.
   */
  dropped: boolean;
}

/**
 * Append a live message that arrived while detached to the bounded buffer
 * (dedup by id, keep the newest `max`).
 */
export function bufferLive<T>(buffer: readonly T[], msg: T, max: number, idOf: (m: T) => string): BufferedLive<T> {
  const id = idOf(msg);
  if (!id || buffer.some((m) => idOf(m) === id)) return { rows: buffer as T[], dropped: false };
  const next = [...buffer, msg];
  return next.length > max ? { rows: next.slice(next.length - max), dropped: true } : { rows: next, dropped: false };
}

/**
 * The rows of the pre-jump view (`local`: live messages, unconfirmed sends,
 * older pages the user had loaded) that are NOT part of the jump window. They
 * are held back with the live buffer while detached and restored when the
 * view returns to the present — never discarded. No cap here: `local` is
 * already bounded by the view's own caps.
 */
export function holdBackRows<T>(local: readonly T[], window: readonly T[], idOf: (m: T) => string): T[] {
  const inWindow = new Set(window.map(idOf));
  return local.filter((m) => {
    const id = idOf(m);
    return !!id && !inWindow.has(id);
  });
}

/** HTTP status of an SDK request error (`API error (404): …`), else null. */
export function httpStatusOf(e: unknown): number | null {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const m = /^API error \((\d{3})\)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/**
 * Why a permalink's `around` request failed (plan §9):
 * - `channel-gone`: the channel record itself 404s — deleted / never existed.
 * - `no-access-joinable`: the record resolves and the channel is public —
 *   the viewer can join it.
 * - `no-access`: the record resolves (e.g. the restricted view of a private
 *   channel) but the viewer may not read it.
 * - `error`: anything else (network, 5xx, unexpected status) — generic copy.
 */
export type JumpFailure = 'channel-gone' | 'no-access-joinable' | 'no-access' | 'error';

/**
 * Classify a failed `around` request from its status and the outcome of a
 * follow-up channel-record lookup (`record`: `{ found: true, isPublic }`, or
 * `{ found: false, status }` with that lookup's own error status).
 */
export function classifyJumpFailure(
  aroundStatus: number | null,
  record: { found: true; isPublic: boolean } | { found: false; status: number | null },
): JumpFailure {
  if (aroundStatus !== 403 && aroundStatus !== 404) return 'error';
  if (record.found) return record.isPublic ? 'no-access-joinable' : 'no-access';
  return record.status === 404 ? 'channel-gone' : 'error';
}

/**
 * Identity a permalink jump is made for: wallet + whether auth is ready. Any
 * change — including the session being restored after first render (no
 * wallet → wallet, auth → ready) — must RE-ARM the jump rather than abort it:
 * the earlier request ran as a different (possibly anonymous) caller.
 */
export function jumpAccountKey(wallet: string | null | undefined, authReady: boolean): string {
  return `${wallet ?? ''}|${authReady ? 'ready' : 'pending'}`;
}
