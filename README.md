# Ogmara Desktop

Desktop application for [Ogmara](https://ogmara.org) built with [Tauri v2](https://tauri.app) — native performance, small binary (~10MB), cross-platform.

## Features

- System tray with Show/Quit menu and click-to-show
- Native OS notifications (Windows, macOS, Linux)
- Window draggable toolbar
- Dark theme default with light/system toggle
- Shared SolidJS frontend with the web app
- Tauri commands for version, platform info, and notifications
- i18n support (expandable to 6 languages)

## Development

```bash
npm install

# Run in development mode (frontend + Tauri backend)
npm run tauri dev

# Build for production
npm run tauri build
```

## Project Structure

```
src/                  — SolidJS frontend (shared with web app)
  App.tsx             — root component with Tauri command integration
  index.tsx           — entry point
  styles.css          — design tokens (dark/light themes)
  theme.ts            — theme management
  i18n.ts             — i18n with inlined translations
src-tauri/            — Tauri Rust backend
  src/lib.rs          — system tray, notifications, commands
  src/main.rs         — entry point
  tauri.conf.json     — app config, window, bundle, plugins
  icons/              — app icons (PNG)
```

## Platform Support

| Platform | Status | Package |
|----------|--------|---------|
| Linux | Supported | .deb, .AppImage |
| macOS | Supported | .dmg |
| Windows | Supported | .msi |

## License

MIT
