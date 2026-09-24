/**
 * Local cache for channel/DM message history — paints a resumed
 * conversation instantly instead of blanking and reloading from the
 * network every single time a channel/DM is (re-)opened.
 *
 * SECURITY-CRITICAL DESIGN CONSTRAINT (Phase 0 of the "message history
 * caching" plan, empirically confirmed live against darkw0rld 2026-09-24):
 * a delta fetch using `after=<msg_id>` NEVER resurfaces an edit, deletion,
 * or reaction change on a message that predates the cursor — it is simply
 * absent from the response, not stale, not updated, just missing. This is
 * a server architecture fact, not a client bug to route around: edits and
 * deletes are applied as a read-time projection over `CHANNEL_MSGS`/
 * `DM_MSGS` (l2-node routes.rs), and the only column families that record
 * them (`CHANNEL_EDIT_DELETE_MSGS`/`DM_EDIT_DELETE_MSGS`) have no REST
 * reader today.
 *
 * Therefore: `MAX_ROWS_PER_CONV` here MUST stay <= the smallest `limit`
 * either caller's real, unconditional fetch actually requests, so every row
 * this cache holds is revalidated by the very next such fetch. **This is
 * 50, not the node's 100 page-size clamp** — re-audit finding: the node
 * clamp is an upper bound on what CAN be requested, not what IS requested.
 * `ChatView.tsx`'s `INITIAL_PAGE` and `DmConversationView.tsx`'s
 * `DM_REQUESTED_LIMIT` are both 50 in the common case; capping the cache at
 * 100 left the OLDEST 50 of those rows never revalidated by a typical
 * open, silently defeating the whole safety property (an edit/delete in
 * that half re-rendered from cache indefinitely). If either caller's
 * requested limit ever changes, this constant must be re-derived as the
 * MINIMUM of every caller's real limit, not assumed. This cache is never
 * refreshed via `after` — that cursor stays exactly where it already was,
 * in the live/steady-state "what's new since I was last looking" poll — it
 * is only ever wholesale-replaced or merged against a full, unconditional
 * fetch via `mergeMessages`. Do not "optimize" this into an `after`-based
 * refresh without re-deriving why this comment exists.
 *
 * Storage shape: a message is stored as a PROJECTED row, never the raw
 * envelope — `signature`, `relay_path`, and any `_`-prefixed CLIENT-ONLY
 * annotation (e.g. an optimistic row's `_media` carrying a plaintext
 * per-file content key) are dropped; `payload` is base64-encoded (~3-4x
 * smaller than its `number[]` JSON form, and validated as actual byte data
 * before encoding — a malformed `payload` drops the row rather than
 * silently caching a zero-filled one). Every other field on the envelope
 * (whatever enrichment the node attaches — `reactions`, `deleted`,
 * `edited`, `channel_id`, `reply_to_preview`, `target_msg_id`, `emoji`,
 * ...) passes through opaquely, so a future node-side enrichment field is
 * cached automatically without a client change.
 *
 * Ciphertext, not plaintext, is cached for encrypted channels/DMs — the
 * `payload` stored here is exactly what the node returned, before any
 * client-side decryption. `localStorage` is origin-scoped and readable by
 * any XSS, a materially weaker boundary than mobile's app-private sandboxed
 * cache directory (see `mobile/src/lib/mediaDiskCache.ts`, which makes the
 * opposite, deliberate tradeoff for exactly that reason, and — unlike this
 * module before this revision — has a TTL). The instant-paint win still
 * holds without plaintext: authors, timestamps, ordering, reply structure,
 * reactions and message count all render immediately; only the decrypted
 * body text waits on the existing in-memory key cache, same as today's
 * placeholder-then-decrypt behavior.
 *
 * Byte bounds exist here for a concrete reason, not generic hygiene: a
 * message's `payload` is otherwise attacker-controlled up to the protocol's
 * 64 KiB chat-payload cap, and this module's own field-passthrough is
 * opaque — so a hostile channel member (no special access needed) could
 * otherwise post enough near-max-size messages to make every persist tick
 * blow the origin's storage quota, which previously triggered evicting the
 * VICTIM's OTHER, unrelated cached conversations on every failed write, in
 * a loop with no backoff. `MAX_ROW_PAYLOAD_BYTES` rejects an individual
 * oversized row; `MAX_CONV_SERIALIZED_BYTES` self-trims ONE conversation's
 * own oldest rows to fit its own budget (rather than evicting siblings);
 * `evictOldestHalf` is now rate-limited so a write that's failing for a
 * reason eviction can't fix (e.g. a browser with an unusually small quota)
 * can't cascade-destroy every other cached conversation.
 */

