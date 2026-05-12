# Changelog

All notable changes to the Ogmara desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.18.2] - 2026-05-13

### Fixed
- **Empty sidebar after fresh install / cleared app data.** The
  joined-channel filter is stored as `ogmara_joined_channels` and gates
  which channels appear in the sidebar list. The first-time migration
  only seeded the default `ogmara` channel — networks without that
  channel ended up with a permanently empty sidebar even though the API
  returned a full catalog. Direct navigation to `/chat/<id>` still
  worked because routing isn't gated by the filter. Fix: on the first
  migration after install / storage clear, seed the joined set with
  every channel the API returns. Subsequent syncs continue to
  auto-add private channels only.

## [1.18.1] - 2026-05-12

### Fixed
- **Channel-type dropdown unreadable in Linux Tauri build.** The native
  `<select>` element in the "Create Channel" form was being rendered by
  WebKitGTK with system colors (white background + grey text) instead
  of the form's `--color-bg-tertiary` + primary-text tokens, making the
  selected option illegible in dark mode. Strip native chrome with
  `appearance: none` and paint our own SVG chevron so the field matches
  the rest of the form. Style `<option>` for the dropdown popup too —
  honoured by most webviews (the popup panel is OS-controlled but
  background/color usually apply).

## [1.18.0] - 2026-05-12

### Added
- **Highlighted message bubbles for @-mentions.** Chat messages whose
  payload `mentions[]` contains the viewer's wallet address now render
  with a strongly tinted accent background, a thicker accent border, a
  3-px accent stripe on the left (via `::before`), and a soft outer
  glow shadow — unmistakable even when the bubble sits flush with the
  avatar column. Classic mode also gets a left-border accent stripe. A
  hover tooltip (`You were mentioned`) labels the highlight. Skips own
  messages, deleted/muted messages, and unauthenticated views.
  Light/dark-theme aware via `color-mix()` over existing CSS tokens.
- **Inline `@username` mentions colorized.** `FormattedText` now
  matches `@klv1<bech32>` and `@<DisplayName>` tokens in message
  content alongside hashtags, rendering each as an accent-tinted pill.
  `@klv1…` pills are clickable (navigate to user profile);
  display-name pills are visual-only because the resolved address
  isn't recoverable from the text alone — the canonical address lives
  in `payload.mentions[]`. Picks up automatically inside chat
  messages, news posts, and comments.
- **Sidebar `@` indicator on channels with unread mentions.** The
  channel list (Classic and Modern) shows a small amber `@` badge
  next to the unread count for any channel that contains at least
  one unread message in which the viewer was @-mentioned. Counts
  come from `getUnreadCounts().mentions` (l2-node ≥ v0.33.0); older
  nodes simply show no indicator.
- **Share links for news posts and chat messages.**
  - News post **Share button** in the detail-view action bar and a
    small 🔗 share icon on each news feed card. Copies
    `https://ogmara.org/app/#/news/<msg_id>` to clipboard.
  - Chat message **"Copy link to message"** entry in the right-click
    context menu. Copies
    `https://ogmara.org/app/#/chat/<channel_id>?msg=<msg_id>`.
  - **Deep-link consumer in `ChatView`.** When the URL carries
    `?msg=<hex>`, scrolls to and momentarily highlights the target
    message. Auto-paginates older history up to 3 times if the
    message isn't on the initial page before falling back to a
    "Message not found" toast.
  - Share base is hardcoded to `https://ogmara.org/app` so recipients
    get a working URL — Tauri's own `tauri://` origin is unshareable.
  - Uses the webview's `navigator.clipboard.writeText` with a
    `document.execCommand('copy')` fallback.

### Changed
- `lib/payload.ts` exposes a new `getPayloadMentions(payload)` helper
  shared by ChatView's mention-highlight check.
- `i18n` keys added to all 7 locales (EN / DE / ES / PT / JA / ZH / RU):
  `share`, `share_news_link`, `share_message_link`, `share_link_copied`,
  `share_link_failed`, `share_link_unavailable`, `chat_mention_you`,
  `sidebar_mentioned_here`.

## [1.17.3] - 2026-05-11

