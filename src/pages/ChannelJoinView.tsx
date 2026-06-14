/**
 * ChannelJoinView — deeplink landing page for joining a channel.
 *
 * URL: #/join/{channelId}
 * Public channels: shows channel info + join button.
 * Private channels: shows invite-required message.
 */

import { Component, createResource, createSignal, createEffect, Show } from 'solid-js';
import { OgmaraClient, validateNodeUrl, type ChannelDetailResponse } from '@ogmara/sdk';
import { t } from '../i18n/init';
import { getClient, getCurrentNodeUrl, switchNode } from '../lib/api';
import { authStatus, walletAddress } from '../lib/auth';
import { navigate, queryParam } from '../lib/router';
import { addJoinedChannel } from '../components/Sidebar';

interface ChannelJoinProps {
  channelId: string;
}

const hostLabel = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};

export const ChannelJoinView: Component<ChannelJoinProps> = (props) => {
  const [joining, setJoining] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notFound, setNotFound] = createSignal(false);
  // The channel isn't on the current node, but the invite link names a host node
  // where it lives (private channels are host-scoped). We preview it from there.
  const [crossNode, setCrossNode] = createSignal<{ host: string; detail: ChannelDetailResponse } | null>(null);

  const channelIdNum = () => parseInt(props.channelId, 10);

  const [channel] = createResource(
    () => props.channelId,
    async (id) => {
      setNotFound(false);
      setCrossNode(null);
      const cid = parseInt(id, 10);
      try {
        return await getClient().getChannelDetail(cid);
      } catch {
        // Not on the current node. If the link carries a `?node=` host hint we
        // don't currently use, fetch a PREVIEW from there so the user sees the
        // channel before deciding to switch nodes.
        const hintRaw = queryParam('node');
        const hint = hintRaw ? decodeURIComponent(hintRaw) : '';
        const cur = getCurrentNodeUrl();
        if (hint && validateNodeUrl(hint) && hint !== cur) {
          try {
            const detail = await new OgmaraClient({ nodeUrl: hint }).getChannelDetail(cid);
            setCrossNode({ host: hint, detail });
            return null;
          } catch {
            // host unreachable or channel really gone — fall through to not-found
          }
        }
        setNotFound(true);
        return null;
      }
    },
  );

  // After a "Switch & join" the app reloads on the host node; auto-complete the
  // join once the channel resolves there (and auth is ready for private channels).
  createEffect(() => {
    const ch = channel();
    const ready = authStatus() === 'ready';
    if (!ch) return;
    let pending = '';
    try { pending = sessionStorage.getItem('ogmara:pendingJoin') || ''; } catch { /* ignore */ }
    if (pending !== props.channelId) return;
    if (isPrivate() && !ready) return; // private join needs auth — wait for it
    try { sessionStorage.removeItem('ogmara:pendingJoin'); } catch { /* ignore */ }
    void handleJoin();
  });

  const handleSwitchAndJoin = () => {
    const cn = crossNode();
    if (!cn) return;
    try { sessionStorage.setItem('ogmara:pendingJoin', props.channelId); } catch { /* ignore */ }
    switchNode(cn.host); // persists the node + full reload → channel loads from host
  };

  const isPrivate = () => {
    const ch = channel()?.channel;
    return ch && ch.channel_type === 2;
  };

  const handleJoin = async () => {
    setJoining(true);
    setError('');
    try {
      // Authenticated users: send join envelope so the node tracks membership.
      // For public channels this is best-effort — the channel is readable without it.
      if (walletAddress()) {
        try {
          const client = getClient();
          await client.joinChannel(channelIdNum());
        } catch {
          // Non-critical for public channels — user can still read messages
          if (isPrivate()) throw new Error('Failed to join private channel');
        }
      }
      // Add to local sidebar and navigate
      addJoinedChannel(channelIdNum());
      window.dispatchEvent(new Event('ogmara:channels-changed'));
      navigate(`/chat/${channelIdNum()}`);
    } catch (e: any) {
      setError(e?.message || 'Failed to join');
    } finally {
      setJoining(false);
    }
  };

  return (
    <div class="join-view">
      <Show when={notFound() && !crossNode()}>
        <div class="join-card">
          <h2 class="join-name">{t('channel_not_found')}</h2>
          <p class="join-desc">{t('channel_not_found_desc')}</p>
          <button class="join-btn" onClick={() => navigate('/news')}>{t('nav_news')}</button>
        </div>
      </Show>

      {/* The channel lives on a different node (private, host-scoped) — preview it
          from the host and offer a one-click switch + join. */}
      <Show when={crossNode()}>
        <div class="join-card">
          <h2 class="join-name">
            🔒 {crossNode()!.detail.channel.display_name || crossNode()!.detail.channel.slug}
          </h2>
          <Show when={(crossNode()!.detail.channel as any).description}>
            <p class="join-desc">{(crossNode()!.detail.channel as any).description}</p>
          </Show>
          <div class="join-meta">
            {(crossNode()!.detail as any)?.member_count ?? crossNode()!.detail.channel.member_count ?? 0} {t('channel_members')}
          </div>
          <p class="join-private-hint">
            {t('channel_on_other_node', { node: hostLabel(crossNode()!.host) })}
          </p>
          <button class="join-btn" onClick={handleSwitchAndJoin}>
            {t('channel_switch_and_join')}
          </button>
        </div>
      </Show>

      <Show when={!notFound() && !crossNode() && !channel()}>
        <div class="join-loading">{t('loading')}</div>
      </Show>
      <Show when={!notFound() && channel()}>
        <div class="join-card">
          <h2 class="join-name">
            {isPrivate() ? '🔒' : '#'} {channel()!.channel.display_name || channel()!.channel.slug}
          </h2>
          <Show when={channel()!.channel.description}>
            <p class="join-desc">{(channel()!.channel as any).description}</p>
          </Show>
          <div class="join-meta">
            {(channel() as any)?.member_count ?? channel()!.channel.member_count ?? 0} {t('channel_members')}
          </div>

          <Show when={isPrivate()}>
            <p class="join-private-hint">{t('channel_private_invite_link')}</p>
          </Show>

          {/* Private channels require authentication; public channels can be joined anonymously */}
          <Show when={isPrivate() && authStatus() !== 'ready'}>
            <button class="join-btn" onClick={() => navigate('/wallet')}>
              {t('auth_connect_prompt')}
            </button>
          </Show>
          <Show when={!isPrivate() || authStatus() === 'ready'}>
            <button
              class="join-btn"
              onClick={handleJoin}
              disabled={joining()}
            >
              {joining() ? t('loading') : t('channel_join')}
            </button>
          </Show>

          <Show when={error()}>
            <div class="join-error">{error()}</div>
          </Show>
        </div>
      </Show>

      <style>{`
        .join-view {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          padding: var(--spacing-lg);
        }
        .join-loading { color: var(--color-text-secondary); }
        .join-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-xl);
          max-width: 400px;
          width: 100%;
          text-align: center;
        }
        .join-name { font-size: var(--font-size-xl); margin-bottom: var(--spacing-sm); }
        .join-desc { color: var(--color-text-secondary); margin-bottom: var(--spacing-md); }
        .join-meta { font-size: var(--font-size-sm); color: var(--color-text-secondary); margin-bottom: var(--spacing-lg); }
        .join-private {
          padding: var(--spacing-md);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-md);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
        }
        .join-btn {
          padding: var(--spacing-sm) var(--spacing-xl);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-md);
        }
        .join-btn:disabled { opacity: 0.5; }
        .join-private-hint {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-md);
          padding: var(--spacing-sm);
          background: var(--color-bg-tertiary);
          border-radius: var(--radius-md);
        }
        .join-error {
          margin-top: var(--spacing-md);
          color: #f44;
          font-size: var(--font-size-sm);
        }
      `}</style>
    </div>
  );
};
