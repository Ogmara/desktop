/**
 * Media capability — reactive signal for whether the CURRENT node can
 * host files (IPFS configured AND the Kubo daemon reachable).
 *
 * A node can be configured-but-offline (the daemon isn't running, e.g. a
 * text-only deployment), so this is a LIVE capability reported by the
 * node's `/api/v1/health` (`media_uploads`, l2-node 0.48.7+), not a
 * static flag. When a node can't host media we:
 *   - disable the attach/upload button and explain why (MediaUpload), and
 *   - render a friendly "hosted on another node" placeholder for images
 *     that fail to load (FormattedText) instead of a broken-image icon.
 *
 * Node switches trigger a full webview reload (see `api.ts::switchNode`),
 * so a single boot-time fetch is enough — there's no need to track this
 * reactively across switches within one page lifetime.
 */

import { createSignal } from 'solid-js';
import { getClient } from './api';

// undefined = unknown — either not fetched yet, the node is an older
// build that omits `media_uploads`, or the health fetch failed. In every
// "unknown" case we assume media IS available so we never wrongly block
// uploads against a perfectly capable node. Only an explicit `false`
// from the node gates the UI.
const [mediaUploads, setMediaUploads] = createSignal<boolean | undefined>(undefined);

export { mediaUploads };

/** True unless the current node EXPLICITLY reports media is unavailable. */
export const mediaUploadsAvailable = (): boolean => mediaUploads() !== false;

/**
 * Fetch the current node's media capability from `/api/v1/health` and
 * update the signal. Safe to call at boot; failures leave the state at
 * "unknown" (assume available) rather than blocking the UI.
 */
export async function refreshMediaCapability(): Promise<void> {
  try {
    const h = await getClient().health();
    setMediaUploads(h.media_uploads);
  } catch {
    setMediaUploads(undefined);
  }
}