// Explicit `.ts` extension (matching `payload.ts`'s convention) so this
// module resolves correctly under plain `node --test`, not only through
// Vite's bundler (which accepts either form). Deliberately does NOT import
// `api.ts` for `getCurrentNodeUrl()` — that hub module pulls in the SDK
// client and a long transitive chain unrelated to this module's job (and
// unimportable under a plain `node --test` run without dragging half the
// app's import graph along). Callers pass `nodeUrl` in explicitly instead;
// see each exported function below.
import { scopedKey, registerWalletSwitchReset } from './walletScope.ts';

// Bumped 1 -> 2 when `cachedAt` (the TTL field) was added mid-development,
// before this feature ever shipped — so there are zero real v1 blobs to
// migrate; this just closes the gap where a hypothetical pre-`cachedAt`
// blob would read as "expired" forever without ever being cleaned up by
// the version-mismatch path (which only fires on an ACTUAL `v` mismatch).
const CACHE_VERSION = 2;
const PREFIX = 'ogmara.msgCache';

/**
 * MUST stay <= the smallest `limit` either caller's real unconditional
 * fetch requests (currently 50 for both). See the module doc comment —
 * this is a security control (bounding how long a redacted/deleted/edited
 * message can render from a stale local copy), not merely a size control.
 */
export const MAX_ROWS_PER_CONV = 50;

/** Cross-conversation LRU cap, to bound total storage across many channels/DMs. */
const MAX_CACHED_CONVERSATIONS = 30;

/** Matches the protocol's `MAX_CHAT_PAYLOAD_BYTES` (docs/specs/01-protocol.md §3). A row whose payload exceeds this is dropped rather than cached truncated/wrong. */
const MAX_ROW_PAYLOAD_BYTES = 65536;

/** Self-trim budget for one conversation's serialized cache blob — bounds the worst case (50 rows x a near-max payload each) without relying on cross-conversation eviction to absorb it. */
const MAX_CONV_SERIALIZED_BYTES = 512 * 1024;

/** How long a cached conversation is trusted before being treated as cold. Mirrors `mobile/src/lib/mediaDiskCache.ts`'s 7-day precedent — this module previously had no TTL at all, so a revoked/removed conversation (left a channel, node lost the data, access revoked) kept painting from a local copy forever. */
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum interval between eviction-of-OTHER-conversations attempts, regardless of how many distinct writes fail in that window — otherwise a write that eviction can never fix (e.g. a single conversation still too large for an unusually small quota) repeatedly destroys every other cached conversation for no benefit. */
const MIN_EVICTION_INTERVAL_MS = 10000;
let lastEvictionAttemptAt = 0;

/** Cheap sanity bound on a conversation id used as a storage-key component — not full address validation (that's the node's job), just enough to stop a pathological/huge route param from becoming a huge key or a pointless LRU entry. */
const MAX_ID_LEN = 200;

const INDEX_BASE = `${PREFIX}.index`;

export type ConvKind = 'ch' | 'dm';

/** A cached row: the envelope's fields, minus `signature`/`relay_path`/`_`-prefixed client-only fields, `payload` base64-encoded. */
export interface CachedRow {
  msg_id: string;
  timestamp: number;
  payload: string;
  [key: string]: unknown;
}

interface CachedConv {
  v: number;
  /** `Date.now()` at write time — see `MAX_CACHE_AGE_MS`. */
  cachedAt: number;
  rows: CachedRow[];
}

function base(kind: ConvKind, id: string | number, nodeUrl: string): string {
  return `${PREFIX}.${nodeUrl || ''}.${kind}.${id}`;
}

