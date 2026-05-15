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

### Linux video playback (optional but recommended)

The desktop app embeds WebKitGTK, which delegates media decoding to the
system's GStreamer stack. By default WebKitGTK ships with codec stubs
only — actual decoding (H.264 video, AAC audio, MP4 demuxing, etc.)
requires extra plugin packages from your distro. Without them, inline
video falls back to the "Open externally" / download button.

#### Debian / Ubuntu

```bash
sudo apt install -y \
  gstreamer1.0-libav \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly
```

Then restart the desktop app. Most MP4/H.264 + AAC videos play inline
after this.

#### Fedora / RHEL

```bash
sudo dnf install gstreamer1-libav gstreamer1-plugins-good \
                 gstreamer1-plugins-bad-free gstreamer1-plugins-ugly
# Or, for full codec support including ffmpeg-based libav:
sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-bad-{free,freeworld} \
                 gstreamer1-plugins-ugly gstreamer1-libav
```

(`gstreamer1-plugins-bad-freeworld` and `gstreamer1-plugins-ugly` live in
RPM Fusion, which must be enabled separately.)

#### Arch

```bash
sudo pacman -S gst-libav gst-plugins-good gst-plugins-bad gst-plugins-ugly
```

#### Gentoo

The "GStreamer is installed but video still doesn't play" trap is real
on Gentoo, because the codec pipeline requires several USE flags to line
up across multiple packages:

1. **WebKitGTK must be built with `gstreamer` USE.** Check with
   `equery uses net-libs/webkit-gtk | grep gstreamer`. If absent:
   ```bash
   echo "net-libs/webkit-gtk gstreamer" | sudo tee -a /etc/portage/package.use/webkit-gtk
   sudo emerge --newuse net-libs/webkit-gtk
   ```
2. **`gst-plugins-libav` (FFmpeg backend) must be installed.**
   ```bash
   sudo emerge --noreplace media-plugins/gst-plugins-libav
   ```
3. **`media-video/ffmpeg` needs the right codecs USE flags.** At minimum
   you want `x264 mp3 aac` (and ideally `vpx opus theora` for WebM):
   ```bash
   echo "media-video/ffmpeg x264 mp3 aac vpx opus theora" \
     | sudo tee -a /etc/portage/package.use/ffmpeg
   sudo emerge --newuse media-video/ffmpeg
   ```
4. **`gst-plugins-meta` should pull the common decoders.** If your
   profile doesn't include it explicitly:
   ```bash
   echo "media-plugins/gst-plugins-meta libav vpx opus theora" \
     | sudo tee -a /etc/portage/package.use/gst-plugins-meta
   sudo emerge --noreplace media-plugins/gst-plugins-meta
   ```

After rebuilding, sanity-check the runtime by running:
```bash
gst-inspect-1.0 avdec_h264   # should print plugin details, not "No such element"
gst-launch-1.0 playbin uri=file:///path/to/sample.mp4
```
If `gst-launch` plays the file but the app still falls back to the
external-player button, see [TROUBLESHOOTING](#troubleshooting) below.

#### AppImage / manual binaries

AppImages don't bundle GStreamer plugins by default — they rely on the
host system's `/usr/lib`. The same plugin packages as above must be
installed on the host. If video playback still fails inside the
AppImage but works in a normal Firefox/Chromium on the same machine,
WebKitGTK is the limiting factor; you can either install the
distro's webkit-gtk codec extras (some distros split them) or use the
"Open externally" button which hands the file to the system's default
video player (mpv, vlc, etc.).

#### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Black box with no controls | Container demuxer present but codec missing | Install `gst-plugins-bad` + `gst-libav` |
| Loads but no audio | AAC/Opus decoder missing | Install `gst-libav` (covers AAC via FFmpeg) |
| "GStreamer is installed" but nothing plays | WebKitGTK built without `gstreamer` USE (Gentoo) | Rebuild webkit-gtk with `gstreamer` USE |
| Plays in mpv/vlc, not in app | WebKitGTK sandbox + plugin path mismatch | Run `WEBKIT_DISABLE_COMPOSITING_MODE=1` and/or check `GST_PLUGIN_SYSTEM_PATH` |

The "Open externally" button in the video viewer always works on any
system that has *any* video player installed — it `xdg-open`s the
source URL to the system handler.

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
