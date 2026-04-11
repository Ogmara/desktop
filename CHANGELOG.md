# Changelog

All notable changes to the Ogmara desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.15.1] - 2026-04-11

### Fixed
- **Duplicate messages in chat** — the 15-second poll fallback was fetching
  messages already delivered by WebSocket, causing duplicates due to msg_id
  format differences (byte array vs hex string). Poll now only runs when
  WebSocket is disconnected. Also normalized all msg_id comparisons to
  lowercase hex and added belt-and-suspenders dedup in the allMessages memo.

## [1.15.0] - 2026-04-10

### Added
- **Tray badge with unread count** — system tray icon now shows a numbered
  badge (dark circle with white text) when there are unread messages, DMs,
  or notifications. Badge is rendered via canvas onto the icon image since
  Linux/Windows tray icons have no native badge API.
- **App restore from tray** — when the app is restored from the system tray
  after being minimized, WebSocket reconnects automatically and unread counts
  refresh immediately. No more frozen UI after long minimize periods.
- **Image lightbox** — clicking any image in chat opens it fullscreen at
  original size. Close with Escape, clicking the overlay, or the X button.
- **Wallet reset** — new "Reset Wallet" button on the wallet page when PIN
  unlock fails (e.g., corrupted PIN data). Wipes the encrypted vault so the
  user can re-import their private key. Requires confirmation.
- i18n translations for wallet reset in all 7 languages.

### Fixed
- **Duplicate messages in chat** — messages from WebSocket and poll were added
  to localMessages without checking if they already existed in the API resource.
  Now both handlers check against API messages before adding.
- **Context menu clipped by sidebar** — right-click menus on channels/members
  were hidden behind the sidebar's `overflow-y: auto`. Now rendered via SolidJS
  `<Portal>` directly on document.body.
- **PIN removal error** — "must be an instance of CryptoKey" caused by webkit2gtk
  rejecting `Uint8Array.buffer` (ArrayBufferLike). Fixed with `.buffer.slice()`
  to create clean ArrayBuffer instances for SubtleCrypto operations.
- **Tray label on Linux** — removed tray `title` that some DEs displayed as
  text below the icon. Tooltip set to "Ogmara Desktop".

## [1.14.0] - 2026-04-06

### Added
- **Design style system** — four selectable visual themes: Glassmorphism (default),
  Elevated Cards, Clean Minimal, and Classic (original). Each style changes the
  visual language (border-radius, shadows, effects, depth) independently from
  the light/dark color theme.
- **Glassmorphism style** — frosted glass panels with `backdrop-filter: blur()`,
  animated gradient background blobs, glow accents on buttons and badges.
- **Elevated Cards style** — layered drop shadows for depth hierarchy, bold
  gradient buttons, cards lift on hover, accent left-border on active sidebar items.
- **Clean Minimal style** — pill-shaped navigation and badges, asymmetric message
  bubble corners (Signal/Telegram-inspired), date separators as centered pills,
  round send button, thinner scrollbars.
- **Classic style** — preserves the original flat design for users who prefer it.
- Design style picker in Settings with visual preview thumbnails for each style.
- Light theme adjustments for all design styles (glass tints, shadow weights,
  bubble colors adapt to light mode).
- i18n translations for design style names in all 7 languages.

## [1.13.1] - 2026-04-06

### Fixed
- New users no longer see all public channels on first load — only the default
  "ogmara" channel is shown. Other channels appear after joining via Search.
- Anonymous users can now join and view public channels without connecting a
  wallet. Only private channels require authentication.

## [1.13.0] - 2026-04-05

### Added
- **Clipboard paste for images** — screenshots pasted into chat are now uploaded
  via Tauri clipboard plugin (`tauri-plugin-clipboard-manager`). Webkit2gtk
  doesn't support web clipboard API, so RGBA pixels are read via plugin,
  converted to PNG via canvas, then uploaded to IPFS.