/** `false` for an id too large to be a plausible channel id / wallet address — see `MAX_ID_LEN`. */
function idLooksPlausible(id: string | number): boolean {
  return String(id).length <= MAX_ID_LEN;
}

function bytesToBase64(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  try {
    return btoa(bin);
  } catch {
    return '';
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch {
    return new Uint8Array(0);
  }
}

const HEX = '0123456789abcdef';
function bytesToHex(bytes: number[] | Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    const n = typeof b === 'number' && b >= 0 && b <= 255 ? b : 0;
    out += HEX[(n >> 4) & 0xf] + HEX[n & 0xf];
  }
  return out;
}

/**
 * Normalizes a `msg_id` to its hex-string form, matching the app's own
 * `msgIdToHex` helpers (`ChatView.tsx`, `DmConversationView.tsx`) — a
 * `msg_id` can arrive as a hex string, a `number[]`, or a `Uint8Array`
 * depending on the source (REST response vs. a WS-delivered envelope vs. a
 * locally-built one), and this module must recognize all three or it
 * silently drops rows a live view already renders correctly.
 */
function msgIdOf(m: unknown): string | null {
  const id = (m as { msg_id?: unknown } | null)?.msg_id;
  if (typeof id === 'string') return id.length > 0 ? id : null;
  if (Array.isArray(id) || id instanceof Uint8Array) {
    const hex = bytesToHex(id as number[] | Uint8Array);
    return hex.length > 0 ? hex : null;
  }
  return null;
}

/** An optimistic/local-only row must never be persisted — it has no server identity. */
function isOptimistic(m: any): boolean {
  return !!m?._optimistic || (typeof m?.msg_id === 'string' && m.msg_id.startsWith('local-'));
}

function toCacheRow(m: any): CachedRow | null {
  const id = msgIdOf(m);
  if (!id || isOptimistic(m)) return null;
  const { signature: _sig, relay_path: _rp, payload, ...rest } = m;
  // Drop every client-only `_`-prefixed field, not just the ones known
  // today (`_optimistic`, `_media`) — an optimistic row's `_media` carries
  // a plaintext per-file content key, and relying on "only optimistic rows
  // ever carry it" (already filtered above) is a coincidence, not a
  // guarantee, the next time this shape is touched.
  const cleaned: Record<string, unknown> = {};
  for (const k of Object.keys(rest)) {
    if (!k.startsWith('_')) cleaned[k] = rest[k];
  }
  // `payload` must actually be byte data — an optimistic-edit fallback
  // path can set it to a plain string, and `bytesToBase64` would silently
  // encode that as garbage (NaN -> 0 for every "byte"), caching a
  // zero-filled payload under a REAL msg_id rather than dropping it.
  let encodedPayload = '';
  if (Array.isArray(payload) || payload instanceof Uint8Array) {
    if (payload.length > MAX_ROW_PAYLOAD_BYTES) return null; // oversized — drop rather than cache truncated
    encodedPayload = bytesToBase64(payload);
  } else if (payload != null) {
    return null; // malformed payload shape — don't cache a row we can't round-trip
  }
  return {
    ...cleaned,
    msg_id: id,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
    payload: encodedPayload,
  };
}

/**
 * Rehydrate a cached row back to the shape the rest of the app expects —
 * `payload` as `Uint8Array`, accepted everywhere `number[]` is (see
 * `payload.ts`'s `decodePayload`). `null` for a malformed row (e.g. a
 * hand-edited or corrupted blob with a `null`/non-object entry in `rows`)
 * rather than throwing — `readConvFromDisk` only validates that `rows` IS
 * an array, not the shape of each element, and this is called from inside
 * a `createResource` fetcher's synchronous channel-switch branch, BEFORE
 * that fetcher's own `try`; an uncaught throw here previously put the
 * whole resource into an error state, breaking the entire view for the
 * session (re-audit finding) — reachable by anyone who can write
 * `localStorage` for this origin (XSS, devtools, a malicious extension),
 * which this module's own header comment already names as in-scope.
 */
