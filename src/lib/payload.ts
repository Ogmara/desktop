/**
 * MessagePack payload decoder — extracts human-readable content from
 * raw envelope payload bytes returned by the L2 node API.
 *
 * The API returns messages with `payload` as a byte array (MessagePack-encoded).
 * This module decodes it to extract the content string and other fields.
 */

import { decode, encode } from '@msgpack/msgpack';
import { stripBidi, safeText } from './sanitize.ts';

/**
 * Protocol §3.3 button caps, mirrored from `l2-node/src/messages/
 * validation.rs`. The node enforces these at SEND time and rejects the
 * whole envelope on violation — but a node older than 0.131 (the entire
 * fleet, as of when this field shipped) never validated `buttons` at all,
 * and happily stores/relays whatever a client sent. Re-enforcing the caps
 * here at DECODE time is what stops a message from a pre-0.131 node (or a
 * buggy/hostile one) from rendering an unbounded number of buttons.
 */
const MAX_BUTTON_ROWS = 10;
const MAX_BUTTONS_PER_ROW = 8;
const MAX_BUTTONS_TOTAL = 40;
const MAX_BUTTON_LABEL = 24;
const MAX_BUTTON_COMMAND = 256;

/**
 * Caps for the msgpack decoder when reading untrusted payloads.
 *
 * `@msgpack/msgpack` defaults every `max*` option to UINT32_MAX (4 GB).
 * A malicious or corrupted payload that declares a 32-bit length prefix
 * can force the decoder to allocate gigabytes of heap before any of our
 * application-level checks run. The caps below match the L2 node's
 * payload limits (`MAX_NEWS_CONTENT = 65536`, `MAX_ATTACHMENTS = 20`,
 * `MAX_MENTIONS = 50`) with comfortable headroom — anything larger
 * could not have been produced by a valid Ogmara server in the first
 * place.
 */
const SAFE_DECODE_OPTIONS = {
  maxStrLength: 1 << 20,    // 1 MB string — well above MAX_NEWS_CONTENT
  maxBinLength: 1 << 16,    // 64 KB binary (msg_id is 32 B, sig 64 B)
  maxArrayLength: 256,      // attachments + mentions caps × headroom
  maxMapLength: 64,         // payload fields count
  maxExtLength: 1 << 16,
};

function safeDecode(bytes: Uint8Array): unknown {
  return decode(bytes, SAFE_DECODE_OPTIONS);
}

/** Media attachment decoded from the payload. */
export interface PayloadAttachment {
  cid: string;
  mime_type: string;
  size_bytes: number;
  filename?: string;
  thumbnail_cid?: string;
}

/**
 * Display-safe filename for an attachment. Strips Unicode bidi /
 * control codepoints so a hostile uploader can't visually reverse
 * the displayed name (or trick the browser via the `download=`
 * attribute). Falls back to a short CID slice when filename is
 * absent. Pass the result wherever the filename reaches JSX text
 * or the `download` attribute.
 */
export function safeAttachmentName(att: { filename?: string; cid: string }, fallbackLen = 12): string {
  const raw = att.filename || '';
  const cleaned = stripBidi(raw);
  if (cleaned) return cleaned;
  return att.cid.slice(0, fallbackLen);
}

/** One interactive button attached to a message (protocol §3.3). */
export interface PayloadButton {
  label: string;
  command: string;
}

/** A row of buttons rendered together under a message. */
export interface PayloadButtonRow {
  buttons: PayloadButton[];
}

/** Decoded payload with common fields across message types. */
export interface DecodedPayload {
  content: string;
  title?: string;
  channel_id?: number;
  reply_to?: number[] | null;
  mentions?: string[];
  tags?: string[];
  media_cid?: string | null;
  content_rating?: string | number;
  attachments?: PayloadAttachment[];
  /** <= 10 rows. Protocol §3.3 — any wallet's message may carry these. */
  buttons?: PayloadButtonRow[];
  /**
   * Set when this message IS a button press (protocol §3.3). Client-
   * rendering hint ONLY, never a security boundary — the node never
   * special-cases it. A compliant feed suppresses a `true` message from the
   * default render; search/permalinks/moderation views MUST NOT.
   */
  via_button?: boolean;
}

/**
 * Decode and re-validate a `buttons` field to the protocol §3.3 caps.
 *
 * Node-side enforcement (`validate_buttons`, l2-node 0.131+) rejects a
 * whole envelope that violates these caps — but that is a SEND-time gate.
 * A message already stored/relayed by a pre-0.131 node (the entire fleet as
 * of when this field shipped) never had it enforced, so a decode here MUST
 * NOT trust the wire shape: truncate rather than render whatever arrives.
 * `label`/`command` are additionally run through `safeText()` — the same
 * control/bidi-codepoint sanitizer already used for bot command
 * descriptions — as defense in depth against that same class of node.
 */
