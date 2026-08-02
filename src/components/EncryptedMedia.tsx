/**
 * EncryptedMedia — renders one decrypted attachment (P5).
 *
 * The on-wire CID points at an OPAQUE ciphertext blob; the per-file key/nonce
 * live in the {@link MediaDescriptor} that arrived inside the message ciphertext.
 * We fetch the ciphertext (through the Tauri HTTP path — see `index.tsx`),
 * `decryptMedia` it, and turn the plaintext into a `blob:` object URL. Object
 * URLs are cached by cid in `mediaCrypto` and revoked on logout/wallet switch.
 *
 * States: a "🔒 decrypting…" placeholder while in flight, the image/video/file
 * once decrypted, and a "🔒 encrypted attachment" fallback on failure (wrong
 * key, blob hosted on a node we can't reach, AEAD failure).
 */

import { Component, Show, createResource } from 'solid-js';
import type { MediaDescriptor } from '@ogmara/sdk';
import { t } from '../i18n/init';
import { decryptMediaToUrl } from '../lib/mediaCrypto';
import { MediaImage } from './MediaImage';
import { VideoAttachment } from './VideoAttachment';
import { stripBidi } from '../lib/sanitize';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg'];

export const EncryptedMedia: Component<{
  media: MediaDescriptor;
  /** Open a full-size lightbox with the decrypted object URL. */
  onOpen?: (url: string) => void;
}> = (props) => {
  const isImage = () => IMAGE_TYPES.includes(props.media.mime);
  const isVideo = () => VIDEO_TYPES.includes(props.media.mime);
  const safeName = () => stripBidi(props.media.name || '') || 'file';

  // Decrypt the FULL blob to an object URL. Images additionally try the encrypted
  // thumbnail first (cheaper) but fall back to the full blob if absent/failed.
  const [fullUrl] = createResource(
    () => props.media,
    (m) => decryptMediaToUrl(m.cid, m.key, m.nonce, m.mime),
  );
  const [thumbUrl] = createResource(
    () => (props.media.tcid && props.media.tnonce ? props.media : null),
    (m) => decryptMediaToUrl(m!.tcid!, m!.key, m!.tnonce!, 'image/jpeg'),
  );

  // Solid resources RE-THROW when called while `.state === 'errored'` (by
  // design, so `<ErrorBoundary>` can catch them declaratively). This
  // component has no local error boundary, so calling `fullUrl()`/`thumbUrl()`
  // directly whenever either has failed — e.g. a 429 from the node's media
  // rate limiter — throws during render and poisons the owning computation:
  // observed live as the whole channel view "freezing" (stuck on whichever
  // channel was open, switching did nothing) the moment any attachment in
  // the message list errored. Never call the resource accessor without
  // checking `.error` first.
  const safeFull = () => (fullUrl.error ? undefined : fullUrl());
  const safeThumb = () => (thumbUrl.error ? undefined : thumbUrl());

  // Something is displayable once EITHER the thumbnail (images) or the full blob
  // resolves. For images with a thumbnail we don't block on the (larger) full blob;
  // for everything else we wait for the full blob.
  const hasThumb = () => !!(props.media.tcid && props.media.tnonce);
  const ready = () => !!safeFull() || (isImage() && hasThumb() && !!safeThumb());
  const decrypting = () => !ready() && !fullUrl.error;
  // Only a FULL-blob failure is terminal (a thumbnail miss falls back to the full blob).
  const failed = () => !!fullUrl.error && !safeFull() && !(isImage() && !!safeThumb());

  return (
    <Show
      when={!failed()}
      fallback={
        <div class="enc-media-fallback" title={safeName()}>
          <span aria-hidden="true">🔒</span> {t('media_encrypted_attachment')}
        </div>
      }
    >
      <Show
        when={!decrypting()}
        fallback={
          <div class="enc-media-loading" title={safeName()}>
            <span aria-hidden="true">🔒</span> {t('media_decrypting')}
          </div>
        }
      >
        <Show
          when={isImage()}
          fallback={
            <Show
              when={isVideo()}
              fallback={
                <a
                  class="msg-file"
                  href={safeFull()}
                  download={safeName()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  📎 {safeName()}
                </a>
              }
            >
              <VideoAttachment
                src={safeFull()!}
                filename={props.media.name}
                videoClass="msg-video"
                fallbackClass="msg-file"
              />
            </Show>
          }
        >
          <MediaImage
            src={safeThumb() || safeFull()!}
            alt={safeName()}
            class="msg-image"
            onOpen={() => { const u = safeFull() || safeThumb(); if (u) props.onOpen?.(u); }}
          />
        </Show>
      </Show>
      <style>{`
        .enc-media-loading, .enc-media-fallback {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: var(--spacing-xs) var(--spacing-sm);
          background: var(--color-bg-tertiary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
        }
      `}</style>
    </Show>
  );
};