function fromCacheRow(row: CachedRow): any {
  if (!row || typeof row !== 'object') return null;
  const { payload, ...rest } = row;
  return { ...rest, payload: payload ? base64ToUint8Array(payload) : new Uint8Array(0) };
}

// In-memory warm layer, mirrors what is on disk for the conversations this
// tab has actually opened. Dropped synchronously on wallet switch — a
// deferred reset would leave a window where a different account's cached
// rows could still be read (same reasoning as `walletScope.ts`'s own
// switch-reset, which this mirrors).
let warm = new Map<string, CachedConv>();
registerWalletSwitchReset(() => { warm = new Map(); });

function readConvFromDisk(b: string): CachedConv | null {
  const key = scopedKey(b);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Corrupt, hand-edited, or schema-drifted — treat as a cold cache
    // rather than risk rendering a malformed row. Every read path below is
    // wrapped the same way, per the established idiom in this codebase
    // (`Sidebar.tsx`'s `getCachedDmConvs`, `walletScope.ts`).
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CACHE_VERSION || !Array.isArray(parsed.rows)) {
      // A version mismatch (as opposed to garbage JSON) is a KNOWN blob
      // this module wrote itself in a previous format — remove it rather
      // than leaving a permanently-unreadable, permanently-untracked-by-
      // the-LRU entry stranded in storage after a future CACHE_VERSION
      // bump.
      if (parsed && typeof parsed === 'object' && typeof parsed.v === 'number' && parsed.v !== CACHE_VERSION) {
        try { localStorage.removeItem(key); } catch { /* best-effort */ }
      }
      return null;
    }
    const conv = parsed as CachedConv;
    if (typeof conv.cachedAt !== 'number' || Date.now() - conv.cachedAt > MAX_CACHE_AGE_MS) {
      return null; // expired — treat as cold rather than paint stale-beyond-trust content
    }
    return conv;
  } catch {
    return null;
  }
}

/** Serialize + byte-budget a conversation, trimming its OWN oldest rows (never another conversation's) until it fits `MAX_CONV_SERIALIZED_BYTES`. */
/**
 * Trim `conv.rows` (from the oldest end) so the conversation fits
 * `MAX_CONV_SERIALIZED_BYTES`, computing each row's serialized size ONCE
 * rather than re-stringifying the whole object on every trim step.
 *
 * Round-2 re-audit finding: the original version re-ran `JSON.stringify`
 * on the WHOLE (shrinking-by-one-row) object in a loop — O(n²) — measured
 * at ~94ms of blocking main-thread work per persist tick for a 50-row
 * conversation of near-max-size (64 KiB) payloads, repeatable up to once
 * per second while a hostile channel member floods large messages. This
 * version stringifies each row once, then keeps the longest NEWEST suffix
 * whose cumulative size fits the budget — O(n) — and stringifies the
 * whole (already-right-sized) object exactly once at the end, in
 * `writeConvToDisk`.
 */
function trimToByteBudget(conv: CachedConv): CachedConv {
  if (conv.rows.length === 0) return conv;
  const rowSizes = conv.rows.map((r) => JSON.stringify(r).length);
  // Approximate — used only to DECIDE how many rows to keep; the actual
  // final byte count is whatever `JSON.stringify` produces once, in
  // `writeConvToDisk`, which is the authoritative size.
  const envelopeOverhead = JSON.stringify({ ...conv, rows: [] }).length;
  let total = envelopeOverhead;
  let keepFrom = conv.rows.length;
  for (let i = conv.rows.length - 1; i >= 0; i--) {
    total += rowSizes[i] + 1; // +1 for the array-element separator
    if (total > MAX_CONV_SERIALIZED_BYTES) break;
    keepFrom = i;
  }
  return keepFrom > 0 ? { ...conv, rows: conv.rows.slice(keepFrom) } : conv;
}

/**
 * Returns the ACTUALLY-persisted (post-trim) `CachedConv` on success, so
 * the caller can keep the in-memory `warm` layer consistent with what's on
 * disk — previously `warm` held the pre-trim conv while disk held the
 * trimmed one, so the same tab could read more rows back than were ever
 * actually persisted (re-audit finding).
 */