function decodeButtonRows(raw: unknown): PayloadButtonRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: PayloadButtonRow[] = [];
  let total = 0;
  for (const rawRow of raw.slice(0, MAX_BUTTON_ROWS)) {
    const rawButtons = (rawRow as any)?.buttons;
    if (!Array.isArray(rawButtons)) {
      rows.push({ buttons: [] });
      continue;
    }
    const buttons: PayloadButton[] = [];
    for (const rawButton of rawButtons.slice(0, MAX_BUTTONS_PER_ROW)) {
      if (total >= MAX_BUTTONS_TOTAL) break;
      const rawLabel = (rawButton as any)?.label;
      const rawCommand = (rawButton as any)?.command;
      const label = safeText(typeof rawLabel === 'string' ? rawLabel : '').slice(0, MAX_BUTTON_LABEL);
      const command = safeText(typeof rawCommand === 'string' ? rawCommand : '').slice(0, MAX_BUTTON_COMMAND);
      // The node rejects an empty label/command outright (validate_buttons).
      // A pre-0.131 node never checked, and sanitization above can itself
      // reduce a string to empty — either way, skip it rather than render a
      // blank-but-clickable button.
      if (!label || !command) continue;
      buttons.push({ label, command });
      total += 1;
    }
    rows.push({ buttons });
    if (total >= MAX_BUTTONS_TOTAL) break;
  }
  return rows;
}

/**
 * Decode a MessagePack payload byte array into a typed object.
 * Returns the decoded payload, or a fallback with empty content on error.
 */
export function decodePayload(payload: number[] | Uint8Array): DecodedPayload {
  try {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const decoded = safeDecode(bytes) as Record<string, unknown>;
    // DM payloads store content as Vec<u8> (bytes), not String.
    // After MessagePack decode, this arrives as Uint8Array.
    let content: string;
    if (decoded.content instanceof Uint8Array) {
      content = new TextDecoder().decode(decoded.content);
    } else {
      content = (decoded.content as string) ?? '';
    }

    return {
      content,
      title: decoded.title as string | undefined,
      channel_id: decoded.channel_id as number | undefined,
      reply_to: decoded.reply_to instanceof Uint8Array
        ? Array.from(decoded.reply_to)
        : (decoded.reply_to as number[] | null | undefined),
      mentions: decoded.mentions as string[] | undefined,
      tags: decoded.tags as string[] | undefined,
      media_cid: decoded.media_cid as string | null | undefined,
      content_rating: decoded.content_rating as string | number | undefined,
      attachments: Array.isArray(decoded.attachments)
        ? (decoded.attachments as any[]).map((a) => ({
            cid: a.cid ?? '',
            mime_type: a.mime_type ?? '',
            size_bytes: a.size_bytes ?? 0,
            filename: a.filename,
            thumbnail_cid: a.thumbnail_cid,
          }))
        : undefined,
      buttons: decodeButtonRows(decoded.buttons),
      via_button: decoded.via_button === true,
    };
  } catch {
    return { content: '' };
  }
}

/**
 * Try to decode a base64-encoded MessagePack payload string. WebSocket
 * messages arrive with `payload` as a base64 string, while API responses
 * deliver it as a byte array. This helper lets all downstream functions
 * handle both transparently. Returns the decoded payload on success, or
 * null if the string is plain text (e.g. an optimistic message).
 *
 * `atob()` is lenient — any string that uses only base64-valid characters
 * (e.g. "Hello") decodes to garbage bytes without throwing, and the
 * subsequent msgpack decode then fails into `{ content: '' }`. Returning
 * that here would make optimistic messages render as empty bubbles and
 * break `startEdit` (which would prefill an empty input, causing the edit
 * Send to silently bail). So we treat a result with no recognizable
 * payload fields as "not actually a base64 payload" and fall back to
 * treating the string as plain text.
 */
