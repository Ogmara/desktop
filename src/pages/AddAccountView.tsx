/**
 * Add an account — create a new wallet, or import an existing private key.
 *
 * Both paths are ADDITIVE: they go through `vaultAddAccount` + `switchAccount`,
 * never `generateWallet`. `generateWallet` is the single-wallet onboarding
 * path — it overwrites the legacy anchor (which, for a user whose PIN
 * migration deferred, is their only key copy) and skips the session teardown,
 * so the previous account's DM and channel keys would be sealed under the new
 * account's backup key and uploaded.
 */

import { createSignal, Show } from 'solid-js';
import { t } from '../i18n/init';
import { navigate, goBack } from '../lib/router';
import { vaultAddAccount } from '../lib/vault';
import { switchAccount } from '../lib/auth';

/** Generate a 32-byte private key as hex. */
function randomKeyHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function AddAccountView() {
  const [importKey, setImportKey] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  async function add(hex: string) {
    setBusy(true);
    setError('');
    try {
      const addr = await vaultAddAccount(hex);
      // Switch only after the slot is written AND verified by `vaultAddAccount`.
      await switchAccount(addr);
      navigate('/chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate() {
    await add(randomKeyHex());
  }

  async function onImport() {
    const hex = importKey().trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      setError(t('wallet_invalid_key'));
      return;
    }
    await add(hex);
    setImportKey('');
  }

  return (
    <div class="add-account-view">
      <header class="view-header">
        <h1>{t('accounts_add')}</h1>
        <p class="muted">{t('accounts_add_hint')}</p>
      </header>

      <Show when={error()}>
        <p class="error-banner" role="alert">{error()}</p>
      </Show>

      <section class="add-account-section">
        <h2>{t('accounts_create_new')}</h2>
        <p class="muted">{t('accounts_create_hint')}</p>
        <button class="btn-primary" onClick={onCreate} disabled={busy()}>
          {busy() ? t('loading') : t('accounts_create_new')}
        </button>
      </section>

      <section class="add-account-section">
        <h2>{t('accounts_import')}</h2>
        <p class="muted">{t('accounts_import_hint')}</p>
        <input
          type="password"
          class="input"
          autocomplete="off"
          spellcheck={false}
          placeholder={t('wallet_private_key')}
          value={importKey()}
          onInput={(e) => setImportKey(e.currentTarget.value)}
          disabled={busy()}
        />
        <button class="btn-primary" onClick={onImport} disabled={busy() || !importKey()}>
          {t('accounts_import')}
        </button>
      </section>

      <button class="btn-secondary" onClick={() => goBack('/accounts')} disabled={busy()}>
        {t('cancel')}
      </button>
    </div>
  );
}