function writeConvToDisk(b: string, conv: CachedConv): CachedConv | null {
  const key = scopedKey(b);
  if (!key) return null;
  const trimmed = trimToByteBudget(conv);
  try {
    localStorage.setItem(key, JSON.stringify(trimmed));
    return trimmed;
  } catch {
    return null;
  }
}

function readIndex(): Record<string, number> {
  const key = scopedKey(INDEX_BASE);
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeIndex(idx: Record<string, number>): void {
  const key = scopedKey(INDEX_BASE);
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(idx)); } catch { /* best-effort */ }
}

/** Evict the oldest half of cached conversations (by last-touched time). Used both for the cross-conversation LRU cap and as a quota-exceeded recovery step. */
function evictOldestHalf(idx: Record<string, number>): Record<string, number> {
  const keys = Object.keys(idx).sort((a, b) => idx[a] - idx[b]);
  const evictCount = Math.max(1, Math.floor(keys.length / 2));
  const toEvict = keys.slice(0, evictCount);
  const next = { ...idx };
  for (const b of toEvict) {
    delete next[b];
    const key = scopedKey(b);
    if (key) { try { localStorage.removeItem(key); } catch { /* best-effort */ } }
    warm.delete(b);
  }
  return next;
}

/** Record a conversation as just-touched, LRU-evicting beyond `MAX_CACHED_CONVERSATIONS`. */
function touch(b: string): void {
  let idx = readIndex();
  idx[b] = Date.now();
  const keys = Object.keys(idx);
  if (keys.length > MAX_CACHED_CONVERSATIONS) {
    keys.sort((x, y) => idx[x] - idx[y]);
    const toEvict = keys.slice(0, keys.length - MAX_CACHED_CONVERSATIONS);
    idx = { ...idx };
    for (const k of toEvict) {
      delete idx[k];
      const key = scopedKey(k);
      if (key) { try { localStorage.removeItem(key); } catch { /* best-effort */ } }
      warm.delete(k);
    }
  }
  writeIndex(idx);
}

/**
 * Read a conversation's cached messages, oldest first. Empty array on a
 * cold/corrupt/expired/absent cache — callers never need to special-case
 * "no cache". `nodeUrl` should be the currently-connected node (e.g.
 * `getCurrentNodeUrl()`) — scoping by node too, not just wallet, mirrors
 * `Sidebar.tsx`'s existing conversation-list cache and keeps a node switch
 * from serving one node's history under another's.
 *
 * Called synchronously from inside a `createResource` fetcher's
 * channel/peer-switch branch, BEFORE that fetcher's own `try` — the whole
 * body is therefore wrapped in a try/catch here too (on top of
 * `fromCacheRow`'s own per-row defensiveness), so ANY unexpected failure
 * degrades to "treat as cold cache" rather than putting the caller's
 * resource into a session-wide error state.
 */
export function readCachedMessages(kind: ConvKind, id: string | number | null | undefined, nodeUrl: string): any[] {
  try {
    if (id === null || id === undefined || id === '' || !idLooksPlausible(id)) return [];
    const b = base(kind, id, nodeUrl);
    // No active wallet — there is no per-wallet data to read, by the same
    // rule `walletScope.ts`'s own `scopedGet` enforces. Checked here too
    // (not just relied on implicitly via `scopedKey` returning `null`
    // inside `readConvFromDisk`), because `warm` is consulted FIRST and is
    // keyed by the base string alone, with no wallet awareness of its
    // own — see the matching guard in `writeCachedMessages` for the write
    // side of this (re-audit finding: without it, a debounced write
    // in flight when the wallet scope resets could repopulate `warm`
    // moments after `registerWalletSwitchReset` cleared it).
    if (scopedKey(b) === null) return [];
    let conv = warm.get(b);
    if (!conv) {
      const fromDisk = readConvFromDisk(b);
      if (fromDisk) { conv = fromDisk; warm.set(b, conv); }
    }
    if (!conv) return [];
    return conv.rows.map(fromCacheRow).filter((r) => r !== null);
  } catch {
    return [];
  }
}

