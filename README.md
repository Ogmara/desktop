# Ogmara Desktop

Desktop application for [Ogmara](https://ogmara.org) built with [Tauri v2](https://tauri.app) — native performance, small binary (~10MB), cross-platform.

## Features

- Full feature parity with the Ogmara web app
- Standalone built-in wallet (Ed25519 signing, on-chain operations — no browser extension needed)
- System tray with close-to-tray and click-to-show
- Native OS notifications (mentions, DMs, replies)
- PIN-protected vault with OS keyring storage
- Custom theme colors (accent, background, text)
- 7 languages (EN, DE, ES, PT, JA, ZH, RU)
- Dark/Light/System theme with compact layout option

## System Requirements

### Linux

Tauri requires several system libraries. Install them before building:

**Debian/Ubuntu:**
```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libgtk-3-dev \
  libsoup-3.0-dev \
  javascriptcoregtk-4.1
```

**Gentoo:**
```bash
emerge dev-libs/libayatana-appindicator \
  net-libs/webkit-gtk:4.1 \
  gnome-base/librsvg \
  dev-libs/openssl \
  x11-libs/gtk+:3 \
  net-libs/libsoup:3.0
```

**Fedora/RHEL:**
```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  openssl-devel \
  gtk3-devel \
  libsoup3-devel
```

**Arch Linux:**
```bash
sudo pacman -S webkit2gtk-4.1 libayatana-appindicator librsvg openssl gtk3 libsoup3
```

### macOS

Xcode Command Line Tools:
```bash
xcode-select --install
```

### Windows

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10/11)

## Development

```bash
# Install frontend dependencies
npm install

# Run in development mode (frontend + Tauri backend)
npm run tauri dev

# Build for production
npm run tauri build
```

## Project Structure

```
src/                      — SolidJS frontend
  App.tsx                 — root component (router + lock screen + full layout)
  LockScreen.tsx          — PIN unlock screen
  PinSetup.tsx            — PIN setup modal
  index.tsx               — entry point (i18n, theme, auth init)
  components/             — 10 UI components (Sidebar, Toolbar, etc.)
  pages/                  — 16 page views (Chat, News, DMs, etc.)
  lib/                    — shared modules
    api.ts                — OgmaraClient SDK wrapper
    auth.ts               — wallet auth state (built-in only)
    klever.ts             — standalone Klever TX build/sign/broadcast
    vault.ts              — OS keyring key storage + PIN encryption
    ws.ts                 — WebSocket real-time connection
    router.ts             — hash-based URL router
    settings.ts           — localStorage preferences
    theme.ts              — dark/light/system + custom colors
    push.ts               — native notification wrapper
    ...
  i18n/                   — i18next with 7 locale JSON files
  styles/                 — global CSS with design tokens
src-tauri/                — Tauri Rust backend
  src/lib.rs              — system tray, notifications, OS keyring
  src/main.rs             — entry point
  tauri.conf.json         — app config, CSP, bundle targets
  icons/                  — app icons (PNG)
```

## Platform Support

| Platform | Status | Packages |
|----------|--------|----------|
| Linux    | Supported | AppImage, .deb |
| macOS    | Supported | .dmg |
| Windows  | Supported | .msi, .nsis |

## License

MIT
