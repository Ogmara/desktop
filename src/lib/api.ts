/**
 * Ogmara SDK integration — shared client instance.
 */

import { OgmaraClient, DEFAULT_NODE_URL, discoverAndPingNodes, pingNode, type NodeWithPing } from '@ogmara/sdk';
import { getSetting, setSetting } from './settings';

let client: OgmaraClient | null = null;

/** Get or create the shared API client. */
export function getClient(): OgmaraClient {
  if (!client) {
    const nodeUrl = getSetting('nodeUrl') || DEFAULT_NODE_URL;
    client = new OgmaraClient({ nodeUrl });
  }
  return client;
}

/** Reset the client (e.g., when node URL changes). */
export function resetClient(): void {
  client = null;
}

/** Get the user's persisted list of known node URLs (manually added).
 *  The picker merges this with the default node URL and any nodes
 *  discovered from the current node's peer registry — see
 *  `getAvailableNodes`. */
export function getKnownNodes(): string[] {
  return getSetting('knownNodes') ?? [];
}

/** Append a URL to the known-nodes list if not already there.
 *  Called from `switchNode` so every successful switch (whether via
 *  the picker dropdown, the manual-add field, or the SettingsView
 *  text input) leaves a persistent breadcrumb. */
export function addKnownNode(url: string): void {
  const existing = getKnownNodes();
  if (!existing.includes(url)) {
    setSetting('knownNodes', [...existing, url]);
  }
}

/** Remove a URL from the known-nodes list (X button in the picker).
 *  The current node and the default node are never actually removed
 *  from the picker view — they're sourced separately — so this only
 *  affects URLs the user manually added in the past. */
export function removeKnownNode(url: string): void {
  const existing = getKnownNodes();
  setSetting('knownNodes', existing.filter((u) => u !== url));
}

/**
 * Switch to a different node URL.
 *
 * Persists the URL AND resets every transport that was bound to the
 * previous node — the cached HTTP client (so the next API call hits
 * the new host) and the live WebSocket subscription (so push events
 * stop streaming from the old node and reconnect to the new one).
 *
 * Also remembers the URL in `knownNodes` so the picker keeps showing
 * it even after the next switch — without this, switching away from
 * a node made it disappear from the dropdown (the new node's peer
 * registry doesn't necessarily advertise the old one back).
 *
 * Without the WS reset, the cached subscription kept feeding events
 * from the previous node after a switch, which masked test failures:
 * "I switched to my Odroid but I still see the same news posts".
 */
export function switchNode(nodeUrl: string): void {
  setSetting('nodeUrl', nodeUrl);
  addKnownNode(nodeUrl);
  resetClient();
  // Reset the WebSocket too so push events follow the new node.
  // Lazy-imported to break the api.ts ↔ ws.ts circular import chain
  // (ws.ts imports `getCurrentNodeUrl` from this file).
  import('./ws').then(({ closeWs, initWs }) => {
    closeWs();
    // Re-init without the signer is fine — `auth.ts` re-arms the
    // authenticated subscription on next wallet ready event. Calling
    // initWs() here just establishes the anonymous tier so public
    // channel updates start flowing immediately.
    initWs();
  }).catch(() => {
    // ws module is optional at boot — ignore if not yet loaded.
  });
}

/** Get the current node URL. */
export function getCurrentNodeUrl(): string {
  return getSetting('nodeUrl') || DEFAULT_NODE_URL;
}

/** Discover available nodes with ping times, sorted by latency.
 *
 * Desktop opts into `allowPrivateHosts: true` so the user can connect
 * to their own L2 node on the LAN (Odroid, dev box, raspberry pi).
 * The SSRF block in the SDK is only meaningful for the web client.
 *
 * The returned list is the UNION of three sources, deduplicated by URL
 * and with the current node placed first:
 *
 * 1. `discoverAndPingNodes` — pings the current node and any peers it
 *    advertises in `/api/v1/network/nodes`. Driven by the current
 *    node's view of the network.
 * 2. `DEFAULT_NODE_URL` — the SDK's hardcoded default. Always pingable
 *    so the user can fall back even after switching to a node that
 *    doesn't advertise it back.
 * 3. `knownNodes` — every URL the user has successfully switched to
 *    in the past. Persisted in localStorage by `switchNode`. Solves
 *    the "I added my Odroid and now node.ogmara.org disappeared from
 *    the dropdown" footgun — the new node's peer registry won't
 *    necessarily list the old one back, so we keep our own breadcrumb.
 */
export async function getAvailableNodes(): Promise<NodeWithPing[]> {
  const currentUrl = getCurrentNodeUrl();
  const discovered = await discoverAndPingNodes(currentUrl, { allowPrivateHosts: true });

  const discoveredUrls = new Set(discovered.map((n) => n.url));
  // Always include the default + every user-added URL even if the
  // current node didn't advertise them. They might be slow/offline
  // (Infinity ping) — that's still useful info, the user can pick
  // and re-test rather than lose them entirely.
  const extras: string[] = [];
  if (!discoveredUrls.has(DEFAULT_NODE_URL) && DEFAULT_NODE_URL !== currentUrl) {
    extras.push(DEFAULT_NODE_URL);
  }
  for (const url of getKnownNodes()) {
    if (!discoveredUrls.has(url) && url !== DEFAULT_NODE_URL && url !== currentUrl) {
      extras.push(url);
    }
  }

  const extraPings = await Promise.all(
    extras.map(async (url) => ({
      url,
      ping: await pingNode(url, 5000, { allowPrivateHosts: true }),
    })),
  );

  // Hostname-level dedup. Without this, a node whose `public_url` is
  // misconfigured (e.g. Odroid advertising `https://host` while the
  // user is actually connected via `http://host:41721`) shows up as
  // a duplicate row with the same hostname and an Infinity ping —
  // confusing UX. The right entry to keep when two share a hostname:
  //   1. ALWAYS the currently-selected URL (the user trusts that one).
  //   2. Otherwise the entry with the lowest ping (= what actually works).
  // Anything that can't be URL-parsed is kept as-is keyed by its raw
  // string so a stray bad entry never silently disappears.
  const merged = [...discovered, ...extraPings];
  const byHost = new Map<string, typeof merged[number]>();
  for (const n of merged) {
    let host: string;
    try { host = new URL(n.url).hostname; } catch { host = n.url; }
    const existing = byHost.get(host);
    if (!existing) {
      byHost.set(host, n);
      continue;
    }
    // Current URL trumps everything else for this hostname.
    if (n.url === currentUrl) { byHost.set(host, n); continue; }
    if (existing.url === currentUrl) { continue; }
    // Otherwise pick the lower ping.
    if (n.ping < existing.ping) byHost.set(host, n);
  }
  return [...byHost.values()];
}
