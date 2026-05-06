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
import { resolveProfile, type CachedProfile } from '../lib/profile';
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

  // Resolve profile (display name + avatar) for each member address.
  // The map is populated asynchronously as individual profile lookups
  // complete, so the UI re-renders row-by-row without blocking.
  const [memberProfiles, setMemberProfiles] = createSignal<Map<string, CachedProfile>>(new Map());
  createEffect(() => {
    const list = members()?.members;
    if (!list) return;
    for (const m of list) {
      if (memberProfiles().has(m.address)) continue;
      resolveProfile(m.address).then((p) => {
        setMemberProfiles((prev) => {
          const next = new Map(prev);
          next.set(m.address, p);
          return next;
        });
      }).catch(() => { /* best-effort */ });
    }
  });
  const getMemberProfile = (addr: string): CachedProfile | undefined => memberProfiles().get(addr);
  const memberDisplayName = (addr: string): string => {
    const p = getMemberProfile(addr);
    if (p?.display_name) return p.display_name;
    return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
  };
  const memberInitial = (addr: string): string => {
    const p = getMemberProfile(addr);
    if (p?.display_name) return p.display_name.slice(0, 2).toUpperCase();
    return addr.slice(4, 6).toUpperCase();
  };

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

  // Whether the current viewer holds a specific moderator capability flag.
  // The owner has all capabilities implicitly. Moderators only have the
  // capabilities granted at AddModerator time. Use this for gating UI that
  // would 403 if the L2 node sees the action without the matching capability
  // (e.g. ChannelUpdate requires `can_edit_info`).
  type ModCap = 'can_mute' | 'can_kick' | 'can_ban' | 'can_pin' | 'can_edit_info' | 'can_delete_msgs';
  const hasModCap = (cap: ModCap) => {
    if (isOwner()) return true;
    const me = walletAddress();
    const m = members()?.members?.find((m) => m.address === me);
    const perms = m?.permissions as Record<ModCap, boolean> | undefined;
    return Boolean(perms?.[cap]);
  };
  const canEditInfo = () => hasModCap('can_edit_info');

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

  // --- Logo / avatar upload ---
  const [logoUploading, setLogoUploading] = createSignal(false);
  const [logoMsg, setLogoMsg] = createSignal('');
  let logoFileInput: HTMLInputElement | undefined;

  const handleLogoUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setLogoMsg(t('channel_logo_only_images'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoMsg(t('channel_logo_too_large'));
      return;
    }
    setLogoUploading(true);
    setLogoMsg('');
    try {
      const client = getClient();
      const uploaded = await client.uploadMedia(file, file.name);
      await client.updateChannel({
        channelId: channelIdNum(),
        logoCid: uploaded.cid,
      });
      setLogoMsg(t('channel_logo_saved'));
      refetchDetail();
      // Notify the rest of the app so the sidebar chat-row refetches
      window.dispatchEvent(new Event('ogmara:channels-changed'));
    } catch (e: any) {
      setLogoMsg(e?.message || t('channel_logo_upload_failed'));
    } finally {
      setLogoUploading(false);
    }
  };

  const handleLogoRemove = async () => {
    setLogoUploading(true);
    setLogoMsg('');
    try {
      await getClient().updateChannel({
        channelId: channelIdNum(),
        logoCid: '', // empty string = clear
      });
      setLogoMsg(t('channel_logo_removed'));
      refetchDetail();
      window.dispatchEvent(new Event('ogmara:channels-changed'));
    } catch (e: any) {
      setLogoMsg(e?.message || t('channel_logo_remove_failed'));
    } finally {
      setLogoUploading(false);
    }
  };

  // --- Posting mode toggle (Public ⇄ ReadPublic) ---
  // Lets the creator / mods (with can_edit_info) flip a channel between
  // open chat and broadcast mode at runtime. Hidden for Private channels —
  // the L2 node rejects flips to/from Private (protocol spec §3.6).
  const [postingModeSaving, setPostingModeSaving] = createSignal(false);
  const [postingModeMsg, setPostingModeMsg] = createSignal('');
  // Default `null` (not 0) so the toggle stays hidden until the API response
  // actually loads. Defaulting to 0 (Public) would briefly show the toggle on
  // a Private channel during the first render after navigation, leading to a
  // 403 if the user clicks before the channel loads.
  const channelType = (): number | null => {
    const t = detail()?.channel?.channel_type;
    return typeof t === 'number' ? t : null;
  };
  const isPrivateChannel = () => channelType() === 2;
  const isReadPublicChannel = () => channelType() === 1;
  const channelTypeKnown = () => channelType() !== null;
  const handleTogglePostingMode = async () => {
    if (isPrivateChannel()) return; // sanity guard; UI hides the toggle anyway
    setPostingModeSaving(true);
    setPostingModeMsg('');
    try {
      // Flip Public (0) ⇄ ReadPublic (1). The L2 node rejects any other
      // target at validation, so only these two values reach the wire.
      const nextType = isReadPublicChannel() ? 0 : 1;
      await getClient().updateChannel({
        channelId: channelIdNum(),
        channelType: nextType,
      });
      setPostingModeMsg(t('channel_posting_mode_saved'));
      refetchDetail();
      window.dispatchEvent(new Event('ogmara:channels-changed'));
    } catch (e: any) {
      setPostingModeMsg(e?.message || t('channel_posting_mode_failed'));
    } finally {
      setPostingModeSaving(false);
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

      {/* Channel avatar (logo) — only for moderators/owner */}
      <Show when={isMod()}>
        <div class="ch-section">
          <h3>{t('channel_avatar_label')}</h3>
          <div class="ch-avatar-row">
            <div class="ch-avatar-preview">
              <Show
                when={detail()?.channel.logo_cid}
                fallback={
                  <span class="ch-avatar-initial">
                    {(detail()?.channel.display_name || detail()?.channel.slug || '#').slice(0, 1).toUpperCase()}
                  </span>
                }
              >
                <img
                  class="ch-avatar-img"
                  src={getClient().getMediaUrl(detail()!.channel.logo_cid!)}
                  alt=""
                />
              </Show>
            </div>
            <div class="ch-avatar-actions">
              <input
                ref={logoFileInput}
                type="file"
                accept="image/*"
                style="display: none"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) handleLogoUpload(file);
                  e.currentTarget.value = '';
                }}
              />
              <button
                class="ch-save-btn"
                onClick={() => logoFileInput?.click()}
                disabled={logoUploading()}
              >
                {logoUploading()
                  ? t('loading')
                  : (detail()?.channel.logo_cid ? t('channel_avatar_change') : t('channel_avatar_upload'))}
              </button>
              <Show when={detail()?.channel.logo_cid && !logoUploading()}>
                <button class="ch-remove-btn" onClick={handleLogoRemove}>
                  {t('channel_avatar_remove')}
                </button>
              </Show>
            </div>
          </div>
          <Show when={logoMsg()}>
            <span class="ch-info-msg">{logoMsg()}</span>
          </Show>
        </div>
      </Show>

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

      {/* Posting mode toggle — owner OR mods with can_edit_info, never Private,
          and only after the channel record has actually loaded. */}
      <Show when={canEditInfo() && channelTypeKnown() && !isPrivateChannel()}>
        <div class="ch-section">
          <h3>{t('channel_posting_mode_label')}</h3>
          <p class="ch-posting-mode-desc">
            {isReadPublicChannel()
              ? t('channel_posting_mode_readonly_desc')
              : t('channel_posting_mode_public_desc')}
          </p>
          <button
            class="ch-save-btn"
            onClick={handleTogglePostingMode}
            disabled={postingModeSaving()}
          >
            {postingModeSaving()
              ? t('loading')
              : isReadPublicChannel()
                ? t('channel_posting_mode_make_public')
                : t('channel_posting_mode_make_readonly')}
          </button>
          <Show when={postingModeMsg()}>
            <span class="ch-info-msg">{postingModeMsg()}</span>
          </Show>
        </div>
      </Show>

      {/* Members — visible to everyone, shows full list with roles */}
      <Show when={members()?.members}>
        <div class="ch-section">
          <h3>
            {t('channel_members')}
            <span class="ch-count"> ({members()!.members.length})</span>
          </h3>
          <Show
            when={members()!.members.length > 0}
            fallback={<p class="ch-empty">{t('channel_no_members')}</p>}
          >
            <div class="ch-member-list">
              <For each={members()!.members}>
                {(member) => {
                  const prof = () => getMemberProfile(member.address);
                  return (
                    <div
                      class="ch-member-row"
                      onClick={() => navigate(`/user/${member.address}`)}
                    >
                      <div class="ch-member-avatar">
                        <Show
                          when={prof()?.avatar_cid}
                          fallback={<span>{memberInitial(member.address)}</span>}
                        >
                          <img
                            class="ch-member-avatar-img"
                            src={getClient().getMediaUrl(prof()!.avatar_cid!)}
                            alt=""
                          />
                        </Show>
                      </div>
                      <div class="ch-member-body">
                        <div class="ch-member-name-row">
                          <span class="ch-member-name">{memberDisplayName(member.address)}</span>
                          <Show when={prof()?.verified}>
                            <span class="ch-member-verified" title={t('channel_verified')}>✓</span>
                          </Show>
                        </div>
                        <Show
                          when={prof()?.display_name}
                          fallback={
                            <Show when={member.role !== 'member'}>
                              <div class="ch-member-role">
                                {member.role === 'creator' ? t('channel_owner') : t('channel_moderator')}
                              </div>
                            </Show>
                          }
                        >
                          {/* If we have a display name, show truncated address + role below */}
                          <div class="ch-member-subtitle">
                            <span class="ch-member-addr-small">{truncAddr(member.address)}</span>
                            <Show when={member.role !== 'member'}>
                              <span class="ch-member-sep">·</span>
                              <span class="ch-member-role">
                                {member.role === 'creator' ? t('channel_owner') : t('channel_moderator')}
                              </span>
                            </Show>
                          </div>
                        </Show>
                      </div>
                      <Show when={member.role === 'creator'}>
                        <span class="ch-member-badge ch-member-badge-owner">👑</span>
                      </Show>
                      <Show when={member.role === 'moderator'}>
                        <span class="ch-member-badge">⚙</span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
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

        .ch-avatar-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-md);
          margin-bottom: var(--spacing-sm);
        }
        .ch-avatar-preview {
          width: 72px;
          height: 72px;
          border-radius: var(--radius-full);
          background: linear-gradient(135deg, var(--color-accent-primary), var(--color-accent-secondary));
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 28px;
          font-weight: 700;
          user-select: none;
          overflow: hidden;
          flex-shrink: 0;
        }
        .ch-avatar-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .ch-avatar-actions {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          flex-wrap: wrap;
        }
        .ch-count {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          font-weight: 500;
        }
        .ch-member-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .ch-member-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 10px;
          border-radius: var(--radius-md);
          cursor: pointer;
          transition: background 0.15s;
        }
        .ch-member-row:hover { background: var(--color-bg-tertiary); }
        .ch-member-avatar {
          width: 40px;
          height: 40px;
          border-radius: var(--radius-full);
          background: linear-gradient(135deg, var(--color-accent-primary), var(--color-accent-secondary));
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 700;
          flex-shrink: 0;
          user-select: none;
          overflow: hidden;
        }
        .ch-member-avatar-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .ch-member-body {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .ch-member-name-row {
          display: flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
        }
        .ch-member-name {
          font-size: var(--font-size-md);
          font-weight: 600;
          color: var(--color-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ch-member-verified {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border-radius: var(--radius-full);
          background: var(--color-accent-primary);
          color: #fff;
          font-size: 9px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .ch-member-subtitle {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .ch-member-addr-small {
          font-family: monospace;
          font-size: 11px;
        }
        .ch-member-sep { opacity: 0.5; }
        .ch-member-role {
          font-size: var(--font-size-xs);
          color: var(--color-accent-primary);
        }
        .ch-member-badge {
          font-size: 16px;
          flex-shrink: 0;
        }
        .ch-member-badge-owner { color: #f5c518; }
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
