/**
 * Encrypted media (P5, spec 04 §9) — desktop client.
 *
 * For ANY encrypted target (DMs always, private channels, public *encrypted*
 * channels) the file bytes are sealed with a fresh per-file key BEFORE they
 * leave the device:
 *
 *   File → bytes → `encryptFile` → `uploadMedia(Blob([cipher]), undefined, {encrypted:true})`
 *        → {@link MediaDescriptor} (carries the per-file key + nonce + real MIME/name).
 *
 * The descriptor rides INSIDE the message ciphertext (`media[]` send param); only
 * a stripped `{ cid, size }` reaches the wire. On render the ciphertext blob is
 * fetched back, `decryptMedia`-d, and turned into an object URL.
 *
 * Tauri note: media GET goes through the global-`fetch` override in `index.tsx`
 * (which routes external URLs through the Tauri HTTP plugin), so a plain
 * `fetch(getMediaUrl(cid))` returns the raw ciphertext bytes here too — no
 * special-casing needed for the download direction. The UPLOAD direction does
 * need the manual multipart builder to carry the `encrypted` form field (see
 * `index.tsx`); that is handled by `uploadMedia(..., { encrypted: true })`.
 */

import { encryptFile, encryptThumbnail, decryptMedia, type MediaDescriptor } from '@ogmara/sdk';
import { getClient } from './api';

/**
 * Copy bytes into a fresh `ArrayBuffer`-backed `Uint8Array` so they're a valid
 * `BlobPart`. TS 5.7 types `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which
 * isn't assignable to `Blob`'s `BlobPart` (it must be `ArrayBuffer`-backed); the
 * copy also detaches the Blob's bytes from any pooled/shared buffer.
 */
function toBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/** Image MIME types we generate an encrypted thumbnail for (the node never sees it). */
const THUMBNAILABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Max pixel dimension of a generated thumbnail. */
const THUMB_MAX = 320;

/**
 * Encrypt a file and upload the ciphertext, returning a {@link MediaDescriptor}.
 * The descriptor's `cid` is the ENCRYPTED blob; `key`/`nonce` (and any `tcid`/
 * `tnonce`) let a recipient decrypt it. For images an encrypted thumbnail is
 * generated + uploaded so the bubble can render a small preview cheaply.
 */
export async function encryptAndUploadFile(file: File): Promise<MediaDescriptor> {
  const client = getClient();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { cipher, key, nonce } = encryptFile(bytes);
  // Upload the opaque ciphertext. `undefined` filename — the real name is hidden
  // inside the descriptor; the node must not learn it.
  const up = await client.uploadMedia(new Blob([toBlobPart(cipher)]), undefined, { encrypted: true });

  const desc: MediaDescriptor = {
    cid: up.cid,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    name: file.name || undefined,
    key,
    nonce,
  };

  // Best-effort encrypted thumbnail for images (failure is non-fatal — the full
  // blob still decrypts on demand).
  if (THUMBNAILABLE.has(desc.mime)) {
    try {
      const thumb = await makeThumbnail(file);
      if (thumb) {
        const { cipher: tcipher, nonce: tnonce } = encryptThumbnail(thumb, key);
        const tup = await client.uploadMedia(new Blob([toBlobPart(tcipher)]), undefined, { encrypted: true });
        desc.tcid = tup.cid;
        desc.tnonce = tnonce;
      }
    } catch {
      // No thumbnail — render falls back to fetching the full blob.
    }
  }
  return desc;
}

/** Downscale an image File to a small JPEG/PNG blob for the encrypted thumbnail. */
async function makeThumbnail(file: File): Promise<Uint8Array | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image decode failed'));
      el.src = url;
    });
    const scale = Math.min(1, THUMB_MAX / Math.max(img.naturalWidth, img.naturalHeight) || 1);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.8),
    );
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- decrypt-for-render cache ----------------------------------------------
// Object URLs are cached so re-renders / scroll don't re-fetch + re-decrypt.
// Keyed by ciphertext CID **plus a key/nonce fingerprint**, NOT by CID alone: a
// CID is an attacker-chooseable content-addressed pointer, so two messages can
// reference the same CID with different keys — a CID-only cache would surface one
// context's plaintext for another's message (confused-deputy / display-integrity
// bug). Bounded LRU so a long session can't accumulate unbounded plaintext blobs
// (audit P5 WARNING-1/2).
const MAX_MEDIA_CACHE = 64;
/** cacheKey → in-flight or resolved object URL for the decrypted blob. */
const objectUrlCache = new Map<string, Promise<string>>();

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function evictIfNeeded(): void {
  while (objectUrlCache.size > MAX_MEDIA_CACHE) {
    const oldest = objectUrlCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const p = objectUrlCache.get(oldest);
    objectUrlCache.delete(oldest);
    if (p) p.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
}

/**
 * Fetch the encrypted blob for `cid`, decrypt it with `key`/`nonce`, and return a
 * `blob:` object URL (typed with `mime` for robust `<video>`/save-as). Cached by
 * cid + key fingerprint. Throws if the fetch or AEAD fails.
 */
export function decryptMediaToUrl(
  cid: string,
  key: Uint8Array,
  nonce: Uint8Array,
  mime?: string,
): Promise<string> {
  const ck = `${cid}:${bytesToHex(key)}:${bytesToHex(nonce)}`;
  const cached = objectUrlCache.get(ck);
  if (cached) {
    // Mark recently-used (re-insert to move to the end of the LRU order).
    objectUrlCache.delete(ck);
    objectUrlCache.set(ck, cached);
    return cached;
  }
  const p = (async () => {
    const res = await fetch(getClient().getMediaUrl(cid));
    if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
    const cipher = new Uint8Array(await res.arrayBuffer());
    const plain = decryptMedia(cipher, key, nonce);
    // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob owns its bytes.
    return URL.createObjectURL(new Blob([toBlobPart(plain)], { type: mime || 'application/octet-stream' }));
  })().catch((e) => {
    objectUrlCache.delete(ck); // allow a retry on the next render
    throw e;
  });
  objectUrlCache.set(ck, p);
  evictIfNeeded();
  return p;
}

/** Revoke composer-preview object URLs for a set of pending attachments (call when
 *  the composer is cleared after send, so the local plaintext previews don't leak). */
export function revokePreviewUrls(atts: Array<{ previewUrl?: string }>): void {
  for (const a of atts) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
}

/** Revoke + drop every cached decrypted-media object URL (logout / wallet switch). */
export function clearMediaObjectUrls(): void {
  for (const p of objectUrlCache.values()) {
    p.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
  objectUrlCache.clear();
}