- **Native file export** — account data export uses Rust-side HTTP fetch (`ureq`)
  and native save dialog (`tauri-plugin-dialog`). Bypasses Tauri HTTP plugin
  limitations with large response bodies and webkit2gtk blob URL restrictions.
- **SVG inline rendering** — SVG images now display inline in chat messages
  (rendered via safe `<img>` tag, no script execution).
- **Cross-platform URL opening** — `open_url` Rust command supports Linux
  (`xdg-open`), macOS (`open`), and Windows (`cmd /C start`).

### Fixed
- **Transaction nonce errors** — Klever API returns lowercase `nonce` field,
  code was reading PascalCase `Nonce` (silently defaulting to 0). Now checks
  both casings. Added local nonce cache for consecutive TXs within the 4-second
  API indexing window.
- **File uploads failing** — Tauri HTTP plugin can't serialize `Blob`/`File` in
  `FormData`. Global fetch override now manually builds multipart body as raw
  `Uint8Array` for FormData requests.
- **Images not showing inline after send** — optimistic messages now carry
  `_attachments` so uploaded images render immediately without re-entering
  the channel.
- **Chat FOUC on channel open** — messages container hidden (`opacity: 0`)
  until initial layout and scroll position are set, preventing flash of
  left-aligned messages before own-message styling applies.
- **Scroll to latest on channel open** — improved scroll timing with double
  rAF + dual timeouts for reliable positioning in webkit2gtk.
- **Data export error** — "The string did not match the expected pattern" from
  webkit2gtk rejecting blob URLs and Tauri HTTP plugin failing on large
  response bodies. Replaced with Rust-native HTTP fetch + file write.
- **Explorer links not opening** — replaced `<a target="_blank">` (dead on
  webkit2gtk) with Rust `open_url` command using system browser.
- **TX confirmation colors** — success/error messages in send dialog now use
  theme-aware colors instead of hard-coded backgrounds.

## [1.12.0] - 2026-04-05

### Added
- **Token Portfolio page** — new "Wallet" sidebar menu showing all token balances
  (KLV + all KDA tokens) with token logos, names, and precision-aware formatting.
  Fetches balances from Klever API, displays frozen amounts, and links to
  Kleverscan explorer for each asset.
- **Send tokens** — modal dialog to transfer any token (KLV or KDA) to another
  klv1... address. Includes MAX button, input validation (invalid address,
  self-send, insufficient balance, zero amount), and explorer link for
  the broadcast transaction.
- **Token metadata resolution** — automatically fetches token name and logo from
  Klever API for non-KLV assets. Displays placeholder icon with first letter
  when logo is unavailable.
- **Open URLs in system browser** — custom Rust command using `xdg-open` for
  reliable external link opening on Linux (Tauri shell plugin doesn't work
  reliably on webkit2gtk).
- **i18n** — 21 new translation keys across all 7 languages (EN, DE, ES, PT,
  JA, ZH, RU) for wallet portfolio, send dialog, and validation messages.

### Fixed
- **Transaction nonce error** — Klever API returns lowercase `nonce` field but
  code read PascalCase `Nonce`, silently falling back to 0. Now checks both
  casings. Also tracks locally used nonces to handle consecutive TXs within
  the 4-second API indexing window.
- **Explorer links not opening** — `target="_blank"` and Tauri shell plugin
  silently fail on Linux/webkit2gtk. Replaced with custom `open_url` Rust
  command that calls `xdg-open` directly.
- **TX confirmation unreadable colors** — success/error messages in send dialog
  now use theme-aware colors (`--color-bg-tertiary` background with colored
  border) instead of hard-coded green/red backgrounds.

### Security
- **Amount precision** — token amounts parsed via string math (no float
  multiplication) to prevent precision loss on large balances
- **Address validation** — full bech32 regex `/^klv1[a-z0-9]{58}$/`
- **Logo URL sanitization** — only `https://` URLs rendered, prevents tracking
- **Unicode spoofing prevention** — control chars and RTL overrides stripped
  from token names