### Fixed
- **Regression from v1.17.2: opening a sidebar context menu in Modern
  broke the main window layout.** When v1.17.2 moved the menus out of
  the classic-fallback `<aside>` into a shared helper, it didn't move
  the `.channel-context-menu` / `.context-menu-item` CSS rules — those
  still lived inside the classic aside's `<style>` block, which never
  renders in Modern. With no `position: fixed` and no `display: block`
  on items, the menu became a flex child of `.app-body`, consumed
  layout space, and pushed the main content into a narrow column on
  the right with the menu items strung horizontally across the top.
  Co-located the needed CSS rules inside `sharedContextMenus()` via
  an inline `<style>` so they always apply, regardless of which style
  is active.

## [1.17.2] - 2026-05-11

### Fixed
- **Modern sidebar: right-click context menu missing.** The two `<Show>`
  blocks rendering the channel menu (mark-read / settings / leave /
  delete) and the member menu (profile / kick / ban / promote / demote)
  lived inside the *classic* fallback `<aside>` in `Sidebar.tsx`, so the
  Modern style wired up the `onContextMenu` handler but no menu UI ever
  mounted — leaving Modern users with no way to leave or delete a
  channel, or to moderate members. Extracted both `<Show>` blocks into a
  `sharedContextMenus()` helper rendered at the top level of the
  component, so both styles get them.
- **Optimistic messages render as empty bubbles in public channels.**
  `tryDecodeBase64Payload` in `payload.ts` ran `atob()` on plain text;
  any string using only base64-valid characters (e.g. `"Hello"`)
  succeeds with garbage bytes, the subsequent msgpack decode then fails
  into `{ content: '' }`, and the caller's `?.content ?? payload`
  returned the empty string (because `??` only triggers on
  null/undefined). Users saw a bubble with only a timestamp until they
  left and re-entered the channel. **Fixed** by returning `null` from
  `tryDecodeBase64Payload` when the decode yields no recognizable
  payload fields, so callers fall back to treating the string as the
  literal content.
- **Edit message via right-click silently failed.** A side effect of
  the empty-bubble bug above: `startEdit` prefilled the composer with
  `getPayloadContent(payload)` which returned `''`; clicking Send hit
  `handleEdit`'s `if (!newContent) return` and bailed without any
  user-facing signal. The payload fix resolves the root cause.
  `handleEdit` now also surfaces errors to the existing `sendError`
  banner (and `console.error`) instead of just `console.warn`,
  matching the `handleSend` error pattern.
- **"Copy channel invite link" produced a localhost URL.**
  `ChannelSettingsView` built the join URL from
  `${window.location.origin}/app/#/join/<id>`. In the Tauri shell that
  origin is `http://localhost:1420` (dev) or `tauri://localhost`
  (production), neither of which is shareable. Hardcoded the canonical
  public host `https://ogmara.org` for the desktop build so the same
  URL works for any recipient.

## [1.17.1] - 2026-05-07

### Fixed
- **CI builds for macOS / Windows / Linux installers were failing on
  every tag since v1.16.0** with `npm ci` rejecting the lockfile:
  `lock file's postcss@8.5.8 does not satisfy postcss@8.5.14`. The
  `package.json` `overrides` block correctly pinned `postcss >=8.5.10`,
  but `package-lock.json` was never regenerated, so the strict `npm ci`
  in the GitHub Actions workflow rejected the mismatch and aborted
  before any build started. Lockfile regenerated; v1.17.0's features
  ship as v1.17.1 since v1.17.0 produced no installers.

## [1.17.0] - 2026-05-07

### Changed
- **Dynamic, unread-aware message loading** — channels no longer fetch
  a fixed 200 messages on every switch. Initial fetch is `clamp(50,
  unreadCount + 20, 200)`, so a channel with 120 unread messages
  loads 140 (all unread plus 20 lines of context above the divider),
  while a quiet channel loads only 50. Older history is fetched on
  scroll-to-top in 50-message pages, with viewport position
  preserved across the prepend so the user stays anchored. Eliminates
  the multi-second freeze on rapid channel switching, especially in
  high-traffic channels.

### Performance
- **Cancel in-flight fetches on channel switch** — the messages
  resource now wires an `AbortController` so requests for a previous
  channel are aborted when the user clicks a new one. Prevents
  out-of-order state updates and reduces wasted network/CPU.
