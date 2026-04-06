# Building the Ogmara Desktop App

## Prerequisites

### System packages (Debian/Ubuntu)

```bash
sudo apt install -y \
  build-essential pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev \
  libappindicator3-dev librsvg2-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  patchelf git curl
```

Note: Tauri v2 requires `webkit2gtk-4.1` (not 4.0).

### Rust toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

### Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## Build

```bash
git clone https://github.com/Ogmara/desktop.git
git clone https://github.com/Ogmara/sdk-js.git  # SDK dependency

cd sdk-js
npm install && npm run build

cd ../desktop
npm install
```

### Debug build (faster, includes DevTools)

```bash
npx tauri build --debug
```

### Release build

```bash
npx tauri build
```

First build compiles all Rust dependencies — takes 10-20 minutes on 2 cores.

## Output

```
src-tauri/target/release/bundle/
  deb/*.deb           # Debian package
  appimage/*.AppImage  # Portable Linux binary
```

## Install

### From .deb package

```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/*.deb
sudo apt --fix-broken install -y  # if missing runtime deps
```

### From AppImage

```bash
chmod +x src-tauri/target/release/bundle/appimage/*.AppImage
./src-tauri/target/release/bundle/appimage/*.AppImage
```

## Features

- System tray with unread badge
- Close-to-tray (keeps running in background)
- Native OS notifications
- Window state persistence (size/position)
- Built-in wallet with OS credential store
- PIN lock with auto-timeout

## SDK dependency

Same as the web app — rebuild the SDK before rebuilding the desktop app:

```bash
cd sdk-js && npm run build
cd ../desktop && npx tauri build
```