- **URL path injection** — `encodeURIComponent` on all API-sourced URL segments

## [1.11.0] - 2026-04-05

### Fixed
- **On-chain TX signing working** — discovered the correct Klever signing flow:
  1. Build TX via `/transaction/send` (flat contract format with `contractType`)
  2. Get hash via `/transaction/decode`
  3. Sign hex-decoded raw hash bytes (32 bytes) with raw Ed25519 (NOT UTF-8 string, NOT Klever message prefix)
  4. Broadcast with base64-encoded signature in PascalCase `Signature` field
- **Verified badge updates immediately** — profile cache is invalidated after
  on-chain registration so the checkmark appears without restart
- Removed debug output from TX error messages
- User-friendly TX error messages with i18n in all 7 languages (insufficient
  balance, no account, nonce error, signature error, SC error)

## [1.10.0] - 2026-04-05

### Fixed
- **Wallet not connecting after PIN unlock** — `vaultInit()` returned null for
  encrypted vaults even when the signer was already loaded by
  `vaultUnlockWithPin()`. Now checks for cached signer first.
- **Reconnect button on Wallet page** — shows inline PIN input for encrypted
  vaults. Falls back to raw `initAuth()` first, then PIN prompt if encrypted.
- **Missing translations** — added `wallet_existing`, `wallet_existing_desc`,
  `wallet_reconnect` to all 7 languages. Updated `pin_setup_desc` to clarify
  6 is the minimum, not max.
- **Select dropdown white on Linux** — added `appearance: none` with custom
  SVG chevron to override webkit2gtk native select styling.

## [1.9.0] - 2026-04-05

### Changed
- **Replaced OS keyring with file-based secure store** — the `keyring` crate
  (gnome-keyring/kwallet) on Linux is often session-scoped and doesn't persist
  across reboots or when the secret service daemon isn't running. Vault data is
  now stored in `~/.local/share/org.ogmara.desktop/.secure-store.json`. When
  PIN is enabled, the private key is still encrypted with AES-256-GCM — the
  file just stores the encrypted ciphertext, not raw keys.
- Replaced `keyring` crate dependency with `dirs` crate for app data paths

### Fixed
- **Wallet page shows "Reconnect" option** — added loading state so the vault
  check completes before showing create/import. Previously the async check
  started as `false` and the create section rendered immediately.
- **PIN setup auto-focus** — cursor now moves to the confirm input automatically
- **PIN encryption verification** — retries read-back with delays, falls back
  to in-memory verification if keyring/file store reads are delayed
- Missing `settings_wallet_warning` translation in all 7 languages

## [1.8.0] - 2026-04-05

### Added
- **PIN setup prompt after wallet creation** — when a wallet is created or
  imported, a modal recommends setting up a PIN for security. User can set up
  PIN immediately or decline with "Maybe Later".
- **Security section in Settings** — users who declined the initial PIN prompt
  can set up a PIN anytime from Settings > Security. Shows:
  - PIN enable/disable toggle with current status
  - Auto-lock timeout selector (1 min to 1 hour)
  - Remove PIN option (requires current PIN)
  - Warning when PIN is not set

### Security
- Unprotected wallet warning displayed in Settings when no PIN is set
- PIN removal requires entering the current PIN (prevents unauthorized changes)

## [1.7.0] - 2026-04-05

### Fixed
- **Wallet not reconnecting after restart** — if localStorage was cleared
  (Tauri dev restart, cache clear) but the OS keyring still had the private
  key, the app showed "Create Wallet" instead of connecting. Now treats the
  OS keyring as source of truth: if a key exists, it's automatically
  recognized as a built-in wallet and localStorage settings are restored.

## [1.6.0] - 2026-04-05

### Fixed
- **Duplicate messages in chat** — `localMessages` was not cleared when
  navigating away and back to the same channel. Now always cleared when the
  channel resource fetcher runs, preventing stale WS/poll messages from
  duplicating with fresh API results.