- **Cache per-channel role lookup** — `getChannelMembers({limit:200})`
  was firing on every channel open just to determine the viewer's
  role for permission gating. Now cached in-memory for 30 s keyed by
  `channelId+walletAddress`. Removes one full-fan-out request per
  switch on cache hit.
- **Break the profile-resolver feedback loop** — the effect that
  resolves author profiles read `profiles().has(addr)` and also
  called `setProfiles()` from inside its own `.then()` handler,
  causing the effect to re-run on every individual resolution
  — O(N²) on author count per channel switch. The read is now
  wrapped in `untrack()` so the effect only re-runs when
  `allMessages()` changes.
- **Defer `markChannelRead` to a microtask** — the read marker no
  longer shares a frame with the channel-switch click handler.
- Incremental poll fetch trimmed from 200 → 50 messages.

## [1.16.1] - 2026-05-07

### Fixed
- **News Feed "New Post" button hidden under window controls** —
  v1.16.0 added the floating window-controls strip in Modern, but only
  the chat / DM / news-detail headers got the 132px right-padding to
  avoid the overlap. The News Feed (`.news-header`) and other
  page-level `<h2>` titles (search, bookmarks, notifications,
  settings, wallet, compose) didn't, so any right-aligned button or
  element on those pages sat under the strip. Extended the CSS rule
  in `App.tsx` to cover all of them.
- **Search results omitted users** — desktop `SearchView` only queried
  `listNews()` and `listChannels()`. Now also calls
  `client.searchUsers(query, 20)` (from `@ogmara/sdk` v0.15.0+) and
  renders a "Users" results section above channels with avatar,
  display name, verified checkmark, and truncated address. Click
  navigates to the user profile page. Skipped for `#hashtag` queries.

## [1.16.0] - 2026-05-06

Modern design refresh + read-only / broadcast channels + `@`-mention
autocomplete + sidebar minimum-width fix. Pairs with `l2-node` v0.32.0,
`@ogmara/sdk` v0.15.0, `@ogmara/sdk-rust` v0.5.0. Brings desktop to
feature parity with web v0.30.0.

### Added (Phase 2 — `@`-mention autocomplete)
- **`MentionPopover` component** (`src/components/MentionPopover.tsx`,
  copied verbatim from web). Telegram-style picker that opens when the
  cursor enters a fresh `@<prefix>` token. 150ms debounced server
  search, 30s in-memory cache, ↑/↓/Enter/Tab/Esc keyboard nav, ARIA
  listbox. On select, replaces `@<prefix>` with `@<DisplayName>` and
  pushes the resolved `klv1...` into `pendingMentions`.
- **Wired into `ChatView` chat composer** — same pattern as web.
  Modern + Legacy textareas share the `inputRef` so a single popover
  serves both. `pendingMentions` merged with raw `@klv1...` regex on
  send.
- **Wired into `NewsDetailView` comment composer** — passes merged
  mentions to `client.postComment(..., { mentions })`.
- **3 new i18n keys** in all 7 locales (en, de, es, pt, ja, zh, ru):
  `mention_no_results`, `mention_popover_label`, `user_verified`.

### Fixed (Bug 1 — sidebar minimum width)
- **`SIDEBAR_MIN_W` bumped 200 → 280** in `components/Sidebar.tsx`. At
  200px the Modern header (`burger + search input + bell`) was so
  cramped that the right pane appeared to overlap the sidebar's
  search bar. 280px matches Telegram desktop's minimum and keeps every
  header control fully visible. Existing users with `ogmara.sidebarWidth=200`
  saved auto-bump to 280 on next load via the existing
  `Math.max(SIDEBAR_MIN_W, …)` guard — no migration needed.

### Fixed (Bug 3 — Modern hides the close-to-tray X)
- **Floating window-controls strip** added in `App.tsx` for Modern
  style. Modern hides the entire Toolbar (which carried the
  minimize/maximize/close buttons in Classic + Glassmorphism), so the
  Tauri window had no way to be minimized to the tray, maximized, or
  closed unless the user invoked the system menu. The new strip
  renders fixed in the top-right corner with the same icons as the
  Toolbar's window-controls block. Hidden below 768px viewport because
  Tauri WebView on mobile doesn't expose a desktop window anyway.
