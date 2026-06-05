/**
 * MediaImage — an inline image that falls back to a readable
 * "Image hosted on another node — switch nodes to view" placeholder when the
 * CID can't be fetched (most commonly because the image lives on a different
 * node and THIS node has no IPFS backend, so the node returns 503/404).
 *
 * Single source of truth for chat messages, news posts, and comments so a
 * missing attachment never renders as the browser's broken-image icon.
 */

import { Component, Show, createSignal } from 'solid-js';
import { t } from '../i18n/init';

export const MediaImage: Component<{
  /** Displayed source (thumbnail or full CID URL). */
  src: string;
  alt: string;
  /** Class applied to the <img> (e.g. 'msg-image', 'news-attachment-img'). */
  class?: string;
  /** Full-size URL. When set and no `onOpen`, the image links to it (new tab). */
  href?: string;
  /** Optional click handler (e.g. open a lightbox). Takes precedence over the
   *  `href` link wrapper. */
  onOpen?: () => void;
}> = (props) => {
  const [errored, setErrored] = createSignal(false);
  const renderImg = () => (
    <img
      src={props.src}
      alt={props.alt}
      class={props.class}
      loading="lazy"
      onError={() => setErrored(true)}
      onClick={props.onOpen}
    />
  );
  return (
    <Show
      when={!errored()}
      fallback={
        <div class="media-img-missing" title={props.alt}>
          <span class="media-img-missing-icon" aria-hidden="true">🖼️</span>
          <span class="media-img-missing-text">{t('media_image_other_node')}</span>
        </div>
      }
    >
      <Show when={props.href && !props.onOpen} fallback={renderImg()}>
        <a href={props.href} target="_blank" rel="noopener noreferrer">{renderImg()}</a>
      </Show>
    </Show>
  );
};
