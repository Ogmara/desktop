/**
 * FormattedText — renders message content with clickable URLs and inline formatting.
 *
 * Supports: **bold**, *italic*, __underline__, `code`, ~~strikethrough~~, and auto-linked URLs.
 * URLs open in a new browser tab.
 */

import { Component, For, Show, createSignal } from 'solid-js';
import { JSX } from 'solid-js/jsx-runtime';
import { parseMessageContent, type TextSegment, type Attachment } from '@ogmara/sdk';
import { getClient } from '../lib/api';
import { navigate } from '../lib/router';
import { getSetting } from '../lib/settings';

interface Props {
  content: string;
  /** IPFS attachments from the message envelope. */
  attachments?: Attachment[];
}

/** Image MIME types that should render inline. SVG rendered via <img> tag (safe — scripts don't execute in <img>). */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
/** Video MIME types that render as inline <video> elements. */
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg'];

/** Regex for hashtags: # followed by word chars (letters, digits, underscore). */
const HASHTAG_RE = /#([\w\u00C0-\u024F]+)/g;

/** Render text with newlines preserved and hashtags clickable. */
function renderTextWithBreaksAndHashtags(text: string): JSX.Element {
  // Split on newlines first
  const lines = text.split('\n');
  const elements: JSX.Element[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) elements.push(<br />);
    const line = lines[i];
    // Parse hashtags within each line
    let lastIndex = 0;
    HASHTAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HASHTAG_RE.exec(line)) !== null) {
      if (match.index > lastIndex) {
        elements.push(<>{line.slice(lastIndex, match.index)}</>);
      }
      const tag = match[1];
      elements.push(
        <button
          class="msg-hashtag"
          onClick={() => navigate(`/search?q=${encodeURIComponent('#' + tag)}`)}
        >
          #{tag}
        </button>,
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) {
      elements.push(<>{line.slice(lastIndex)}</>);
    }
  }
  return <>{elements}</>;
}

// Shared lightbox state — only one image fullscreen at a time
const [lightboxUrl, setLightboxUrl] = createSignal<string | null>(null);

// Close on Escape key
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightboxUrl()) setLightboxUrl(null);
  });
}

/** Fullscreen image lightbox overlay. */
export const ImageLightbox: Component = () => (
  <Show when={lightboxUrl()}>
    <div class="lightbox-overlay" onClick={() => setLightboxUrl(null)}>
      <img
        src={lightboxUrl()!}
        class="lightbox-image"
        onClick={(e) => e.stopPropagation()}
        alt="Full size"
      />
      <button class="lightbox-close" onClick={() => setLightboxUrl(null)}>✕</button>
    </div>
  </Show>
);

