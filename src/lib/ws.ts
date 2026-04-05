/**
 * WebSocket real-time manager — wraps SDK subscribe() with reactive state.
 *
 * Manages a single WebSocket connection to the L2 node with auto-reconnect.
 * Components register event handlers that are called when events arrive.
 */

import { createSignal } from 'solid-js';
import { subscribe, type WsSubscription, type WsEvent, type WalletSigner } from '@ogmara/sdk';
import { getCurrentNodeUrl } from './api';

type EventHandler = (event: WsEvent) => void;

const [wsConnected, setWsConnected] = createSignal(false);
const handlers = new Set<EventHandler>();

let subscription: WsSubscription | null = null;

export { wsConnected };

/** Initialize the WebSocket connection. */
export function initWs(signer?: WalletSigner): void {
  closeWs();

  const nodeUrl = getCurrentNodeUrl();
  if (!nodeUrl) return;

  subscription = subscribe({
    nodeUrl,
    signer,
    subscribeDm: !!signer,
    autoReconnect: true,
    reconnectDelay: 1000,
    maxReconnectDelay: 30000,
    onEvent: (event: WsEvent) => {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Don't let one handler crash others
        }
      }
    },
    onStateChange: (connected: boolean) => {
      setWsConnected(connected);
    },
  });
}

/** Close the WebSocket connection. */
export function closeWs(): void {
  if (subscription) {
    subscription.close();
    subscription = null;
  }
  setWsConnected(false);
}

/** Subscribe to specific channels for real-time updates. */
export function wsSubscribeChannels(channelIds: string[]): void {
  if (subscription && channelIds.length > 0) {
    subscription.subscribe(channelIds);
  }
}

/** Unsubscribe from channels. */
export function wsUnsubscribeChannels(channelIds: string[]): void {
  if (subscription && channelIds.length > 0) {
    subscription.unsubscribe(channelIds);
  }
}

/**
 * Register an event handler. Returns an unsubscribe function.
 * Call the returned function in Solid.js onCleanup() for automatic cleanup.
 */
export function onWsEvent(handler: EventHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
