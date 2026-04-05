/**
 * ChannelSettingsView — channel admin page.
 *
 * Sections: Info (edit name/desc), Moderators (add/remove), Bans (unban),
 * Pins (unpin), Invite link.
 * Visible to channel owner and moderators with relevant permissions.
 */

import { Component, createResource, createSignal, createEffect, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { getClient } from '../lib/api';
import { walletAddress } from '../lib/auth';
import { navigate, goBack } from '../lib/router';
import { resolveProfile } from '../lib/profile';
import { getPayloadContent } from '../lib/payload';
import { FormattedText } from '../components/FormattedText';

interface ChannelSettingsProps {
  channelId: string;
}

export const ChannelSettingsView: Component<ChannelSettingsProps> = (props) => {
  const channelIdNum = () => parseInt(props.channelId, 10);

  // Channel detail
  const [detail, { refetch: refetchDetail }] = createResource(
    () => props.channelId,
    async (id) => {
      try { return await getClient().getChannelDetail(parseInt(id, 10)); }
      catch { return null; }
    },
  );

  // Members
  const [members, { refetch: refetchMembers }] = createResource(
    () => props.channelId,
    async (id) => {
      try { return await getClient().getChannelMembers(parseInt(id, 10), { limit: 200 }); }
      catch { return null; }
    },
  );

  // Bans
  const [bans, { refetch: refetchBans }] = createResource(
    () => props.channelId,
    async (id) => {
      try { return await getClient().getChannelBans(parseInt(id, 10)); }
      catch { return null; }
    },
  );

  // Pins
  const [pins, { refetch: refetchPins }] = createResource(
    () => props.channelId,
    async (id) => {
      try { return await getClient().getChannelPins(parseInt(id, 10)); }
      catch { return null; }
    },
  );

  // Current user's role
  const myRole = () => {
    const me = walletAddress();
    const m = members()?.members?.find((m) => m.address === me);
    return m?.role ?? 'member';
  };

  const isOwner = () => detail()?.channel?.creator === walletAddress();
  const isMod = () => myRole() === 'moderator' || isOwner();

  // --- Edit info ---
  const [editName, setEditName] = createSignal('');
  const [editDesc, setEditDesc] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [infoMsg, setInfoMsg] = createSignal('');

  // Load current values when detail loads
  createEffect(() => {
    const ch = detail()?.channel;
    if (ch) {
      setEditName(ch.display_name || '');
      setEditDesc((ch as any).description || '');
    }
  });

  const handleSaveInfo = async () => {
    setSaving(true);
    setInfoMsg('');
    try {
      await getClient().updateChannel({
        channelId: channelIdNum(),
        displayName: editName().trim() || undefined,
        description: editDesc().trim() || undefined,
      });
      setInfoMsg('Saved');
      refetchDetail();
    } catch (e: any) {
      setInfoMsg(e?.message || 'Failed');
    } finally {
      setSaving(false);
    }
  };

  // --- Moderator management ---
  const [modAddress, setModAddress] = createSignal('');
  const [modError, setModError] = createSignal('');

  const handleAddMod = async () => {
    const addr = modAddress().trim();
    if (!addr.startsWith('klv1')) return;
    setModError('');
    try {
      await getClient().addModerator(channelIdNum(), addr, {
        can_mute: true, can_kick: true, can_ban: true,
        can_pin: true, can_edit_info: false, can_delete_msgs: false,
      });
      setModAddress('');
      refetchMembers();
    } catch (e: any) {
      setModError(e?.message || 'Failed');
    }
  };

  const handleRemoveMod = async (addr: string) => {
    try {
      await getClient().removeModerator(channelIdNum(), addr);
      refetchMembers();
    } catch { /* ignore */ }
  };

  // --- Unban ---
  const handleUnban = async (addr: string) => {
    try {
      await getClient().unbanUser(channelIdNum(), addr);
      refetchBans();
    } catch { /* ignore */ }
  };

  // --- Unpin ---
  const handleUnpin = async (msgId: string) => {
    try {
      await getClient().unpinMessage(channelIdNum(), msgId);
      refetchPins();
    } catch { /* ignore */ }
  };

  // --- Invite link ---
  const [linkCopied, setLinkCopied] = createSignal(false);
  const handleCopyLink = () => {
    const url = `${window.location.origin}/app/#/join/${channelIdNum()}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  const truncAddr = (addr: string) => `${addr.slice(0, 8)}...${addr.slice(-4)}`;

  const pageTitle = () => isMod() ? t('channel_settings') : t('channel_details');

  return (
    <div class="ch-settings">
      <div class="ch-settings-header">
        <button class="ch-back" onClick={() => navigate(`/chat/${props.channelId}`)}>
          ← {t('nav_back')}
        </button>
        <h2>{pageTitle()}</h2>
      </div>

      {/* Channel info (visible to everyone) */}
      <Show when={detail()?.channel}>
        <div class="ch-section">
          <div class="ch-detail-name">
            # {detail()!.channel.display_name || detail()!.channel.slug}
          </div>
          <Show when={detail()!.channel.description}>
            <div class="ch-detail-desc">{detail()!.channel.description}</div>
          </Show>
          <div class="ch-detail-meta">
            <span>{t('channel_owner')}: <span class="ch-addr" onClick={() => navigate(`/user/${detail()!.channel.creator}`)}>{detail()!.channel.creator.slice(0, 12)}...</span></span>
            <span>{t('channel_members')}: {detail()!.member_count ?? 0}</span>
          </div>
        </div>
      </Show>

      {/* Invite link */}
      <div class="ch-section">
        <button class="ch-link-btn" onClick={handleCopyLink}>
          {linkCopied() ? t('channel_link_copied') : t('channel_copy_link')}
        </button>
      </div>

      {/* Edit info (only for moderators/owner) */}
      <Show when={isMod()}>
        <div class="ch-section">
          <h3>{t('channel_name_label')}</h3>
          <input
            class="ch-input"
            maxLength={64}
            value={editName()}
            onInput={(e) => setEditName(e.currentTarget.value)}
          />
          <h3>{t('channel_description_label')}</h3>
          <textarea
            class="ch-textarea"
            rows={3}
            maxLength={256}
            value={editDesc()}
            onInput={(e) => setEditDesc(e.currentTarget.value)}
          />
          <Show when={infoMsg()}>
            <span class="ch-info-msg">{infoMsg()}</span>
          </Show>
          <button class="ch-save-btn" onClick={handleSaveInfo} disabled={saving()}>
            {saving() ? t('loading') : t('channel_save')}
          </button>
        </div>
      </Show>

      {/* Moderators */}
      <Show when={isOwner()}>
        <div class="ch-section">
          <h3>{t('channel_moderators')}</h3>
          <Show
            when={members()?.members?.filter((m) => m.role === 'moderator').length}
            fallback={<p class="ch-empty">{t('channel_no_moderators')}</p>}
          >
            <For each={members()!.members.filter((m) => m.role === 'moderator')}>
              {(mod) => (
                <div class="ch-list-item">
                  <span class="ch-addr" onClick={() => navigate(`/user/${mod.address}`)}>
                    {truncAddr(mod.address)}
                  </span>
                  <button class="ch-remove-btn" onClick={() => handleRemoveMod(mod.address)}>
                    {t('channel_remove_moderator')}
                  </button>
                </div>
              )}
            </For>
          </Show>
          <div class="ch-add-row">
            <input
              class="ch-input"
              placeholder="klv1..."
              value={modAddress()}
              onInput={(e) => setModAddress(e.currentTarget.value)}
            />
            <button class="ch-add-btn" onClick={handleAddMod} disabled={!modAddress().trim()}>
              {t('channel_add_moderator')}
            </button>
          </div>
          <Show when={modError()}>
            <span class="ch-error">{modError()}</span>
          </Show>
        </div>
      </Show>

      {/* Bans */}
      <Show when={isMod()}>
        <div class="ch-section">
          <h3>{t('channel_bans')}</h3>
          <Show
            when={bans()?.bans?.length}
            fallback={<p class="ch-empty">{t('channel_no_bans')}</p>}
          >
            <For each={bans()!.bans}>
              {(ban) => (
                <div class="ch-list-item">
                  <div class="ch-ban-info">
                    <span class="ch-addr" onClick={() => navigate(`/user/${ban.address}`)}>
                      {truncAddr(ban.address)}
                    </span>
                    <Show when={ban.reason}>
                      <span class="ch-ban-reason">{ban.reason}</span>
                    </Show>
                  </div>
                  <button class="ch-remove-btn" onClick={() => handleUnban(ban.address)}>
                    {t('channel_unban')}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* Pinned messages */}
      <Show when={isMod()}>
        <div class="ch-section">
          <h3>{t('channel_pins')}</h3>
          <Show when={pins()?.pinned_messages?.length} fallback={<p class="ch-empty">—</p>}>
            <For each={pins()!.pinned_messages}>
              {(msg) => (
                <div class="ch-list-item">
                  <div class="ch-pin-preview">
                    <FormattedText content={getPayloadContent(msg.payload)} />
                  </div>
                  <button class="ch-remove-btn" onClick={() => handleUnpin(msg.msg_id)}>
                    {t('channel_unpin_message')}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <style>{`
        .ch-settings { padding: var(--spacing-md); max-width: 600px; overflow-y: auto; height: 100%; }
        .ch-settings-header { display: flex; align-items: center; gap: var(--spacing-md); margin-bottom: var(--spacing-lg); }
        .ch-settings-header h2 { font-size: var(--font-size-xl); }
        .ch-back { font-size: var(--font-size-sm); color: var(--color-text-secondary); }
        .ch-back:hover { color: var(--color-text-primary); }
        .ch-section {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-md);
          margin-bottom: var(--spacing-md);
        }
        .ch-section h3 { font-size: var(--font-size-md); margin-bottom: var(--spacing-sm); }
        .ch-detail-name { font-size: var(--font-size-xl); font-weight: 700; margin-bottom: var(--spacing-sm); }
        .ch-detail-desc { font-size: var(--font-size-sm); color: var(--color-text-secondary); line-height: 1.5; margin-bottom: var(--spacing-md); }
        .ch-detail-meta {
          display: flex;
          gap: var(--spacing-lg);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .ch-input, .ch-textarea {
          width: 100%;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: var(--font-size-sm);
          margin-bottom: var(--spacing-sm);
        }
        .ch-input:focus, .ch-textarea:focus { outline: none; border-color: var(--color-accent-primary); }
        .ch-textarea { resize: none; }
        .ch-save-btn, .ch-add-btn, .ch-link-btn {
          padding: var(--spacing-xs) var(--spacing-md);
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
        }
        .ch-save-btn:disabled, .ch-add-btn:disabled { opacity: 0.5; }
        .ch-link-btn { width: 100%; }
        .ch-info-msg { font-size: var(--font-size-xs); color: var(--color-accent-primary); margin-right: var(--spacing-sm); }
        .ch-error { font-size: var(--font-size-xs); color: #f44; }
        .ch-empty { font-size: var(--font-size-sm); color: var(--color-text-secondary); }
        .ch-list-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: var(--spacing-sm) 0;
          border-bottom: 1px solid var(--color-border);
        }
        .ch-list-item:last-child { border-bottom: none; }
        .ch-addr {
          font-family: monospace;
          font-size: var(--font-size-sm);
          color: var(--color-accent-primary);
          cursor: pointer;
        }
        .ch-addr:hover { text-decoration: underline; }
        .ch-ban-info { display: flex; flex-direction: column; gap: 2px; }
        .ch-ban-reason { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .ch-remove-btn {
          font-size: var(--font-size-xs);
          color: #f44;
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-sm);
        }
        .ch-remove-btn:hover { background: rgba(255,68,68,0.1); }
        .ch-add-row { display: flex; gap: var(--spacing-sm); margin-top: var(--spacing-sm); }
        .ch-add-row .ch-input { flex: 1; margin-bottom: 0; }
        .ch-pin-preview {
          flex: 1;
          font-size: var(--font-size-sm);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 400px;
        }
      `}</style>
    </div>
  );
};