export function tryDecodeBase64Payload(payload: string): DecodedPayload | null {
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = decodePayload(bytes);
    // No recognizable payload fields — the input was probably plain text
    // that happens to use only base64-valid characters. Caller should fall
    // back to treating the string as the literal content.
    if (
      !decoded.content &&
      !decoded.title &&
      !decoded.media_cid &&
      (!decoded.attachments || decoded.attachments.length === 0) &&
      (!decoded.buttons || decoded.buttons.length === 0) &&
      !decoded.via_button
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Extract just the content string from a payload byte array.
 * Convenience wrapper for use in FormattedText.
 */
export function getPayloadContent(payload: number[] | Uint8Array | string): string {
  if (typeof payload === 'string') {
    return tryDecodeBase64Payload(payload)?.content ?? payload;
  }
  return decodePayload(payload).content;
}

/**
 * Extract the title from a news post payload, if present.
 */
export function getPayloadTitle(payload: number[] | Uint8Array | string): string | undefined {
  if (typeof payload === 'string') {
    return tryDecodeBase64Payload(payload)?.title;
  }
  return decodePayload(payload).title;
}

/**
 * Extract the tag list from a news post payload (raw, as the author sent
 * them — normalize with `normalizeHashtag` before comparing).
 */
export function getPayloadTags(payload: number[] | Uint8Array | string): string[] {
  if (typeof payload === 'string') {
    return tryDecodeBase64Payload(payload)?.tags ?? [];
  }
  return decodePayload(payload).tags ?? [];
}

/**
 * Extract attachments from a payload, if present.
 */
export function getPayloadAttachments(payload: number[] | Uint8Array | string): PayloadAttachment[] {
  if (typeof payload === 'string') {
    return tryDecodeBase64Payload(payload)?.attachments ?? [];
  }
  return decodePayload(payload).attachments ?? [];
}

/**
 * Extract the `mentions` list from a payload, if present.
 * Returns an empty array when the payload has none or fails to decode.
 */
export function getPayloadMentions(payload: number[] | Uint8Array | string): string[] {
  if (typeof payload === 'string') {
    return tryDecodeBase64Payload(payload)?.mentions ?? [];
  }
  return decodePayload(payload).mentions ?? [];
}

/**
 * Extract the `buttons` rows from a payload, if present (protocol §3.3).
 * Returns an empty array when the payload has none or fails to decode.
 */
export function getPayloadButtons(payload: number[] | Uint8Array | string): PayloadButtonRow[] {
  if (typeof payload === 'string') {
    return tryDecodeBase64Payload(payload)?.buttons ?? [];
  }
  return decodePayload(payload).buttons ?? [];
}

/**
 * Whether this message IS a button press. Rendering hint only — see
 * `DecodedPayload.via_button`.
 */
export function getPayloadViaButton(payload: number[] | Uint8Array | string): boolean {
  if (typeof payload === 'string') {
    return tryDecodeBase64Payload(payload)?.via_button ?? false;
  }
  return decodePayload(payload).via_button ?? false;
}

/**
 * Build a fresh msgpack-encoded chat payload for the optimistic local
 * copy of a just-sent message. Mirrors the structure produced by the
 * SDK's chat envelope so `getPayloadContent` / `getPayloadAttachments`
 * decode it the same way they decode messages echoed back by the L2
 * node — the user sees the image/video in the message bubble instantly
 * instead of an empty timestamp until the WS event arrives.
 */
export function buildOptimisticChatPayload(data: {
  content: string;
  attachments?: PayloadAttachment[];
  mentions?: string[];
  replyTo?: string | null;
}): Uint8Array {
  const payload: Record<string, unknown> = { content: data.content };
  if (data.attachments && data.attachments.length > 0) {
    payload.attachments = data.attachments;
  }
  if (data.mentions && data.mentions.length > 0) {
    payload.mentions = data.mentions;
  }
  if (data.replyTo) {
    // SDK wire format stores reply_to as the target message's msg_id —
    // always 32 bytes (Keccak-256), i.e. exactly 64 hex characters. We
    // mirror that exact shape so optimistic and server-echoed messages
    // decode identically.
    //
    // Strict validation: exactly 64 hex chars (optional `0x` prefix).
    // An even-length-only check would happily turn a 4-char "dead"
    // string into a 2-byte reply_to → bound to the wrong message id
    // until the server echo overwrites the row. Better to drop a
    // malformed value entirely than render a fake reply target.
    const hex = data.replyTo.replace(/^0x/, '');
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 64; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
      }
      payload.reply_to = bytes;
    }
    // Otherwise drop reply_to silently — better to render a message
    // without a reply preview than with a garbled one.
  }
  return encode(payload);
}

/**
 * Return a copy of a msgpack payload with `content` replaced by the
 * provided string and every other field (attachments, mentions, tags,
 * reply_to, …) preserved verbatim.
 *
 * Used by the chat-edit optimistic-update path: previously the code
 * stuffed the new content directly into `msg.payload` as a plain
 * string, which made `getPayloadAttachments` return `[]` and any
 * attached image/video disappear from the bubble until the server's
 * WebSocket update repaired it. Re-encoding here keeps the original
 * binary structure intact so attachments survive the edit visually.
 *
 * Returns `null` if the input can't be decoded — caller should fall
 * back to its existing behaviour.
 */
export function rewriteContentInPayload(
  payload: number[] | Uint8Array | string,
  newContent: string,
): Uint8Array | null {
  try {
    let bytes: Uint8Array | null = null;
    if (typeof payload === 'string') {
      // Base64-decode WebSocket-shape payloads. Plain strings (optimistic
      // messages that never round-tripped a server) have no msgpack
      // structure to preserve — caller's existing behaviour is correct.
      try {
        const binary = atob(payload);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } catch { return null; }
    } else {
      bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    }
    if (!bytes) return null;
    const decoded = safeDecode(bytes) as Record<string, unknown>;
    if (!decoded || typeof decoded !== 'object') return null;
    // Preserve every field as-is; only swap content.
    const next: Record<string, unknown> = { ...decoded, content: newContent };
    return encode(next);
  } catch {
    return null;
  }
}