/**
 * Persist `messages` (any shape — optimistic/local rows, duplicates, and
 * oversized/malformed payloads are filtered and deduped) as this
 * conversation's cache, capped at `MAX_ROWS_PER_CONV`, keeping the newest
 * rows. Safe to call often; callers should still debounce on a hot path
 * (e.g. every WS message) rather than calling this synchronously per event.
 *
 * Callers MUST have already filtered `messages` down to rows that actually
 * belong to `(kind, id)` — this function does not know a channel/DM's
 * identity and cannot detect a stale, previous-conversation's messages
 * being passed in during a fast switch (see the two call sites in
 * `ChatView.tsx`/`DmConversationView.tsx` for how that's guarded).
 */
export function writeCachedMessages(kind: ConvKind, id: string | number | null | undefined, messages: any[], nodeUrl: string): void {
  if (id === null || id === undefined || id === '' || !idLooksPlausible(id)) return;
  const b = base(kind, id, nodeUrl);
  // No active wallet — same reasoning as `readCachedMessages`'s identical
  // guard. Without this, a debounced write already in flight when
  // `setWalletScope(null)` fires (e.g. mid-disconnect) would repopulate
  // `warm` for this key moments after the wallet-switch reset cleared it
  // — `writeConvToDisk` itself already no-ops via `scopedKey` returning
  // `null`, but `warm.set` below does not go through `scopedKey` at all,
  // so it was never actually gated on there being an active wallet.
  if (scopedKey(b) === null) return;
  // Dedupe + sort + cap the RAW messages FIRST, and only project the
  // surviving <= MAX_ROWS_PER_CONV rows through `toCacheRow` — base64-
  // encoding a payload is the expensive part. Round-4 re-audit finding:
  // projecting the WHOLE snapshot before capping meant a scroll-heavy
  // session (`ChatView.tsx`'s `localMessages` can hold up to 1000 rows)
  // or a hostile channel flood paid the encoding cost for up to ~1000
  // rows just to keep the newest 50 — measured at up to ~530ms of
  // blocking work, landing on `onCleanup`/`visibilitychange` flushes
  // (every channel switch, every tab hide). Same shape as the O(n²)
  // `trimToByteBudget` bug fixed a round earlier, reintroduced one layer
  // up. A handful of the capped 50 may still get dropped by `toCacheRow`
  // itself (oversized/malformed payload) without being backfilled from
  // further back in history — accepted: that path requires a malicious
  // or buggy node in the first place, and a slightly-under-50 cache is a
  // trivial cost next to the alternative.
  // Assumes `messages` is already deduped by msg_id (true of both real
  // call sites — `ChatView.tsx`'s `allMessages` and `DmConversationView.
  // tsx`'s `allMessages` both dedupe before this is ever called) — round-5
  // re-audit note: if two entries shared an id and the LATER one were
  // rejected by `toCacheRow` (oversized/malformed payload), this raw-level
  // dedup would drop the id entirely rather than falling back to an
  // earlier good copy, a narrow behavioral divergence from before this
  // function's raw/projected split. Not reachable today given the above;
  // recorded so a future caller that passes undeduped input knows this
  // isn't handled here.
  const byId = new Map<string, any>();
  for (const m of messages) {
    if (isOptimistic(m)) continue;
    const mid = msgIdOf(m);
    if (mid) byId.set(mid, m);
  }
  // `typeof === 'number'` check matches `toCacheRow`'s own timestamp
  // normalization (round-5 re-audit finding: the two had drifted — this
  // used `?? 0`, which only guards `null`/`undefined` and would sort a
  // non-numeric timestamp by its coerced value here vs. by `0` inside
  // `toCacheRow`, letting a bogus timestamp from a malicious/buggy node
  // displace a legitimate row from the 50-row cap).
  const tsOf = (m: any): number => typeof m?.timestamp === 'number' ? m.timestamp : 0;
  const rawRows = Array.from(byId.values()).sort((x, y) => tsOf(x) - tsOf(y));
  const cappedRaw = rawRows.length > MAX_ROWS_PER_CONV ? rawRows.slice(-MAX_ROWS_PER_CONV) : rawRows;
  const rows: CachedRow[] = [];
  for (const m of cappedRaw) {
    const row = toCacheRow(m);
    if (row) rows.push(row);
  }
  const conv: CachedConv = { v: CACHE_VERSION, cachedAt: Date.now(), rows };
  // `warm` is set to whatever ACTUALLY got persisted (the trimmed version
  // `writeConvToDisk` returns) whenever the write succeeds, not the
  // pre-trim `conv` — keeps the in-memory layer consistent with disk on
  // the success path (re-audit finding: they could previously disagree
  // there, since disk was trimmed and warm wasn't). On total failure
  // (`persisted` still null after the eviction-and-retry below), `warm`
  // deliberately falls back to the fuller pre-trim `conv` rather than
  // nothing — reviewed and judged fine (round-3 re-audit): the rows are
  // still capped to `MAX_ROWS_PER_CONV` and are the same ones already on
  // screen, so the cache's core revalidation invariant (cap <= the
  // smallest real fetch window) is untouched; this tab's in-memory view
  // is just allowed to stay ahead of a disk write that never landed.
  let persisted = writeConvToDisk(b, conv);
  if (!persisted) {
    // Quota exceeded (or similar) even after this conversation's own
    // byte-budget self-trim — evict the oldest half of OTHER conversations
    // and retry once, then give up silently. Rate-limited: if eviction
    // can't actually fix the failure (e.g. an unusually small quota, or a
    // pathological single write), retrying it on every debounced write
    // would otherwise repeatedly destroy every OTHER cached conversation
    // for no benefit. A message cache is a paint optimization; losing one
    // write is never worth surfacing an error to the user.
    const now = Date.now();
    if (now - lastEvictionAttemptAt >= MIN_EVICTION_INTERVAL_MS) {
      lastEvictionAttemptAt = now;
      const idx = readIndex();
      writeIndex(evictOldestHalf(idx));
      persisted = writeConvToDisk(b, conv);
    }
  }
  warm.set(b, persisted ?? conv);
  // Hard, unconditional bound on `warm` itself (round-5 re-audit finding),
  // on top of `touch()` below. `touch()`/`evictOldestHalf` are the NORMAL
  // eviction path, but both depend on the LRU index itself being
  // writable — if `localStorage` is entirely unwritable for this origin
  // (private-mode "block all site data", a near-zero quota, or quota
  // already exhausted by non-cache data), `writeIndex` silently fails
  // every time too, the index is never recorded, and `warm` grows without
  // bound regardless of `touch()` being called. Measured: 200/200
  // conversations retained with `localStorage` fully unwritable, before
  // this line existed. Oldest-first (Map iteration is insertion order;
  // re-`set` of an existing key does not refresh its position, so this is
  // insertion-order rather than true recency-LRU) — a coarser bound than
  // the index-based one, but a HARD one that doesn't depend on disk
  // writes succeeding at all.
  while (warm.size > MAX_CACHED_CONVERSATIONS) {
    const oldest = warm.keys().next().value;
    if (oldest === undefined) break;
    warm.delete(oldest);
  }
  // ALWAYS touch — round-4 re-audit finding: the round-3 version of this
  // only called `touch()` when `persisted` was truthy, reasoning that a
  // failed write shouldn't cost an LRU slot. But `warm.set` above runs
  // unconditionally (by design — the pre-trim `conv` stays available for
  // THIS tab session even when nothing reached disk), and `warm` is only
  // ever pruned by walking the LRU INDEX (`touch`/`evictOldestHalf`) — an
  // entry that's in `warm` but never in the index can never be evicted by
  // anything. On sustained quota exhaustion (the exact hostile-flood
  // scenario this module is hardened against) that stranded a full
  // pre-trim conversation (up to ~4.4 MB of base64) in memory per failed
  // write, permanently, defeating the whole point of the 30-conversation
  // bound. Touching regardless of outcome costs at most one real LRU
  // slot for a conversation already sitting in `warm` either way — a
  // trivial price next to an unbounded-heap-growth path.
  touch(b);
}

