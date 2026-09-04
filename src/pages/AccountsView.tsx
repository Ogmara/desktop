/**
 * Accounts — hold several wallets on this device and switch between them.
 *
 * Switching is NOT a sign-out: each account's preferences, channels, topic
 * follows and hidden DMs stay on the device under its own namespace and come
 * back when it is selected again (see `walletScope.ts`). Removing an account
 * is the destructive action, and is gated behind an explicit export step
 * because losing a private key is unrecoverable.
 */

import { Component, createSignal, createEffect, createResource, onCleanup, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { navigate } from '../lib/router';
import { getClient } from '../lib/api';
import { resolveProfile, type CachedProfile } from '../lib/profile';
import {
  vaultListAccounts,
  vaultExportKeyFor,
  vaultRemoveAccount,
  vaultActiveAddress,
} from '../lib/vault';
import { switchAccount, walletAddress } from '../lib/auth';
import type { AccountEntry } from '../lib/vaultAccounts';

/**
 * One account row's avatar + name, resolved from the currently connected
 * node — same lookup `BookmarksView`/`NewsView` use for any other address, so
 * it shares that cache rather than adding a second one.
 *
 * A bare address is hard to tell apart from another at a glance; the name and
 * picture are what a user actually recognises their own accounts by.
 */
const AccountIdentity: Component<{ address: string }> = (props) => {
  const [profile, setProfile] = createSignal<CachedProfile>({});

  createEffect(() => {
    resolveProfile(props.address).then(setProfile);
  });

  return (
    <>
      <Show
        when={profile().avatar_cid}
        fallback={
          <span class="account-avatar-placeholder" aria-hidden="true">
            {(profile().display_name || props.address).slice(0, 2).toUpperCase()}
          </span>
        }
      >
        <img class="account-avatar" src={getClient().getMediaUrl(profile().avatar_cid!)} alt="" loading="lazy" />
      </Show>
      <span class="account-text">
        <Show when={profile().display_name}>
          <span class="account-name">{profile().display_name}</span>
        </Show>
        <span class="account-addr">{props.address.slice(0, 14)}…{props.address.slice(-6)}</span>
      </span>
    </>
  );
};

export function AccountsView() {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  /** The account awaiting a removal confirmation, and its exported key. */
  const [removing, setRemoving] = createSignal<{ addr: string; key: string | null } | null>(null);
  /** Drops the revealed key from memory if the dialog is left open. */
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  function stopReveal() {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    setRemoving(null);
  }

  // A private key must not outlive the dialog that showed it — not on an
  // abandoned screen, and not in a component that merely unmounted.
  onCleanup(stopReveal);
  const [reload, setReload] = createSignal(0);

  const [accounts] = createResource(reload, async () => {
    try {
      return await vaultListAccounts();
    } catch {
      return [] as AccountEntry[];
    }
  });

  const isActive = (a: string) => a === (walletAddress() ?? vaultActiveAddress());

  async function onSwitch(addr: string) {
    if (isActive(addr) || busy()) return;
    setBusy(addr);
    setError('');
    try {
      await switchAccount(addr);
      navigate('/chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('accounts_switch_failed'));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Begin removal by exporting the key.
   *
   * The key is shown BEFORE the account is removed, not after — after is too
   * late, and an "are you sure?" that does not put the key in front of the
   * user is not an export gate.
   */
  async function beginRemove(addr: string) {
    setError('');
    const key = await vaultExportKeyFor(addr).catch(() => null);
    setRemoving({ addr, key });
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(stopReveal, 120_000);
  }

  async function confirmRemove() {
    const target = removing();
    if (!target) return;
    setBusy(target.addr);
    try {
      const others = (accounts() ?? []).filter((e) => e.a !== target.addr);
      await vaultRemoveAccount(target.addr);
      stopReveal();
      setReload((n) => n + 1);
      // If the active account went away, hand over rather than leaving the app
      // holding a signer for an account that no longer exists.
      if (isActive(target.addr) && others.length > 0) {
        await switchAccount(others[0].a).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error_generic'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="accounts-view">
      <header class="view-header">
        <h1>{t('accounts_title')}</h1>
        <p class="muted">{t('accounts_hint')}</p>
      </header>

      <Show when={error()}>
        <p class="error-banner" role="alert">{error()}</p>
      </Show>

      <ul class="accounts-list">
        <For each={accounts() ?? []}>
          {(acc) => (
            <li class="account-row" classList={{ active: isActive(acc.a) }}>
              <button
                class="account-main"
                onClick={() => onSwitch(acc.a)}
                disabled={isActive(acc.a) || busy() !== null}
                aria-current={isActive(acc.a) ? 'true' : undefined}
              >
                <span class="account-dot" aria-hidden="true">{isActive(acc.a) ? '●' : '○'}</span>
                <AccountIdentity address={acc.a} />
                <Show when={isActive(acc.a)}>
                  <span class="account-badge">{t('accounts_active')}</span>
                </Show>
              </button>
              <button
                class="account-remove"
                onClick={() => beginRemove(acc.a)}
                disabled={busy() !== null}
                title={t('accounts_remove')}
              >
                {t('accounts_remove')}
              </button>
            </li>
          )}
        </For>
      </ul>

      <Show when={(accounts() ?? []).length === 0}>
        <p class="muted">{t('accounts_empty')}</p>
      </Show>

      <button class="btn-primary" onClick={() => navigate('/accounts/add')} disabled={busy() !== null}>
        {t('accounts_add')}
      </button>

      <Show when={removing()}>
        {(target) => (
          <div class="modal-backdrop" role="dialog" aria-modal="true">
            <div class="modal">
              <h2>{t('accounts_remove_title')}</h2>
              <p>{t('accounts_remove_warning')}</p>
              <Show
                when={target().key}
                fallback={<p class="error-banner">{t('accounts_remove_no_key')}</p>}
              >
                {/* No copy BUTTON. A one-click copy puts the private key on
                    the system clipboard — readable by every other process,
                    captured by clipboard-history managers, with nothing to
                    clear it — and `WalletView` copies only the address for
                    that reason. The user can still select and copy manually,
                    which is deliberate: they need to save it somewhere. What
                    is avoided is the app putting it there on a single click.
                    The reveal is dropped after two minutes and on unmount. */}
                <p class="muted">{t('accounts_remove_export_hint')}</p>
                <code class="export-key">{target().key}</code>
              </Show>
              <div class="modal-actions">
                <button class="btn-secondary" onClick={stopReveal}>
                  {t('cancel')}
                </button>
                <button class="btn-danger" onClick={confirmRemove} disabled={busy() !== null}>
                  {t('accounts_remove_confirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