- **Horizontal overflow on long messages** — added `overflow-wrap: break-word`
  and `word-break: break-word` to message bubbles. Long addresses and URLs
  now wrap instead of expanding the chat area horizontally. Also added
  `overflow-x: hidden` to the messages container.
- **Scroll to last-read position** — improved initial scroll timing for
  Tauri/webkit2gtk using double `requestAnimationFrame` + `setTimeout` to
  ensure DOM is fully rendered before scrolling to the unread divider.
- **@noble/ed25519 async API not found** — stale system-level `~/node_modules`
  had v1.x without `getPublicKeyAsync`/`signAsync`. Fixed with Vite
  `resolve.alias` to pin the correct v2.3.0 from local `node_modules`.

## [1.5.0] - 2026-04-05

### Fixed
- **Window dragging** — `data-tauri-drag-region` CSS attribute doesn't work on
  Linux/webkit2gtk. Replaced with explicit `getCurrentWindow().startDragging()`
  API call on a dedicated drag handle div.
- **Window controls (minimize/maximize/close) not working** — missing Tauri
  capability permissions (`core:window:allow-close`, `allow-minimize`,
  `allow-toggle-maximize`, `allow-start-dragging`, etc.). All window API calls
  were silently denied without these.
- **Dynamic imports replaced with static** — `await import('@tauri-apps/api/window')`
  was unreliable in Tauri's webview. Now uses static `import { getCurrentWindow }`
  called once at module load.
- **Window state plugin no longer overrides decorations** — excluded `DECORATIONS`
  and `FULLSCREEN` from save/restore flags so the custom title bar is always used.

## [1.4.0] - 2026-04-05

### Added
- **Custom frameless window** — removed OS window decorations (`decorations: false`),
  replaced with custom title bar matching the app's dark theme. Window controls
  (minimize, maximize, close) integrated into the toolbar with hover effects.
  Close button highlights red on hover (Windows-style convention).
- **Ogmara logo in title bar** — SVG monogram icon next to the brand name
- **Double-click title bar to maximize** — standard desktop behavior via
  `data-tauri-drag-region`

### Changed
- Toolbar height reduced from 48px to 40px for a tighter, more native feel
- Window control buttons use the app's color scheme instead of OS chrome

## [1.3.0] - 2026-04-05

### Fixed
- **Window position restored on tray restore** — saves position in a Mutex
  before hiding to tray, restores it explicitly on show. Linux window managers
  don't always preserve position for hidden windows.
- **Tray icon visible on Linux** — set icon explicitly via `TrayIconBuilder`
  using the app's default window icon. Previous config relied on `tauri.conf.json`
  path which Linux doesn't always pick up.
- **Fetch override scoped to external URLs only** — the v1.2.0 global fetch
  override broke internal resource loading (blank white page). Now only routes
  `https://` URLs through Tauri's HTTP plugin; local requests use native fetch.

## [1.2.0] - 2026-04-05

### Fixed
- **News feed loading** — root cause was CORS: Tauri's webview origin is not
  allowed by the L2 node's CORS policy. Fixed by adding `tauri-plugin-http`
  which overrides global `fetch` with a system-level HTTP client that bypasses
  webview CORS restrictions. All API calls now go through the Tauri backend.
- **Window state persistence** — the close-to-tray handler prevented the window
  from actually closing, so the window-state plugin never saved. Now explicitly
  calls `save_window_state()` before hiding to tray.

### Added
- `tauri-plugin-http` dependency (Rust + JS) for CORS-free HTTP requests
- HTTP permissions in Tauri capabilities for `https://*` and `http://localhost:*`

## [1.1.0] - 2026-04-05

### Changed
- Removed duplicate Chat/News/Messages navigation from toolbar header (already
  in sidebar — cleaner standalone desktop look)
- Renamed "News" to "News Feed" in sidebar navigation
- Fixed form controls (select, input) to match dark/light theme — native
  dropdowns no longer render with white background
