/**
 * Accounts — hold several wallets on this device and switch between them.
 *
 * Switching is NOT a sign-out: each account's preferences, channels, topic
 * follows and hidden DMs stay on the device under its own namespace and come
 * back when it is selected again (see `walletScope.ts`). Removing an account
 * is the destructive action, and is gated behind an explicit export step
 * because losing a private key is unrecoverable.
 */

import { createSignal, createResource, For, Show } from 'solid-js';
import { t } from '../i18n/init';
import { navigate } from '../lib/router';
import {
  vaultListAccounts,
  vaultExportKeyFor,
  vaultRemoveAccount,
  vaultActiveAddress,
} from '../lib/vault';
import { switchAccount, walletAddress } from '../lib/auth';
import type { AccountEntry } from '../lib/vaultAccounts';

export function AccountsView() {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  /** The account awaiting a removal confirmation, and its exported key. */
  const [removing, setRemoving] = createSignal<{ addr: string; key: string | null } | null>(null);
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
  }

  async function confirmRemove() {
    const target = removing();
    if (!target) return;
    setBusy(target.addr);
    try {
      const others = (accounts() ?? []).filter((e) => e.a !== target.addr);
      await vaultRemoveAccount(target.addr);
      setRemoving(null);
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
                <span class="account-addr">{acc.a.slice(0, 14)}…{acc.a.slice(-6)}</span>
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
                <p class="muted">{t('accounts_remove_export_hint')}</p>
                <code class="export-key">{target().key}</code>
                <button
                  class="btn-secondary"
                  onClick={() => navigator.clipboard.writeText(target().key ?? '')}
                >
                  {t('wallet_copy')}
                </button>
              </Show>
              <div class="modal-actions">
                <button class="btn-secondary" onClick={() => setRemoving(null)}>
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