/**
 * `true` when `e` is the SDK's `Error(\`API error (${status}): ${text}\`)`
 * for a 403 or 404 — i.e. access was actually revoked (removed from a
 * private channel, channel/DM deleted), not a transient network failure.
 * Callers use this to decide whether to ALSO clear the cache on a failed
 * fetch (revoked) versus leave it alone (a blip the cache should survive).
 *
 * Anchored to the START of the message (re-audit finding): the SDK
 * includes up to 200 chars of the server's response BODY after the status
 * code, and an unanchored match could false-positive on a response whose
 * body text happens to mention a string shaped like "API error (404)"
 * (e.g. relaying an upstream error) despite the ACTUAL status being
 * something else entirely, like a 500. The status code is always the
 * first thing in the message, so anchoring costs nothing and removes the
 * false-positive surface. (A real, but low-impact and not this module's
 * to fix, residual case: the node can itself return a genuine 404 for a
 * private channel it simply hasn't federated/backfilled yet — cache-only
 * impact, degrades to the same outcome as any other cache miss.)
 */
export function isAccessRevokedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /^API error \((403|404)\)/.test(msg);
}

/** Remove one conversation's cache immediately — e.g. "Delete/hide conversation", "Leave channel", or a fetch that came back 403/404 (access revoked, so the cache must not keep painting content from before that). */
export function clearCachedMessages(kind: ConvKind, id: string | number, nodeUrl: string): void {
  const b = base(kind, id, nodeUrl);
  warm.delete(b);
  const key = scopedKey(b);
  if (key) { try { localStorage.removeItem(key); } catch { /* best-effort */ } }
  const idx = readIndex();
  if (b in idx) { delete idx[b]; writeIndex(idx); }
}

