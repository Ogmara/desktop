/**
 * Which routes belong to one account, and where to send the user when the
 * active account changes underneath one of them.
 *
 * An in-place account switch does not unmount anything and does not change
 * the URL, so `#/chat/<id>` or `#/dm/<peer>` opened by account A stays on
 * screen for account B — B then renders (and the views act on) a channel or
 * conversation that belongs to A. Kept free of imports so it is testable
 * under `node --test` (router.ts needs `window` and settings).
 */

/** Neutral route for a per-account DETAIL view, or `null` for views that are
 *  either public (profiles, news posts) or already account-neutral lists.
 *  `channel-join` is deliberately excluded: an invite link is often opened
 *  first and the right account switched to second, and joining is explicit. */
export function neutralRouteFor(view: string): string | null {
  switch (view) {
    case 'chat':             // only reached here with a channelId (see caller)
    case 'channel-settings':
      return '/chat';        // re-resolves to the NEW account's lastChannel
    case 'dm-conversation':
      return '/dm';
    default:
      return null;
  }
}

/**
 * Whether a change of active wallet is an in-place switch between two real
 * accounts (as opposed to the first login of the session).
 *
 * `lastActive` is the last NON-null wallet seen, so a handover that passes
 * through "signed out" (A → null → B, as `disconnectWallet` does) still
 * counts as A → B, while the first login (nothing → A) does not — a deep link
 * opened before signing in must keep working.
 */
export function isAccountChange(lastActive: string | null, next: string | null): boolean {
  return !!lastActive && !!next && lastActive !== next;
}

/**
 * The route to replace the current one with after the active wallet changed,
 * or `null` to leave it alone.
 */
export function routeAfterAccountChange(
  view: string,
  params: Readonly<Record<string, string>>,
  lastActive: string | null,
  next: string | null,
): string | null {
  if (!isAccountChange(lastActive, next)) return null;
  if (view === 'chat' && !params.channelId) return null; // already neutral
  return neutralRouteFor(view);
}
