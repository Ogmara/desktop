/**
 * WalletView — desktop wallet management (built-in wallet only).
 *
 * No Klever Extension or K5 sections — desktop handles all
 * on-chain operations standalone via the built-in vault signer.
 */

import { Component, createSignal, createResource, Show, onCleanup } from 'solid-js';
import { t } from '../i18n/init';
import {
  authStatus,
  walletAddress,
  isRegistered,
  generateWallet,
  connectWithKey,
  disconnectWallet,
  setRegistrationStatus,
  getSigner,
  initAuth,
} from '../lib/auth';
import { vaultHasWallet, vaultExportKey, vaultUnlockWithPin } from '../lib/vault';
import { verifyPin } from '../lib/appLock';
import { registerUser, delegateDevice, revokeDevice } from '../lib/klever';
import { navigate } from '../lib/router';

export const WalletView: Component = () => {
  const [importKey, setImportKey] = createSignal('');
  const [vaultHasKey, setVaultHasKey] = createSignal(false);
  const [vaultChecked, setVaultChecked] = createSignal(false);
  const [showExport, setShowExport] = createSignal(false);

  // Check if vault has a key (blocks create/import until checked)
  createResource(async () => {
    const has = await vaultHasWallet();
    setVaultHasKey(has);
    setVaultChecked(true);
  });
  const [exportedKey, setExportedKey] = createSignal('');
  const [error, setError] = createSignal('');
  const [txPending, setTxPending] = createSignal(false);
  const [txResult, setTxResult] = createSignal<string | null>(null);
  const [showDelegation, setShowDelegation] = createSignal(false);
  const [delegateKeyInput, setDelegateKeyInput] = createSignal('');
  const [delegatePermissions, setDelegatePermissions] = createSignal(0x07);
  const [revokeKeyInput, setRevokeKeyInput] = createSignal('');
  const [showDisconnectConfirm, setShowDisconnectConfirm] = createSignal(false);
  const [showUnlock, setShowUnlock] = createSignal(false);
  const [unlockPin, setUnlockPin] = createSignal('');
  const [unlockError, setUnlockError] = createSignal('');
  const [unlockLoading, setUnlockLoading] = createSignal(false);

  // Auto-clear exported key after 30 seconds for security
  let exportClearTimer: ReturnType<typeof setTimeout> | null = null;

  function clearExportedKey() {
    setShowExport(false);
    setExportedKey('');
    if (exportClearTimer) { clearTimeout(exportClearTimer); exportClearTimer = null; }
  }

  onCleanup(() => {
    // Clear key from memory when component unmounts
    setExportedKey('');
    if (exportClearTimer) clearTimeout(exportClearTimer);
  });

  const handleGenerate = async () => {
    setError('');
    try {
      await generateWallet();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleImport = async () => {
    setError('');
    const key = importKey().trim();
    if (key.length !== 64) {
      setError('Private key must be 64 hex characters');
      return;
    }
    try {
      await connectWithKey(key);
      setImportKey('');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDisconnect = async () => {
    if (!showDisconnectConfirm()) {
      setShowDisconnectConfirm(true);
      return;
    }
    await disconnectWallet();
    clearExportedKey();
    setShowDisconnectConfirm(false);
    navigate('/news');
  };

  const handleRegister = async () => {
    setError('');
    setTxPending(true);
    setTxResult(null);
    try {
      const signer = getSigner();
      if (!signer) throw new Error('No signer available');
      const txHash = await registerUser(signer.publicKeyHex);
      setTxResult(txHash);
      setRegistrationStatus(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTxPending(false);
    }
  };

  const handleDelegate = async () => {
    setError('');
    const key = delegateKeyInput().trim();
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      setError('Device key must be 64 hex characters');
      return;
    }
    setTxPending(true);
    try {
      const txHash = await delegateDevice(
        key,
        delegatePermissions(),
        0,
      );
      setTxResult(txHash);
      setDelegateKeyInput('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTxPending(false);
    }
  };

  const handleRevoke = async () => {
    setError('');
    const key = revokeKeyInput().trim();
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      setError('Device key must be 64 hex characters');
      return;
    }
    setTxPending(true);
    try {
      const txHash = await revokeDevice(key);
      setTxResult(txHash);
      setRevokeKeyInput('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTxPending(false);
    }
  };

  const handleUnlock = async () => {
    setUnlockError('');
    setUnlockLoading(true);
    try {
      const key = await verifyPin(unlockPin());
      if (!key) {
        setUnlockError(t('lock_wrong_pin'));
        setUnlockPin('');
        return;
      }
      const address = await vaultUnlockWithPin(key);
      if (!address) {
        setUnlockError('Failed to decrypt vault');
        return;
      }
      // Re-init auth now that the vault is unlocked
      await initAuth();
      setShowUnlock(false);
      setUnlockPin('');
    } catch (e: any) {
      setUnlockError(e?.message || 'Unlock failed');
    } finally {
      setUnlockLoading(false);
    }
  };

  const copyAddress = () => {
    const addr = walletAddress();
    if (addr) navigator.clipboard.writeText(addr);
  };

  return (
    <div class="wallet-view">
      <h2>{t('settings_wallet')}</h2>

      <Show when={error()}>
        <div class="wallet-error">{error()}</div>
      </Show>

      <Show when={txResult()}>
        <div class="wallet-success">
          {t('onchain_tx_confirmed')}: <code>{txResult()!.slice(0, 16)}...</code>
        </div>
      </Show>

      <Show when={txPending()}>
        <div class="wallet-pending">{t('onchain_tx_pending')}</div>
      </Show>

      {/* Loading vault check */}
      <Show when={authStatus() === 'none' && !vaultChecked()}>
        <div class="wallet-loading">{t('loading')}</div>
      </Show>

      {/* Vault has a key but auth not ready — offer to reconnect */}
      <Show when={authStatus() === 'none' && vaultChecked() && vaultHasKey()}>
        <section class="wallet-section">
          <h3>{t('wallet_existing')}</h3>
          <p class="wallet-desc">{t('wallet_existing_desc')}</p>
          <Show when={!showUnlock()}>
            <button class="wallet-btn primary" onClick={async () => {
              setError('');
              // Try raw vault first (no PIN)
              try {
                await initAuth();
                if (authStatus() === 'ready') return;
              } catch { /* encrypted vault — need PIN */ }
              // Vault is encrypted — show PIN unlock
              setShowUnlock(true);
            }}>
            {t('wallet_reconnect')}
          </button>
          </Show>

          {/* PIN unlock form */}
          <Show when={showUnlock()}>
            <div class="wallet-unlock-form">
              <label class="pin-label">{t('lock_enter_pin')}</label>
              <input
                ref={(el: HTMLInputElement) => setTimeout(() => el?.focus(), 50)}
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={20}
                value={unlockPin()}
                onInput={(e) => setUnlockPin(e.currentTarget.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') handleUnlock(); }}
                placeholder="------"
                class="pin-input"
                disabled={unlockLoading()}
              />
              <Show when={unlockError()}>
                <p class="lock-error">{unlockError()}</p>
              </Show>
              <button
                class="wallet-btn primary"
                onClick={handleUnlock}
                disabled={unlockLoading() || unlockPin().length < 6}
              >
                {unlockLoading() ? '...' : t('lock_unlock')}
              </button>
            </div>
          </Show>
        </section>
      </Show>

      {/* No wallet at all */}
      <Show when={authStatus() === 'none' && vaultChecked() && !vaultHasKey()}>
        <section class="wallet-section">
          <h3>{t('wallet_create')}</h3>
          <p class="wallet-desc">Generate a new Ed25519 keypair for signing messages.</p>
          <button class="wallet-btn primary" onClick={handleGenerate}>
            {t('wallet_create')}
          </button>
        </section>

        <section class="wallet-section">
          <h3>{t('wallet_import')}</h3>
          <input
            type="password"
            class="wallet-input"
            placeholder="64-character hex private key"
            value={importKey()}
            onInput={(e) => setImportKey(e.currentTarget.value)}
          />
          <button class="wallet-btn" onClick={handleImport}>
            {t('wallet_import')}
          </button>
        </section>
      </Show>

      {/* Wallet connected */}
      <Show when={authStatus() === 'ready'}>
        <section class="wallet-section">
          <h3>{t('wallet_address')}</h3>
          <div class="wallet-address-row">
            <code class="wallet-address">{walletAddress()}</code>
            <button class="wallet-btn-sm" onClick={copyAddress} title="Copy">
              📋
            </button>
          </div>
          <p class="wallet-source">Built-in Wallet</p>
        </section>

        {/* On-chain registration */}
        <section class="wallet-section">
          <h3>{t('onchain_register')}</h3>
          <Show
            when={!isRegistered()}
            fallback={
              <div class="wallet-registered">
                <span class="check-icon">✓</span> {t('wallet_registered')}
              </div>
            }
          >
            <p class="wallet-desc">{t('wallet_register_description')}</p>
            <button
              class="wallet-btn primary"
              onClick={handleRegister}
              disabled={txPending()}
            >
              {t('wallet_register')}
            </button>
          </Show>
        </section>

        {/* Device Delegation */}
        <section class="wallet-section">
          <h3>{t('wallet_delegation')}</h3>
          <button
            class="wallet-btn"
            onClick={() => setShowDelegation(!showDelegation())}
          >
            {showDelegation() ? t('done') : t('wallet_delegate_device')}
          </button>

          <Show when={showDelegation()}>
            <div class="delegation-form">
              <h4>{t('wallet_delegate_device')}</h4>
              <input
                type="text"
                class="wallet-input"
                placeholder="Device public key (64 hex chars)"
                value={delegateKeyInput()}
                onInput={(e) => setDelegateKeyInput(e.currentTarget.value)}
              />
              <div class="permission-checkboxes">
                <label>
                  <input
                    type="checkbox"
                    checked={(delegatePermissions() & 0x01) !== 0}
                    onChange={(e) => {
                      const p = delegatePermissions();
                      setDelegatePermissions(e.currentTarget.checked ? p | 0x01 : p & ~0x01);
                    }}
                  />
                  Messages
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={(delegatePermissions() & 0x02) !== 0}
                    onChange={(e) => {
                      const p = delegatePermissions();
                      setDelegatePermissions(e.currentTarget.checked ? p | 0x02 : p & ~0x02);
                    }}
                  />
                  Channels
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={(delegatePermissions() & 0x04) !== 0}
                    onChange={(e) => {
                      const p = delegatePermissions();
                      setDelegatePermissions(e.currentTarget.checked ? p | 0x04 : p & ~0x04);
                    }}
                  />
                  Profile
                </label>
              </div>
              <button
                class="wallet-btn primary"
                onClick={handleDelegate}
                disabled={txPending() || delegateKeyInput().trim().length !== 64}
              >
                {t('wallet_delegate_device')}
              </button>

              <h4 style="margin-top: var(--spacing-md)">{t('wallet_revoke_device')}</h4>
              <input
                type="text"
                class="wallet-input"
                placeholder="Device public key to revoke"
                value={revokeKeyInput()}
                onInput={(e) => setRevokeKeyInput(e.currentTarget.value)}
              />
              <button
                class="wallet-btn danger"
                onClick={handleRevoke}
                disabled={txPending() || revokeKeyInput().trim().length !== 64}
              >
                {t('wallet_revoke_device')}
              </button>
            </div>
          </Show>
        </section>

        {/* Export / Disconnect */}
        <section class="wallet-section">
          <button
            class="wallet-btn warning"
            onClick={async () => {
              if (showExport()) {
                clearExportedKey();
              } else {
                const key = await vaultExportKey();
                setExportedKey(key ?? '');
                setShowExport(true);
                // Auto-clear after 30 seconds for security
                if (exportClearTimer) clearTimeout(exportClearTimer);
                exportClearTimer = setTimeout(clearExportedKey, 30_000);
              }
            }}
          >
            {showExport() ? t('done') : t('wallet_reveal_key')}
          </button>
          <Show when={showExport()}>
            <div class="wallet-export-warning">
              <p>{t('wallet_reveal_warning')}</p>
              <p class="wallet-export-timer">{t('wallet_auto_hide') || 'Auto-hides in 30 seconds'}</p>
              <code class="wallet-key">{exportedKey() || t('wallet_passphrase_hint')}</code>
            </div>
          </Show>

          {/* Disconnect with confirmation */}
          <Show when={!showDisconnectConfirm()}>
            <button class="wallet-btn danger" onClick={handleDisconnect}>
              {t('wallet_disconnect')}
            </button>
          </Show>
          <Show when={showDisconnectConfirm()}>
            <div class="wallet-disconnect-confirm">
              <p class="wallet-disconnect-warning">{t('wallet_disconnect_confirm') || 'This will permanently delete your wallet. Make sure you have backed up your private key!'}</p>
              <div class="wallet-disconnect-actions">
                <button class="wallet-btn danger" onClick={handleDisconnect}>
                  {t('wallet_disconnect_yes') || 'Yes, Delete Wallet'}
                </button>
                <button class="wallet-btn" onClick={() => setShowDisconnectConfirm(false)}>
                  {t('cancel')}
                </button>
              </div>
            </div>
          </Show>
        </section>
      </Show>

      <style>{`
        .wallet-view { padding: var(--spacing-lg); overflow-y: auto; height: 100%; max-width: 600px; }
        .wallet-view h2 { font-size: var(--font-size-xl); margin-bottom: var(--spacing-lg); }
        .wallet-section { margin-bottom: var(--spacing-lg); padding-bottom: var(--spacing-lg); border-bottom: 1px solid var(--color-border); }
        .wallet-section h3 { font-size: var(--font-size-sm); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--spacing-sm); }
        .wallet-desc { font-size: var(--font-size-sm); color: var(--color-text-secondary); margin-bottom: var(--spacing-sm); }
        .wallet-input { width: 100%; padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-tertiary); color: var(--color-text-primary); font-family: monospace; font-size: var(--font-size-sm); margin-bottom: var(--spacing-sm); }
        .wallet-btn { padding: var(--spacing-sm) var(--spacing-lg); border-radius: var(--radius-md); font-weight: 600; font-size: var(--font-size-sm); background: var(--color-bg-tertiary); color: var(--color-text-primary); margin-right: var(--spacing-sm); margin-bottom: var(--spacing-sm); }
        .wallet-btn:hover { opacity: 0.85; }
        .wallet-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .wallet-btn.primary { background: var(--color-accent-primary); color: var(--color-text-inverse); }
        .wallet-btn.warning { background: var(--color-warning); color: #1a1a1a; }
        .wallet-btn.danger { background: var(--color-error); color: white; }
        .wallet-btn-sm { padding: var(--spacing-xs); border-radius: var(--radius-sm); font-size: var(--font-size-sm); }
        .wallet-btn-sm:hover { background: var(--color-bg-tertiary); }
        .wallet-address-row { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-xs); }
        .wallet-address { font-size: var(--font-size-xs); white-space: nowrap; color: var(--color-accent-primary); }
        .wallet-source { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
        .wallet-registered { display: flex; align-items: center; gap: var(--spacing-xs); color: var(--color-success); font-weight: 600; font-size: var(--font-size-sm); }
        .check-icon { font-size: var(--font-size-lg); }
        .wallet-error { padding: var(--spacing-sm) var(--spacing-md); background: var(--color-error); color: white; border-radius: var(--radius-md); font-size: var(--font-size-sm); margin-bottom: var(--spacing-md); }
        .wallet-success { padding: var(--spacing-sm) var(--spacing-md); background: var(--color-success); color: white; border-radius: var(--radius-md); font-size: var(--font-size-sm); margin-bottom: var(--spacing-md); }
        .wallet-pending { padding: var(--spacing-sm) var(--spacing-md); background: var(--color-warning); color: #1a1a1a; border-radius: var(--radius-md); font-size: var(--font-size-sm); margin-bottom: var(--spacing-md); }
        .wallet-export-warning { margin-top: var(--spacing-sm); padding: var(--spacing-md); background: var(--color-bg-tertiary); border: 1px solid var(--color-warning); border-radius: var(--radius-md); }
        .wallet-export-warning p { font-size: var(--font-size-sm); color: var(--color-warning); margin-bottom: var(--spacing-sm); }
        .wallet-key { font-size: var(--font-size-sm); word-break: break-all; display: block; }
        .delegation-form { margin-top: var(--spacing-md); padding: var(--spacing-md); background: var(--color-bg-tertiary); border-radius: var(--radius-md); }
        .delegation-form h4 { font-size: var(--font-size-sm); margin-bottom: var(--spacing-sm); }
        .permission-checkboxes { display: flex; gap: var(--spacing-md); margin-bottom: var(--spacing-sm); font-size: var(--font-size-sm); }
        .permission-checkboxes label { display: flex; align-items: center; gap: var(--spacing-xs); cursor: pointer; }
        .wallet-export-timer { font-size: var(--font-size-xs); color: var(--color-text-secondary); font-style: italic; }
        .wallet-disconnect-confirm { margin-top: var(--spacing-md); padding: var(--spacing-md); background: rgba(255,118,117,0.1); border: 1px solid var(--color-error); border-radius: var(--radius-md); }
        .wallet-disconnect-warning { font-size: var(--font-size-sm); color: var(--color-error); margin-bottom: var(--spacing-md); line-height: 1.5; font-weight: 500; }
        .wallet-disconnect-actions { display: flex; gap: var(--spacing-sm); }
      `}</style>
    </div>
  );
};