- **Channel-bar right-padding 132px** added in Modern non-mobile so
  the right-pane header's action icons (channel search, dot-menu)
  don't get covered by the floating window-controls strip. Same
  treatment applied to `.dm-header` and `.news-detail-header` for
  consistency. Padding scales with the strip's width (3 buttons × 36px
  + 24px gap).

### Fixed (smoke-test bugs from 2026-05-07 round)
- **`@`-mention popover never opened** — same SolidJS ref-timing bug
  fixed in web v0.30.1. `MentionPopover.textareaRef` is now an
  accessor; `ChatView` and `NewsDetailView` use signal-backed refs
  (`createSignal<HTMLTextAreaElement>()` + `ref={(el) => setRef(el)}`)
  so the popover's effect re-runs once the textarea mounts.
- **Sidebar minimum width** bumped 280 → 360. 320 was an interim value
  that still left the bell button flush against the right divider —
  and because the 1px border between sidebar and right pane is barely
  visible against the similar dark-blue backgrounds, users perceived
  the bell as overlapping into the main pane even when it structurally
  wasn't. 360px gives the bell ~28px of clear space from the divider
  and reads as proper visual separation. Also added 4px extra
  right-padding on `.sidebar-header` so the bell sits inset rather
  than flush.

### Notes
- DM and `ComposeView` (news posts) composers are NOT wired —
  `DirectMessage` payloads are end-to-end encrypted (no plaintext
  mentions field) and `NewsPostPayload` doesn't have a `mentions` field
  per protocol spec §3.5. Those would require a wire-format extension.

### Stage B + C (this commit)

#### Components
- **`src/App.tsx`** — Modern toolbar wrap (`<Show when={!isModernStyle()}>`),
  `.net-bar` slot wired with `isLoading`/`slowLoading` from
  `lib/network-activity`, `bodyClass()` derived signal handling
  `mobile-list-open` / `mobile-detail-open` for the one-pane mobile flow,
  Modern global mobile back button. All vault/lock/PIN/tray flows
  preserved verbatim. `DeviceMappingBanner` deliberately omitted per scope.
- **`src/components/Sidebar.tsx`** — full port of web's Sidebar (1166 lines
  vs prior 828). Tabbed sidebar (Chat/News/Messages), DM preview rows,
  channel avatars, modern member list, theme toggle, disconnect button.
  Tray-badge integration preserved: `pollData` still calls
  `updateTrayBadge(channelTotal + dmTotal + notifCount)` after web's poll
  block. Existing context menus (channel + member) still work via Solid
  signals; Portal wrapping deferred to a follow-up.
- **`src/pages/ChatView.tsx`** — full port (1322 → 1526 lines). Modern
  bubble layout, scroll-to-bottom FAB, channel header strip, floating
  date label, read-only / broadcast banner, posting-mode-aware composer
  hide. The `wsConnected` polling guard from v1.15.1 is preserved. The
  Tauri clipboard plugin paste fallback (webkit2gtk on Linux) is kept on
  both the Legacy and Modern paste handlers.
- **`src/pages/DmConversationView.tsx`** — verbatim port from web (520 →
  540 lines). Modern bubble layout, mobile back button, profile cache.
- **`src/pages/ChannelSettingsView.tsx`** — verbatim port from web (393 →
  817 lines). Channel avatar upload, member list with profiles,
  posting-mode toggle (Public ⇄ ReadPublic, gated on `can_edit_info`,
  hidden for Private channels and until channel_type is loaded). Pairs
  with `l2-node` v0.31.0 and `@ogmara/sdk` v0.14.0.
- **`src/pages/SettingsView.tsx`** — surgical merge: web's color-scheme
  picker + default-landing-view radio + Modern preview added to the
  Appearance section, while desktop's `CustomTheme` overrides, app lock,
  PIN setup, vault export, and Tauri-invoke `fetch_and_save` /
  `save_export_file` flows are all preserved. Fixed a pre-existing
  `client` undefined ref in the export error handler.