- Permissive CSP for initial release — tighten after confirming all connections
  work across environments
- System tray icon: disabled `iconAsTemplate` (macOS-only), use 32x32 icon
  for Linux visibility
- Window state plugin: persist position, size, and maximized state with
  `StateFlags::all()`
- Added window-state permissions to Tauri capabilities

### Fixed
- News feed: added visible error state and loading indicator for debugging
- WebSocket now starts even without a wallet (was skipped in no-wallet path)
- Added error logging to news feed API calls

## [1.0.0] - 2026-04-05

### Added
- **Full feature parity with web app** — all 16 views, 10 components, complete
  chat, news, DMs, channels, profiles, search, bookmarks, notifications
- **Standalone Klever wallet** — built-in transaction building, signing, and
  broadcasting. No browser extension or K5 wallet needed. Supports: user
  registration, channel creation, tipping, device delegation, governance voting
- **Hash-based router** — full navigation with 16+ routes matching the web app
- **Theme customization** — dark/light/system + custom accent, background, and
  text colors via color pickers in Settings
- **Native desktop notifications** — triggered from WebSocket events (mentions,
  DMs, replies) via Tauri notification plugin
- **7 languages** — EN, DE, ES, PT, JA, ZH, RU (274 translation keys each)
- **Complete SDK integration** — OgmaraClient API, WebSocket real-time messaging,
  MessagePack payload decoding, profile caching, settings sync
- **Channel features** — create (on-chain + private), join, settings, admin,
  moderator management, member lists, pinned messages
- **News features** — feed, compose, reactions, reposts, bookmarks, tipping,
  comments, hashtag search
- **DM features** — conversation list, threaded messages, media attachments
- **User profiles** — display name, bio, avatar upload, follow/unfollow,
  on-chain verification badge
- **Media upload** — IPFS-based file attachments with thumbnails
- **Node management** — node selector with ping measurements, anchor badges,
  custom node URL, failover support
- **Settings sync** — encrypted upload/download of settings via L2 node (HKDF +
  AES-256-GCM)
- **Account data export** — JSON download of all user data

### Changed
- Upgraded from placeholder views to full functional UI
- Auth module expanded with `AuthStatus`, `isRegistered`, `checkRegistrationStatus`
- i18n upgraded from 50 inline keys (3 languages) to 274 keys (7 languages) with
  separate locale JSON files
- CSS redesigned with full design token system (spacing, fonts, radii, colors)

### Security
- Standalone wallet never exposes private keys — all signing happens through
  vault's WalletSigner
- On-chain operations use the same Ed25519 + Keccak-256 signing as the Klever
  ecosystem
- CSP expanded to allow connections to Klever APIs and IPFS gateways while
  maintaining security boundaries

## [0.6.0] - 2026-04-01

### Added
- **Auth module with device-to-wallet identity mapping** (Phase 8) — new
  `lib/auth.ts` with Solid.js signals for wallet state. Supports built-in wallet
  and Klever Extension connection with L2 device registration. Claim signed via
  extension, submitted to node, cached in localStorage. `deviceMappingFailed`
  signal for UI error feedback. `walletAddress` restored from localStorage on
  app startup.

## [0.5.0] - 2026-03-31

### Added

- **i18n** — Russian language (Русский) with all 50 translation keys (navigation, lock screen, PIN setup, settings, wallet, engagement, channel admin, node selection)

## [0.4.0] - 2026-03-30

### Added
- **Message Formatting** — i18n keys for node selection and custom node input
- **Default Node** — changed from localhost to node.ogmara.org
- **Node Selection** — i18n keys for node selector UI (en + de)

## [0.3.0] - 2026-03-30

### Added
- **Bookmarks View** — new navigation tab for saved posts
- **News Engagement** — reaction emoji hints, repost and bookmark labels in news placeholder
- **i18n** — 15+ new keys for engagement/admin features in both English and German
- **Channel Admin** — i18n keys for members, pins, moderators, kick, ban, invite

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
