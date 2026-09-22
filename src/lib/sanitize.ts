/**
 * Input sanitization & validation helpers for the renderer.
 *
 * The audit on v1.19.0 flagged a recurring pattern: values from
 * localStorage or remote HTTPS hosts reach formatters / JSX without
 * an explicit validator. This module centralizes the small set of
 * checks we need so future audits can grep for `stripBidi(`,
 * `clampJsonSize(`, `validateCurrency(` to confirm each untrusted
 * boundary is gated.
 *
 * Add new helpers here rather than re-implementing them per file.
 */

/**
 * Strip Unicode control codepoints and bidirectional override
 * characters from a string. Used wherever we render attacker-
 * influenceable text alongside critical info — particularly the
 * transaction-confirm summary, where a U+202E in a token id could
 * visually reverse the recipient address shown above the PIN
 * prompt and trick the user into authorizing the wrong destination.
 *
 * Stripped ranges:
 *  - U+0000..U+001F, U+007F..U+009F : control characters
 *  - U+200E, U+200F                 : LRM / RLM marks
 *  - U+202A..U+202E                 : explicit bidi formatting
 *  - U+2066..U+2069                 : isolate-format bidi
 *  - U+2028, U+2029                 : line / paragraph separators
 *                                     (break CSS line-height + some
 *                                     JSON/JS-source contexts)
 *  - U+FEFF                         : BOM / zero-width no-break space
 *                                     (invisible, useful for hiding
 *                                     prefixes/suffixes in filenames)
 */
const BIDI_AND_CONTROL_RE = new RegExp(
  '[' +
    '\\u0000-\\u001F\\u007F-\\u009F' +
    '\\u200E\\u200F' +
    '\\u202A-\\u202E' +
    '\\u2066-\\u2069' +
    '\\u2028\\u2029' +
    '\\uFEFF' +
  ']',
  'g',
);

export function stripBidi(s: string): string {
  if (!s) return '';
  return s.replace(BIDI_AND_CONTROL_RE, '');
}

/**
 * Every codepoint the node refuses in a self-declared, wallet-supplied
 * descriptor (protocol §3.11, reused verbatim for message button
 * `label`/`command`, protocol §3.3), mirrored from `@ogmara/sdk`'s
 * `FORBIDDEN_DESCRIPTOR_CHARS`.
 *
 * `stripBidi()` above is a STRICT SUBSET of this — it misses U+061C, U+200B,
 * U+2060-U+2064, U+FEFF, U+FFF9-U+FFFB and the U+E0000 tag block, which is
 * the primitive behind invisible-text smuggling. Since the whole point of
 * sanitizing here is defending against a node that never validated (any node
 * predating the field this string belongs to), a filter laxer than the
 * node's own defeats its own purpose.
 *
 * U+200C ZWNJ and U+200D ZWJ are deliberately NOT stripped — ZWJ is required
 * for emoji sequences and ZWNJ for Persian and Indic orthography, and
 * neither can reorder text.
 */
const FORBIDDEN_DESCRIPTOR_CHARS = new RegExp(
  '[' +
    '\\u0000-\\u001F\\u007F-\\u009F' +
    '\\u061C\\u200B\\u200E\\u200F' +
    '\\u2028\\u2029' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u2064' +
    '\\u2066-\\u2069' +
    '\\uFEFF\\uFFF9-\\uFFFB' +
  ']|[\\u{E0000}-\\u{E007F}]',
  'gu',
);

/** Render-time sanitizer for any self-declared, wallet-supplied string. */
export function safeText(s: string | null | undefined): string {
  return stripBidi(s ?? '').replace(FORBIDDEN_DESCRIPTOR_CHARS, '');
}

/** Default max body size for keyless public-API responses (2 MB). */
export const DEFAULT_MAX_JSON_BYTES = 2_000_000;

/**
 * Read a `Response` body as text with a hard size cap. Used by the
 * price fetchers so a hostile or proxy-tampered host can't return a
 * multi-GB stream and either OOM the renderer or blow our localStorage
 * quota (which would silently corrupt unrelated `ogmara.*` keys).
 *
 * Honours `Content-Length` when present (cheap path) and otherwise
 * streams via the reader, aborting if accumulated bytes exceed `max`.
 * Returns the body text on success; throws on overflow.
 */
export async function readResponseTextCapped(
  resp: Response,
  max: number = DEFAULT_MAX_JSON_BYTES,
): Promise<string> {
  const cl = resp.headers.get('content-length');
  if (cl) {
    const declared = parseInt(cl, 10);
    if (Number.isFinite(declared) && declared > max) {
      throw new Error(`response too large: ${declared} > ${max} bytes`);
    }
  }
  // No content-length, or it was within the cap — still defend against
  // a lying header by reading via the stream with a running total.
  if (!resp.body) return await resp.text();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`response exceeded ${max} bytes`);
    }
    chunks.push(value);
  }
  // TextDecoder over a single concatenated buffer — cheap for our sizes.
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * Parse JSON with a length-based prefilter. Convenience wrapper for
 * `readResponseTextCapped` + `JSON.parse` — keeps callers terse and
 * the size-cap rationale visible at every call site.
 */
export async function readResponseJsonCapped<T = unknown>(
  resp: Response,
  max: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const text = await readResponseTextCapped(resp, max);
  return JSON.parse(text) as T;
}

/** ISO-4217 codes the wallet currently formats fiat in. Keep in sync
 *  with `SUPPORTED_CURRENCIES` in `prices.ts` and the SettingsView
 *  `<select>` options. */
const ALLOWED_CURRENCIES = new Set(['usd', 'eur', 'brl', 'gbp', 'jpy', 'cny']);

/**
 * Whitelist-check a currency code coming from localStorage. Returns
 * the lower-cased code on match, or the provided fallback on miss.
 * Prevents an unvalidated code from reaching `Intl.NumberFormat`
 * (which throws on unknown codes — handled by callers' try/catch, but
 * exhausting that path on every render is wasteful).
 */
export function validateCurrency(value: unknown, fallback: string = 'usd'): string {
  if (typeof value !== 'string') return fallback;
  const lower = value.trim().toLowerCase();
  return ALLOWED_CURRENCIES.has(lower) ? lower : fallback;
}