- **`src/pages/NewsDetailView.tsx`** — `goBack()` → `navigate('/news')`
  to match web's explicit return behavior; `goBack` import dropped.

#### Library
- **`src/lib/router.ts`** — bare `/chat` URL now restores the user's
  `lastChannel` setting (matches web's "remember where I left off"
  behavior). Bare hash (`#/`) honors the new `defaultLandingView`
  setting — `news` (default) or `chat`. The desktop-only `token-portfolio`
  route block is preserved.
- **`src/lib/settings.ts`** — added `defaultLandingView: 'chat' | 'news'`
  to the `Settings` type, default `'news'`. Survives settings sync.
- **`src/lib/settings-sync.ts`** — split sync keys into `SYNC_KEYS`
  (JSON-encoded via `getSetting`/`setSetting`) and `RAW_SYNC_KEYS`
  (string-encoded directly in localStorage for `theme`, `designStyle`,
  `colorScheme`). `theme` moved to RAW path; `defaultLandingView` rides
  in SYNC because it goes through `setSetting` already.

#### i18n
- **All 7 locales** (en, de, es, pt, ja, zh, ru) — 57 missing keys per
  locale brought across from web verbatim: channel-avatar UX,
  posting-mode strings, color-scheme labels, sidebar broadcast/private/
  public channel labels, settings_color_scheme, settings_default_landing,
  settings_style_modern, today/yesterday, status_connecting, menu_*
  burger-menu strings, channel_verified. The 5 `device_link_*` keys are
  also included for safety (unused since `DeviceMappingBanner` was not
  ported, but harmless if added later).

### Decisions implemented (per planner Q&A)
- 1: Drop Minimal + Elevated, Modern is default → done in `theme.ts` (B0)
- 2: Default-landing-view setting → done in `SettingsView.tsx` + `router.ts`
- 3: Skip `DeviceMappingBanner` → not ported; `verifyDeviceMapping` /
  `relinkDevice` not added to `auth.ts`
- 4: Stale-nodeUrl migration skipped (desktop already on `node.ogmara.org`)
- 5: `__ogmaraRepair` DevTools helper skipped (tied to skipped repair flow)
- 6: `ogmara.sidebarWidth` key shared with web (no namespace prefix)

### Known follow-ups
- Pre-existing TypeScript errors carried over from web (Channel.logo_cid
  not in SDK type, `addModerator` 3-arg / 2-arg call mismatch, etc.) —
  same set web ships with. To be fixed at the SDK level in a separate PR.
- Smoke test on Linux + Windows tray badge behavior under Modern style
- Audit pipeline (code + security + spec compliance) before tagging
- Pre-commit lint baseline: 45 errors (was 43 before port; net +2 are all
  pre-existing in web).

### Added (foundation only)
- **Modern design style** — added as the new default in `theme.ts`. Existing
  users with `elevated` / `minimal` saved styles silently migrate to `modern`
  on next read. The Modern CSS block (~875 lines) lands in
  `src/styles/design-styles.css` under `[data-style="modern"]`.
- **Color schemes** — six accent palettes (`default`, `amber`, `teal`,
  `violet`, `coral`, `neutral-gray`) configurable in Settings (UI not yet
  wired in this checkpoint). Stored as `ogmara.colorScheme` in localStorage.
- **`src/lib/mobile-nav.ts`** — mobile sidebar↔detail pane state for the
  one-pane mobile layout (768px breakpoint). Verbatim copy from web.
- **`src/lib/network-activity.ts`** — `.net-bar` indicator showing in-flight
  API calls. Patches `window.fetch` and is installed AFTER the Tauri-fetch
  wrapper so it tracks Tauri-routed traffic correctly.
- **`src/styles/chat-view.css`** — Modern chat-view rules (~880 lines), all
  scoped under `[data-style="modern"]`. Imported in `index.tsx`.
- **Color scheme + `.net-bar` rules in `global.css`** — also adds the mobile
  one-pane navigation rules (`.app-body.mobile-list-open`, `.mobile-detail-open`,
  `.content-back-btn`).

