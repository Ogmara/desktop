# Changelog

All notable changes to the Ogmara desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-29

### Added
- Vault isolation layer — private keys never leave the vault module;
  all signing happens through `vaultGetSigner()` / `vaultSignRequest()`.
  Matches mobile implementation per spec 05-clients.md section 5.5.1.
- OS credential store integration — private keys stored in macOS Keychain,
  Windows Credential Manager, or Linux Secret Service via `keyring` crate.
- PIN code app lock — 6+ digit PIN with PBKDF2-SHA256 (600,000 iterations)
  key derivation and AES-256-GCM encryption of the private key at rest.
- Lock screen UI with PIN entry, error feedback, and escalating cooldown
  after 5+ failed attempts (30s to 600s).
- PIN setup flow — two-step enter/confirm modal, encrypts vault on completion.
- Auto-lock on idle — configurable timeout (default 5 minutes), clears signer
  from memory and shows lock screen.
- Vault migration system — versioned storage format (v1) with integrity checks
  on every app launch. Per spec section 5.5.2.
- Secure store abstraction (`secureStore.ts`) wrapping Tauri keyring commands,
  API-compatible with the mobile expo-secure-store interface.
- Settings security section — wallet address display, app lock toggle, and
  unprotected wallet warning per spec section 5.6.3.
- i18n strings for all vault/lock UI in English and German.

### Security
- Private keys encrypted at rest with PIN-derived AES-256-GCM key
- Keys stored in OS credential store (not filesystem)
- Escalating cooldown on failed PIN attempts prevents brute force
- Vault wipes signer from memory on lock/timeout
- Key format validation (64-char hex) before storage

## [0.1.0] - 2026-03-29

### Added
- Tauri v2 desktop application wrapping the SolidJS frontend
- System tray with Show/Quit menu and click-to-show
- Native OS notifications via tauri-plugin-notification
- Tauri commands: get_version, get_platform, send_notification
- Window draggable toolbar region
- Dark theme default with light/system support
- i18n support (EN, DE — expandable to all 6 languages)
- Concept-3 monogram logo in toolbar and window icon
- Version and platform display in settings view
- Status bar with connection indicator
- Bundle configuration for Linux (deb), macOS (dmg), Windows (msi)