/**
 * Reconcile a cached snapshot against a FRESH, unconditional (non-`after`)
 * page fetch. `requestedLimit` is the `limit` that fetch was made with —
 * used to tell "the server returned a full page with zero overlap" (the
 * cache is older than everything the server just sent, and none of the
 * unvalidated cached rows can be trusted — DISCARD them) apart from "the
 * server returned a short/empty page with zero overlap" (there simply
 * isn't more history yet; keep the cache as-is by falling into the merge
 * branch, where empty `fresh` is a no-op union).
 *
 * On any id present in both: `fresh` wins WHOLESALE, never a field-level
 * merge — a field merge could resurrect a cached `payload` for a message
 * the server now returns with `deleted: true`.
 *
 * Callers MUST ensure `fresh` actually belongs to the SAME conversation
 * `cached` is for — Solid's `createResource` (and equivalents) retain the
 * PREVIOUS conversation's value while a new fetch is in flight, so reading
 * a resource accessor during that window and merging it here would mix
 * one conversation's messages into another's cache (re-audit finding; see
 * the `messages.loading` guards at both call sites).
 */
export function mergeMessages(cached: any[], fresh: any[], requestedLimit: number): any[] {
  const freshIds = new Set<string>();
  for (const m of fresh) { const id = msgIdOf(m); if (id) freshIds.add(id); }
  // Empty `fresh` trivially has no overlap and `fresh.length >= requestedLimit`
  // is always false, so it falls through to the union branch below
  // (union with an empty set is a no-op) — the cache is correctly left
  // alone rather than discarded when there's simply nothing new.
  let overlap = false;
  for (const m of cached) {
    const id = msgIdOf(m);
    if (id && freshIds.has(id)) { overlap = true; break; }
  }

  let result: any[];
  if (!overlap && fresh.length >= requestedLimit) {
    // Copy rather than alias `fresh` — this is very likely the SAME array
    // object backing a `createResource`'s `value()`; sorting it in place
    // below would silently mutate that resource's held value out from
    // under Solid's reactivity.
    result = [...fresh];
  } else {
    const byId = new Map<string, any>();
    for (const m of cached) { const id = msgIdOf(m); if (id) byId.set(id, m); }
    for (const m of fresh) { const id = msgIdOf(m); if (id) byId.set(id, m); }
    result = Array.from(byId.values());
  }
  result.sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));
  return result.length > MAX_ROWS_PER_CONV ? result.slice(-MAX_ROWS_PER_CONV) : result;
}
