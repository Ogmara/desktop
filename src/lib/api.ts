/**
 * Ogmara SDK integration — shared client instance.
 */

import { OgmaraClient, DEFAULT_NODE_URL, discoverAndPingNodes, type NodeWithPing } from '@ogmara/sdk';
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

/** Switch to a different node URL. */
export function switchNode(nodeUrl: string): void {
  setSetting('nodeUrl', nodeUrl);
  resetClient();
}

/** Get the current node URL. */
export function getCurrentNodeUrl(): string {
  return getSetting('nodeUrl') || DEFAULT_NODE_URL;
}

/** Discover available nodes with ping times, sorted by latency. */
export async function getAvailableNodes(): Promise<NodeWithPing[]> {
  const currentUrl = getCurrentNodeUrl();
  return discoverAndPingNodes(currentUrl);
}