### Changed (foundation only)
- **Theme storage:** `DesignStyle` is now `'classic' | 'glassmorphism' |
  'modern'`. The four-style enum (`['glassmorphism', 'elevated', 'minimal',
  'classic']`) is replaced by `['modern', 'glassmorphism', 'classic']`.
  Modern is the default for new users. Existing users who picked `elevated`
  or `minimal` get migrated to `modern` automatically. The `CustomTheme`
  per-token overrides feature is preserved (desktop-specific).
- **Reactive design-style signal:** `currentDesignStyle()` and
  `isModernStyle()` exported for components that need to render Modern
  variants conditionally — these are the building blocks the upcoming
  component merges depend on.

### Fixed
- **WebSocket payload base64 decode (`src/lib/payload.ts`)** — same bug
  that web fixed in v0.27.x. WebSocket messages deliver `payload` as a
  base64 string while API responses deliver bytes; the existing helpers
  short-circuited on strings, so images sent in chat only appeared after
  manually re-clicking the channel. New `tryDecodeBase64Payload()` helper
  base64-decodes and MessagePack-decodes string payloads transparently.
- **Anchor timestamp display (`src/components/StatusBar.tsx`)** — the L2
  node returns `anchoring_since` and `last_anchor_age_seconds` as Unix
  timestamps in seconds (despite the field name), not durations or
  millisecond timestamps. The status bar now multiplies `anchoring_since`
  by 1000 before passing to `new Date()` and computes
  `Date.now()/1000 - lastTs` for `formatAge()`. Also added a `connecting`
  state with a pulsing dot that appears while `networkStats()` is loading.

### Security
- **postcss override** — pinned to `>=8.5.10` in `package.json` `overrides`
  block to address CVE-2026-41305 (transitive dev dep via Vite/tsup; not
  shipped in the desktop bundle, fixed for completeness).

### Known follow-ups (this release is incomplete)
- App.tsx — Modern toolbar wrap, mobile back button, `.app-body` class,
  `.net-bar` slot
- Sidebar.tsx — Modern markup blocks (`<Show when={isModernStyle()}>`),
  tabbed sidebar (Chat/News/Messages), DM preview rows, channel avatars
- ChatView.tsx — Modern bubble layout, scroll-to-bottom FAB, channel header
  strip, floating date label
- ChannelSettingsView.tsx — avatar upload, member list with profiles,
  posting-mode toggle (read-only / broadcast feature)
- DmConversationView.tsx — Modern bubble layout
- SettingsView.tsx — color-scheme picker, default-landing-view setting,
  Modern preview thumbnail
- NewsDetailView.tsx, ChannelJoinView.tsx, NewsView.tsx — minor cleanups
- router.ts — `defaultLandingView` honoring on bare `/chat` route
- settings-sync.ts — `RAW_SYNC_KEYS` covering `theme` / `designStyle` /
  `colorScheme`
- i18n locales — ~50–60 new keys × 7 locales for Modern UI strings and the
  read-only / broadcast feature
- Read-only / broadcast channel UI port (composer hide + banner + sidebar
  📢 icon, paired with `l2-node` v0.31.0 and `@ogmara/sdk` v0.14.0)

### Notes for next session
- Wallet-connect race fix from web v0.27.x is **not applicable** to desktop
  — there's no Klever Extension or K5 flow on desktop, only the built-in
  vault. The `networkReady` Promise is web-only.
- DeviceMappingBanner is **deliberately skipped** on desktop — vault auth
  doesn't need device-to-wallet mapping, and the user confirmed desktop's
  current auth path "is already working pretty fine."
- Stale-nodeUrl migration is **deliberately skipped** — desktop already
  uses `node.ogmara.org`; the web migration was for users with the older
  `ogmara.org` value.

## [1.15.3] - 2026-04-11

### Fixed
- **Klever mainnet provider URLs wrong** — `api.klever.org` and `node.klever.org`
  don't exist. Fixed to `api.mainnet.klever.org` and `node.mainnet.klever.org`,
  matching the testnet URL pattern. This broke wallet registration and on-chain
  transactions on mainnet.

## [1.15.2] - 2026-04-11

### Security
- **Update Vite to 6.4.2** — fixes CVE-2026-39363 (high: arbitrary file read
  via dev server WebSocket) and CVE-2026-39365 (medium: path traversal in
  optimized deps `.map` handling).

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
