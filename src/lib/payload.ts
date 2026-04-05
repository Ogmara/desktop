/**
 * MessagePack payload decoder — extracts human-readable content from
 * raw envelope payload bytes returned by the L2 node API.
 *
 * The API returns messages with `payload` as a byte array (MessagePack-encoded).
 * This module decodes it to extract the content string and other fields.
 */

import { decode } from '@msgpack/msgpack';

/** Media attachment decoded from the payload. */
export interface PayloadAttachment {
  cid: string;
  mime_type: string;
  size_bytes: number;
  filename?: string;
  thumbnail_cid?: string;
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
}

/**
 * Decode a MessagePack payload byte array into a typed object.
 * Returns the decoded payload, or a fallback with empty content on error.
 */
export function decodePayload(payload: number[] | Uint8Array): DecodedPayload {
  try {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const decoded = decode(bytes) as Record<string, unknown>;
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
    };
  } catch {
    return { content: '' };
  }
}

/**
 * Extract just the content string from a payload byte array.
 * Convenience wrapper for use in FormattedText.
 */
export function getPayloadContent(payload: number[] | Uint8Array | string): string {
  if (typeof payload === 'string') return payload;
  return decodePayload(payload).content;
}

/**
 * Extract the title from a news post payload, if present.
 */
export function getPayloadTitle(payload: number[] | Uint8Array | string): string | undefined {
  if (typeof payload === 'string') return undefined;
  return decodePayload(payload).title;
}

/**
 * Extract attachments from a payload, if present.
 */
export function getPayloadAttachments(payload: number[] | Uint8Array | string): PayloadAttachment[] {
  if (typeof payload === 'string') return [];
  return decodePayload(payload).attachments ?? [];
}
