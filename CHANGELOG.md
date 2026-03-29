# Changelog

All notable changes to the Ogmara desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
