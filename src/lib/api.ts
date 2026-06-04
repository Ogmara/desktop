/**
 * Ogmara SDK integration — shared client instance.
 */

import { OgmaraClient, DEFAULT_NODE_URL, discoverAndPingNodes, pingNode, validateNodeUrl, type NodeWithPing } from '@ogmara/sdk';
import { getSetting, setSetting } from './settings';
import { vaultGetSigner } from './vault';

let client: OgmaraClient | null = null;

/**
 * Get or create the shared API client.
 *
 * The signer is RE-ATTACHED on every (re)creation from the vault's
 * in-memory `cachedSigner`. This decouples signer lifetime from client
 * lifetime: any `resetClient()` (e.g. a node switch) used to silently
 * drop the signer, so the next `getClient()` produced a signer-less
 * client and the next authenticated call threw "Signer required for
 * authenticated endpoints". This bit hard during boot, where
 * `bootstrapNodeSelection()` runs concurrently with `initAuth()` and
 * can call `switchNodeSilent()` → `resetClient()` AFTER the signer was
 * attached. Re-reading the vault signer here makes the client robust
 * regardless of reset ordering — when the vault is locked/empty
 * `vaultGetSigner()` returns null and we attach nothing (correct).
 */
export function getClient(): OgmaraClient {
  if (!client) {
    const nodeUrl = getSetting('nodeUrl') || DEFAULT_NODE_URL;
    client = new OgmaraClient({ nodeUrl });
    const signer = vaultGetSigner();
    if (signer) client.withSigner(signer);
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
  switchNodeSilent(nodeUrl);
  // Mark this as an EXPLICIT user choice so the post-reload
  // `bootstrapNodeSelection()` honors it instead of re-running its
  // best-ping (or pinned-default) selection and bouncing the user
  // onto a different node. Without this, "switch to X" reloaded, then
  // bootstrap immediately re-picked the lowest-ping candidate — so a
  // manual switch never actually stuck, and switching *back* to a
  // higher-ping original node silently landed somewhere else (which
  // then sat on the loading spinner if that node was flaky). Survives
  // the reload via sessionStorage (cleared once consumed at boot).
  try {
    sessionStorage.setItem('ogmara:explicitNode', nodeUrl);
  } catch {
    /* sessionStorage unavailable — fall back to best-ping after reload */
  }
  // Force a full webview reload so EVERY component refetches against
  // the new node. Without this, every `createResource` in the app
  // keeps serving the previous node's cached payload — channels,
  // news feed, profile, DMs, follow lists, etc. all show stale data
  // until the user manually closes and reopens the app. (Bug
  // observed during cross-node bake-in 2026-05-18.)
  //
  // The setting writes inside `switchNodeSilent` above are
  // synchronous localStorage writes, so they're already persisted
  // by the time reload fires.
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

/**
 * Silent variant — switches the active node WITHOUT a webview reload.
 * Used by [`bootstrapNodeSelection`] to land on the chosen node
 * before any component has mounted, so no `createResource` has yet
 * cached the previous node's payload.
 *
 * Never call from user-driven UI — components built against the
 * previous node won't refetch on their own. Use `switchNode` there.
 */
export function switchNodeSilent(nodeUrl: string): void {
  // Validate at this single choke point so EVERY switch path — picker,
  // manual-add, pinned-default, best-ping, and the explicit-flag boot
  // path — is covered uniformly. A compromised current node can
  // advertise arbitrary peer URLs via the peer registry, and best-ping
  // would otherwise switch (and now auto-attach the signer) to them
  // without any check. `allowPrivateHosts: true` keeps LAN/Odroid/dev
  // nodes usable — matching the rest of the desktop's posture — while
  // still rejecting malformed, non-http, over-long, or unparseable
  // URLs. On rejection we keep the current node rather than switch to
  // garbage. (Security audit, v0.19.0 SDK validateNodeUrl.)
  if (!validateNodeUrl(nodeUrl, { allowPrivateHosts: true })) {
    return;
  }
  setSetting('nodeUrl', nodeUrl);
  addKnownNode(nodeUrl);
  resetClient();
  // RECONNECT (not just close) the WebSocket so push events follow the
  // new node — but ONLY if a socket is already live. At cold boot the
  // connection is owned by App.tsx's `startWebSocket()` (which attaches
  // the vault signer after `initAuth()`); a concurrent
  // `bootstrapNodeSelection()` switch must not open its own anonymous
  // socket and race to be the last writer (that dropped DM push). Once
  // the app is running, `wsIsActive()` is true and the switch correctly
  // reconnects with the current vault signer (anon only if still
  // locked). `initWs()` closes any existing socket first. Lazy-imported
  // to break the api.ts ↔ ws.ts circular import chain.
  import('./ws').then(({ initWs, wsIsActive }) => {
    if (wsIsActive()) initWs(vaultGetSigner() ?? undefined);
  }).catch(() => {
    // ws module is optional at boot — ignore if not yet loaded.
  });
}

/**
 * User-pinned "always connect here first" node URL (v1.23.0+).
 *
 * Empty string = no pin → [`bootstrapNodeSelection`] picks the
 * lowest-ping node at boot.
 */
export function getDefaultNodeUrl(): string {
  return getSetting('defaultNodeUrl') || '';
}

/**
 * Pin (or clear) the always-connect-here-first node URL. Pass an
 * empty string or `null` to clear the pin and revert to best-ping
 * selection on the next boot. Pinning a URL also adds it to
 * `knownNodes` so the picker keeps surfacing it.
 */
export function setDefaultNodeUrl(url: string | null): void {
  const v = url ?? '';
  setSetting('defaultNodeUrl', v);
  if (v) addKnownNode(v);
}

/**
 * Boot-time node-selection driver (v1.23.0+ / spec 5 §1.1).
 *
 * Decision tree:
 *   1. If `defaultNodeUrl` is pinned: try it with a 3 s ping timeout.
 *      Reach? → land on it. Unreachable? → fall through with a
 *      `default-unreachable-fallback` reason on the result so the
 *      UI can surface a one-time notice.
 *   2. Otherwise (or after step 1's fallback): ping every candidate
 *      from `getAvailableNodes()`, pick the lowest finite ping.
 *   3. If no candidate is reachable, leave `nodeUrl` as-is and
 *      return `no-candidates`.
 *
 * Must be called BEFORE any `getClient()` use that fetches data.
 */
export type BootstrapReason =
  | 'default'
  | 'default-unreachable-fallback'
  | 'best-ping'
  | 'no-candidates';

export interface BootstrapResult {
  chosen: string;
  reason: BootstrapReason;
}

let _lastBootstrapResult: BootstrapResult | null = null;

/**
 * Returns the most recent boot-time selection result, or `null` if
 * boot hasn't completed yet. Picker UIs use this to surface a one-
 * time notice when the pinned default was unreachable.
 */
export function getLastBootstrapResult(): BootstrapResult | null {
  return _lastBootstrapResult;
}

export async function bootstrapNodeSelection(): Promise<BootstrapResult> {
  // An explicit user switch (picker / manual-add) triggers a webview
  // reload, which re-enters this function. Honor that choice verbatim
  // — skip pin + best-ping entirely — so the node the user picked is
  // the node they land on. The flag is one-shot: consumed here so the
  // NEXT cold boot resumes normal pinned/best-ping selection.
  let explicit = '';
  try {
    explicit = sessionStorage.getItem('ogmara:explicitNode') || '';
    if (explicit) sessionStorage.removeItem('ogmara:explicitNode');
  } catch {
    /* sessionStorage unavailable — ignore, fall through to normal path */
  }
  if (explicit) {
    if (explicit !== getCurrentNodeUrl()) switchNodeSilent(explicit);
    const result: BootstrapResult = { chosen: explicit, reason: 'default' };
    _lastBootstrapResult = result;
    return result;
  }

  const pinned = getDefaultNodeUrl();
  if (pinned) {
    const ping = await pingNode(pinned, 3000, { allowPrivateHosts: true });
    if (ping !== Infinity) {
      if (pinned !== getCurrentNodeUrl()) switchNodeSilent(pinned);
      const result: BootstrapResult = { chosen: pinned, reason: 'default' };
      _lastBootstrapResult = result;
      return result;
    }
    // Fall through to best-ping with the default-fallback reason.
  }

  const candidates = await getAvailableNodes().catch(() => [] as NodeWithPing[]);
  const reachable = candidates.filter((c) => c.ping !== Infinity);
  if (reachable.length > 0) {
    reachable.sort((a, b) => a.ping - b.ping);
    const best = reachable[0].url;
    if (best !== getCurrentNodeUrl()) switchNodeSilent(best);
    const result: BootstrapResult = {
      chosen: best,
      reason: pinned ? 'default-unreachable-fallback' : 'best-ping',
    };
    _lastBootstrapResult = result;
    return result;
  }
  const result: BootstrapResult = { chosen: getCurrentNodeUrl(), reason: 'no-candidates' };
  _lastBootstrapResult = result;
  return result;
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