export const FormattedText: Component<Props> = (props) => {
  const segments = () => parseMessageContent(props.content);

  return (
    <span class="formatted-text">
      <For each={segments()}>
        {(seg) => {
          switch (seg.type) {
            case 'url': {
              // Defense-in-depth: only allow http/https links
              const safe = seg.url.startsWith('http://') || seg.url.startsWith('https://');
              if (!safe) return <span>{seg.display}</span>;
              // Check if this is an internal app link (same origin or ogmara.org with hash route)
              const isInternal = (() => {
                try {
                  const u = new URL(seg.url);
                  const here = window.location;
                  const sameOrigin = u.origin === here.origin;
                  const ogmaraApp = u.hostname === 'ogmara.org' && (u.pathname === '/app/' || u.pathname === '/app');
                  return (sameOrigin || ogmaraApp) && u.hash.startsWith('#/');
                } catch { return false; }
              })();
              return isInternal ? (
                <a
                  href={seg.url}
                  class="msg-link"
                  onClick={(e) => {
                    e.preventDefault();
                    const hash = new URL(seg.url).hash.replace('#', '');
                    navigate(hash);
                  }}
                >
                  {seg.display}
                </a>
              ) : (
                <a
                  href={seg.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="msg-link"
                >
                  {seg.display}
                </a>
              );
            }
            case 'bold':
              return <strong>{renderTextWithBreaksAndHashtags(seg.content)}</strong>;
            case 'italic':
              return <em>{renderTextWithBreaksAndHashtags(seg.content)}</em>;
            case 'underline':
              return <u>{renderTextWithBreaksAndHashtags(seg.content)}</u>;
            case 'code':
              return <code class="msg-code">{seg.content}</code>;
            case 'strikethrough':
              return <s>{renderTextWithBreaksAndHashtags(seg.content)}</s>;
            default:
              return renderTextWithBreaksAndHashtags(seg.content);
          }
        }}
      </For>

      {/* Render attachments: images, videos, and files */}
      <Show when={props.attachments && props.attachments.length > 0}>
        <div class="msg-attachments">
          <For each={props.attachments}>
            {(att) => {
              const isImage = IMAGE_TYPES.includes(att.mime_type);
              const isVideo = VIDEO_TYPES.includes(att.mime_type);
              const mediaUrl = getClient().getMediaUrl(att.cid);
              const autoload = getSetting('mediaAutoload') !== 'never';

              if (isImage && autoload) {
                return (
                  <img
                    src={att.thumbnail_cid
                      ? getClient().getMediaUrl(att.thumbnail_cid)
                      : mediaUrl}
                    alt={att.filename || 'image'}
                    class="msg-image"
                    loading="lazy"
                    onClick={() => setLightboxUrl(mediaUrl)}
                  />
                );
              }
              if (isVideo && autoload) {
                return (
                  <video
                    class="msg-video"
                    controls
                    preload="metadata"
                    src={mediaUrl}
                  >
                    <a href={mediaUrl} target="_blank" rel="noopener noreferrer">{att.filename || 'video'}</a>
                  </video>
                );
              }
              // Non-media files or autoload disabled — show as download link
              const icon = isImage ? '🖼' : isVideo ? '🎬' : '📎';
              return (
                <a
                  href={mediaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="msg-file"
                >
                  {icon} {att.filename || att.cid.slice(0, 12) + '...'}
                </a>
              );
            }}
          </For>
        </div>
      </Show>

      <style>{`
        .msg-link {
          color: var(--color-accent-primary);
          text-decoration: underline;
          word-break: break-all;
        }
        .msg-link:hover { opacity: 0.8; }
        .msg-code {
          background: var(--color-bg-tertiary);
          padding: 1px 4px;
          border-radius: var(--radius-sm);
          font-family: monospace;
          font-size: 0.9em;
        }
        .msg-attachments {
          display: flex;
          flex-wrap: wrap;
          gap: var(--spacing-sm);
          margin-top: var(--spacing-sm);
        }
        .msg-image {
          max-width: 400px;
          max-height: 300px;
          border-radius: var(--radius-md);
          cursor: pointer;
          object-fit: cover;
        }
        .msg-image:hover { opacity: 0.9; }
        .msg-video {
          max-width: 400px;
          max-height: 300px;
          border-radius: var(--radius-md);
          background: #000;
        }
        .msg-file {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: var(--spacing-xs) var(--spacing-sm);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-sm);
          color: var(--color-accent-primary);
          font-size: var(--font-size-sm);
          text-decoration: none;
        }
        .msg-file:hover { background: var(--color-bg-secondary); }
        .msg-hashtag {
          color: var(--color-accent-primary);
          font-weight: 600;
          cursor: pointer;
          font-size: inherit;
          font-family: inherit;
        }
        .msg-hashtag:hover { text-decoration: underline; }

        .lightbox-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.9);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          cursor: zoom-out;
        }
        .lightbox-image {
          max-width: 95vw;
          max-height: 95vh;
          object-fit: contain;
          border-radius: var(--radius-md);
          cursor: default;
          box-shadow: 0 0 40px rgba(0, 0, 0, 0.5);
        }
        .lightbox-close {
          position: fixed;
          top: 16px;
          right: 16px;
          font-size: 24px;
          padding: 8px 14px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.15);
          color: white;
          cursor: pointer;
          z-index: 10001;
          transition: background 0.15s;
        }
        .lightbox-close:hover { background: rgba(255, 255, 255, 0.3); }
      `}</style>
    </span>
  );
};
