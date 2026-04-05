/**
 * Shared utilities for news-related views (NewsView, NewsDetailView, BookmarksView).
 */

/** Convert msg_id to hex string — handles both hex strings and byte arrays from the API. */
export function ensureHexMsgId(msgId: unknown): string {
  if (typeof msgId === 'string') return msgId;
  if (Array.isArray(msgId)) {
    return msgId.map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }
  return String(msgId);
}

/** Format a timestamp to the user's local date/time. */
export function formatLocalTime(timestamp: string | number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Truncate a Klever address for display. */
export function truncateAddress(addr: string): string {
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

/** Predefined reaction emojis for news posts. */
export const NEWS_REACTIONS = [
  { emoji: '👍', label: 'Like' },
  { emoji: '👎', label: 'Dislike' },
  { emoji: '❤️', label: 'Love' },
  { emoji: '🔥', label: 'Fire' },
];
