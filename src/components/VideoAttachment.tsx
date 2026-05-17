/**
 * VideoAttachment — `<video>` element with graceful fallback when the
 * platform can't decode the file.
 *
 * The Linux Tauri build runs on WebKitGTK, which hands all media
 * decoding to GStreamer. Without `gstreamer1.0-libav` (and the
 * good/bad/ugly plugin sets) installed, an `<video>` element pointed
 * at an H.264/AAC clip renders as a black rectangle with no
 * controls — the element loads but cannot decode the bitstream, and
 * the `<a>` fallback inside `<video>` only runs when the element type
 * itself is unsupported, not when the codec is missing.
 *
 * On codec failure the component flips to a fallback panel offering:
 *   1) **Open externally** — hands the URL to the OS handler via
 *      `open_media_external` Tauri command (mpv/vlc/etc., which use
 *      their own ffmpeg builds and play files WebKitGTK can't).
 *   2) Direct download link as a last resort.
 *
 * This matches what Telegram desktop does on Linux: when WebKit can't
 * play it inline, the user is one click away from a working player.
 */

import { Component, createSignal, createEffect, on, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { stripBidi } from '../lib/sanitize';
import { t } from '../i18n/init';

interface VideoAttachmentProps {
  /** Direct URL to the media file. */
  src: string;
  /** Filename shown in the fallback link / `download` hint. */
  filename?: string;
  /** Optional class applied to the `<video>` so callers can size it. */
  videoClass?: string;
  /** Optional class applied to the fallback `<a>` link. */
  fallbackClass?: string;
}

export const VideoAttachment: Component<VideoAttachmentProps> = (props) => {
  const [failed, setFailed] = createSignal(false);
  const [openError, setOpenError] = createSignal('');

  // Reset the `failed` state when the source URL changes. Without this,
  // a `<VideoAttachment>` that's reused for a different attachment
  // (rare but possible if the parent re-uses the component slot via
  // prop swap rather than a fresh mount) would stay in the
  // download-link state for the new src.
  createEffect(on(() => props.src, () => {
    setFailed(false);
    setOpenError('');
  }, { defer: true }));

  // Sanitize the filename before it reaches `download=` or rendered
  // text. The field comes from the original uploader (chain payload)
  // and could in principle contain bidi/control codepoints that would
  // distort the displayed name or confuse the browser's download hint.
  const safeName = () => stripBidi(props.filename || '');

  const openExternal = async () => {
    setOpenError('');
    try {
      await invoke('open_media_external', { url: props.src });
    } catch (e: any) {
      // xdg-open / open / explorer returned an error or no handler
      // registered. Show the message so the user can install a video
      // player rather than wonder why nothing happened.
      setOpenError(e?.message || String(e));
    }
  };

  return (
    <Show
      when={!failed()}
      fallback={
        <div class={`video-fallback ${props.fallbackClass || ''}`}>
          <span class="video-fallback-label">
            🎬 {safeName() || t('media_attach') || 'video'}
          </span>
          <span class="video-fallback-hint">
            {t('video_codec_missing') || 'Inline playback unavailable on this system.'}
          </span>
          <div class="video-fallback-actions">
            <button
              class="video-fallback-btn"
              type="button"
              onClick={openExternal}
              title={t('video_open_external_hint') || 'Open in your system video player'}
            >
              ▶ {t('video_open_external') || 'Open externally'}
            </button>
            <a
              class="video-fallback-btn video-fallback-link"
              href={props.src}
              target="_blank"
              rel="noopener noreferrer"
              download={safeName() || undefined}
            >
              ⬇ {t('video_download') || 'Download'}
            </a>
          </div>
          <Show when={openError()}>
            <span class="video-fallback-error">{openError()}</span>
          </Show>
          <style>{`
            .video-fallback {
              display: inline-flex;
              flex-direction: column;
              gap: 6px;
              padding: 12px 14px;
              background: var(--color-bg-tertiary);
              border: 1px solid var(--color-border);
              border-radius: var(--radius-md);
              max-width: 320px;
            }
            .video-fallback-label {
              font-size: var(--font-size-sm);
              color: var(--color-text-primary);
              font-weight: 600;
            }
            .video-fallback-hint {
              font-size: var(--font-size-xs);
              color: var(--color-text-secondary);
            }
            .video-fallback-actions {
              display: flex;
              gap: 8px;
              margin-top: 2px;
            }
            .video-fallback-btn {
              display: inline-flex;
              align-items: center;
              gap: 4px;
              padding: 6px 10px;
              border-radius: var(--radius-sm);
              border: 1px solid var(--color-border);
              background: var(--color-bg-secondary);
              color: var(--color-text-primary);
              font-size: var(--font-size-xs);
              cursor: pointer;
              text-decoration: none;
            }
            .video-fallback-btn:hover {
              background: var(--color-bg-primary);
              border-color: var(--color-accent-primary);
              color: var(--color-accent-primary);
            }
            .video-fallback-link { text-decoration: none; }
            .video-fallback-error {
              font-size: var(--font-size-xs);
              color: var(--color-error);
            }
          `}</style>
        </div>
      }
    >
      <video
        class={props.videoClass}
        controls
        // `preload="none"` — do NOT fetch metadata on render. WebKitGTK
        // (Linux Tauri) without `gstreamer1.0-libav` retries every failing
        // metadata fetch through `WebLoaderStrategy`, so a feed with N
        // un-playable videos floods the page with N×many internal load
        // failures and can stall the renderer ("channels with videos look
        // empty", "news feed appears frozen"). Defer fetching until the
        // user clicks play — at which point either the codec works or
        // `onError` fires and the fallback panel takes over. The poster
        // attribute is intentionally omitted; without a thumbnail_cid the
        // video shows the default play-button placeholder, which is the
        // same UX our fallback link offers anyway.
        preload="none"
        src={props.src}
        // `error` fires when the video element gave up — codec missing,
        // network failure, etc. We surface the fallback link instead of
        // a silent black box.
        onError={() => setFailed(true)}
      >
        {/* In-tag fallback for browsers that don't know <video> at all
            (very rare). The main fallback is the `failed()` branch
            above, which handles codec failures. */}
        <a href={props.src} target="_blank" rel="noopener noreferrer">
          {safeName() || 'video'}
        </a>
      </video>
    </Show>
  );
};
