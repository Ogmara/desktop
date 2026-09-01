//! Ogmara Desktop — Tauri backend.
//!
//! Provides native OS integration: system tray, notifications,
//! secure storage via OS credential store, and Tauri commands
//! accessible from the frontend.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition,
};

/// Saved window position for restoring after hide/show (tray minimize).
/// The window manager doesn't always preserve position for hidden windows.
struct SavedPosition(Mutex<Option<PhysicalPosition<i32>>>);

/// File-based secure storage that persists across sessions.
/// On Linux, the OS keyring (gnome-keyring/kwallet) may not persist if
/// the secret service daemon isn't running or is session-scoped.
/// This file store in the app data directory is always available.
struct SecureFileStore {
    path: PathBuf,
    data: Mutex<HashMap<String, String>>,
    /// Set when the on-disk store existed but was corrupt/unreadable on load AND
    /// we could not preserve it to a `.bak` sidecar. In that state `save()`
    /// refuses to write — overwriting would destroy recoverable (possibly
    /// encrypted-wallet) data (audit 2026-06-07 N1, CLAUDE.md Wallet Safety).
    poisoned: std::sync::atomic::AtomicBool,
}

/// Build a non-clobbering `.corrupt.bak` sidecar path next to `path`.
fn next_corrupt_bak_path(path: &std::path::Path) -> PathBuf {
    for n in 0..1000 {
        let mut name = path.as_os_str().to_owned();
        if n == 0 {
            name.push(".corrupt.bak");
        } else {
            name.push(format!(".corrupt.{n}.bak"));
        }
        let candidate = PathBuf::from(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    // Extremely unlikely (1000 existing backups) — fall back to the base name.
    let mut name = path.as_os_str().to_owned();
    name.push(".corrupt.bak");
    PathBuf::from(name)
}

impl SecureFileStore {
    fn new(app_data_dir: PathBuf) -> Self {
        let path = app_data_dir.join(".secure-store.json");
        let mut poisoned = false;
        let data = if path.exists() {
            match fs::read_to_string(&path) {
                Ok(contents) => match serde_json::from_str::<HashMap<String, String>>(&contents) {
                    Ok(map) => map,
                    Err(e) => {
                        // Corrupt JSON. NEVER overwrite — the bytes may still
                        // hold a recoverable (encrypted) wallet. Preserve them in
                        // a .bak sidecar and start empty; if preservation fails,
                        // poison the store so save() refuses to write.
                        let bak = next_corrupt_bak_path(&path);
                        match fs::rename(&path, &bak) {
                            Ok(()) => eprintln!(
                                "[secure-store] WARNING: store was corrupt ({e}); original preserved at {} — wallet may need restore/re-import",
                                bak.display()
                            ),
                            Err(re) => {
                                poisoned = true;
                                eprintln!(
                                    "[secure-store] ERROR: store corrupt ({e}) and backup failed ({re}); refusing to overwrite to protect wallet data"
                                );
                            }
                        }
                        HashMap::new()
                    }
                },
                Err(e) => {
                    // File exists but couldn't be read (perms/IO). Don't risk
                    // overwriting a recoverable file — poison and surface.
                    poisoned = true;
                    eprintln!(
                        "[secure-store] ERROR: store exists but is unreadable ({e}); refusing to overwrite to protect wallet data"
                    );
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };
        Self {
            path,
            data: Mutex::new(data),
            poisoned: std::sync::atomic::AtomicBool::new(poisoned),
        }
    }

    fn save(&self) -> Result<(), String> {
        if self.poisoned.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(
                "secure store is read-only (was corrupt/unreadable on load); not overwriting to protect wallet data — restart, or restore/remove the store file"
                    .into(),
            );
        }
        let data = self.data.lock().map_err(|e| format!("lock error: {e}"))?;
        // Ensure parent directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("dir error: {e}"))?;
        }
        let json = serde_json::to_string_pretty(&*data)
            .map_err(|e| format!("serialize error: {e}"))?;
        fs::write(&self.path, json).map_err(|e| format!("write error: {e}"))?;
        // Restrict file permissions to owner-only on Unix (0600)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn get(&self, key: &str) -> Option<String> {
        self.data.lock().ok()?.get(key).cloned()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.data
            .lock()
            .map_err(|e| format!("lock error: {e}"))?
            .insert(key.to_string(), value.to_string());
        self.save()
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.data
            .lock()
            .map_err(|e| format!("lock error: {e}"))?
            .remove(key);
        self.save()
    }

    /// Atomically remove `key` UNLESS it is the last remaining wallet-key slot
    /// (i.e. `key` is present and `other` is absent). In that case it returns
    /// `NeedsConfirmation` WITHOUT removing — the caller must get explicit user
    /// confirmation and then call `delete`. The last-key check and the removal
    /// happen under a single lock so two concurrent deletes of the two slots
    /// can't both slip past the guard (audit 2026-06-07 W-1).
    fn delete_guarded(&self, key: &str, other: &str) -> Result<DeleteOutcome, String> {
        let mut data = self.data.lock().map_err(|e| format!("lock error: {e}"))?;
        if data.contains_key(key) && !data.contains_key(other) {
            return Ok(DeleteOutcome::NeedsConfirmation);
        }
        data.remove(key);
        drop(data); // release before save() re-locks
        self.save()?;
        Ok(DeleteOutcome::Deleted)
    }
}

/// Outcome of [`SecureFileStore::delete_guarded`].
enum DeleteOutcome {
    /// The key was removed (it wasn't the last wallet-key slot).
    Deleted,
    /// The key is the last wallet-key slot — NOT removed; needs confirmation.
    NeedsConfirmation,
}

/// Allowed key prefixes for secure storage operations.
const ALLOWED_KEY_PREFIXES: &[&str] = &["ogmara.vault.", "ogmara.app_lock."];

/// Validate that a storage key uses an allowed prefix.
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 256 {
        return Err("key must be 1-256 characters".into());
    }
    if !ALLOWED_KEY_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Err("invalid key prefix".into());
    }
    Ok(())
}

/// Tauri command: get the app version.
#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Tauri command: get platform info.
#[tauri::command]
fn get_platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

// --- Secure Storage (file-based, persistent) ---
//
// Uses a JSON file in the app data directory instead of the OS keyring.
// The OS keyring (gnome-keyring/kwallet) on Linux is often session-scoped
// and doesn't persist across reboots or when the secret service isn't running.
// The file store is always available and survives restarts.
//
// Note: the private key is still encrypted with AES-256-GCM when PIN is set.
// This file is only as secure as the user's filesystem permissions, which is
// equivalent to how most desktop apps store credentials (e.g., browser profiles).

/// Tauri command: read a value from the secure file store.
#[tauri::command]
fn secure_store_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    let store = app.state::<SecureFileStore>();
    Ok(store.get(&key))
}

/// Tauri command: write a value to the secure file store.
#[tauri::command]
fn secure_store_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    if value.len() > 65536 {
        return Err("value too large (max 64KB)".into());
    }
    let store = app.state::<SecureFileStore>();
    store.set(&key, &value)
}

/// The two vault key slots that hold irreplaceable wallet key material.
const VAULT_RAW_KEY: &str = "ogmara.vault.private_key";
const VAULT_ENCRYPTED_KEY: &str = "ogmara.vault.encrypted_key";

/// Tauri command: delete a value from the secure file store.
///
/// Wallet-loss guard (audit 2026-06-07 W6): the webview can call this command,
/// so XSS/malicious code could wipe the wallet. Deleting the SOLE remaining
/// copy of wallet key material is irreversible, so when this delete would leave
/// no wallet key in the store we require explicit NATIVE confirmation — code in
/// the webview cannot dismiss an OS dialog. Legitimate mode-switch migrations
/// always write the other slot first, so they never trigger the prompt; only an
/// explicit wallet-clear (or an attack) hits the last-copy case.
#[tauri::command]
async fn secure_store_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    validate_key(&key)?;
    let store = app.state::<SecureFileStore>();

    if key == VAULT_RAW_KEY || key == VAULT_ENCRYPTED_KEY {
        let other = if key == VAULT_RAW_KEY { VAULT_ENCRYPTED_KEY } else { VAULT_RAW_KEY };
        // Atomic check-and-delete: returns NeedsConfirmation (without removing)
        // only when this is the sole remaining wallet key. Two concurrent
        // deletes of the two slots therefore cannot both bypass the prompt.
        match store.delete_guarded(&key, other)? {
            DeleteOutcome::Deleted => return Ok(()),
            DeleteOutcome::NeedsConfirmation => {
                let app2 = app.clone();
                let confirmed = tokio::task::spawn_blocking(move || {
                    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                    app2.dialog()
                        .message(
                            "This permanently removes your wallet key from this device. \
                             Without an exported backup your wallet CANNOT be recovered. Continue?",
                        )
                        .title("Remove wallet key?")
                        .kind(MessageDialogKind::Warning)
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "Remove".into(),
                            "Cancel".into(),
                        ))
                        .blocking_show()
                })
                .await
                .map_err(|e| format!("confirm dialog error: {e}"))?;
                if !confirmed {
                    return Err("wallet key deletion cancelled by user".into());
                }
                return store.delete(&key); // user confirmed removing this key
            }
        }
    }

    store.delete(&key)
}

/// Tauri command: send a native OS notification.
#[tauri::command]
async fn send_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    if title.len() > 256 {
        return Err("title too long (max 256 chars)".into());
    }
    if body.len() > 4096 {
        return Err("body too long (max 4096 chars)".into());
    }

    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("notification error: {}", e))?;
    Ok(())
}

/// Tauri command: open a URL in the system default browser.
/// Uses platform-specific commands: xdg-open (Linux), open (macOS), cmd (Windows).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Allow only http(s):// links. External URLs embedded in news posts /
    // messages may be plain `http://`, so the previous `https://`-only rule
    // silently dropped them; every other scheme (file:, javascript:, custom
    // handlers) stays rejected.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s):// URLs are allowed".into());
    }
    // Defensive bound + reject embedded whitespace/control chars so the URL
    // can't smuggle extra argv into the spawned opener.
    if url.len() > 8192 || url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("invalid URL".into());
    }

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(&url).spawn();

    result.map_err(|e| format!("failed to open URL: {}", e))?;
    Ok(())
}

/// Tauri command: open a media URL in an external video player.
///
/// Linux specifically does NOT route through `xdg-open` — that command
/// dispatches HTTP URLs by SCHEME (always → user's default browser),
/// not by MIME type, so an `http://node/media/<cid>` becomes a browser
/// download dialog instead of an mpv/vlc launch. The xdg-mime registry
/// (which DOES know `video/mp4` → mpv) only kicks in for `file://`
/// URLs, but downloading the file first just to re-dispatch it is
/// wasteful and on some systems the default `video/mp4` handler is a
/// transcoder (HandBrake) rather than a player anyway.
///
/// Instead, on Linux we directly spawn a known video player binary
/// with the URL as argv — modern players (mpv, vlc, mplayer, etc.) all
/// accept HTTP URLs natively via libavformat. macOS and Windows still
/// use their native open-by-default mechanism because their default
/// browsers do play H.264 inline (so a browser tab is acceptable UX).
#[tauri::command]
fn open_media_external(url: String) -> Result<(), String> {
    // Length cap. The video viewer only ever passes node-built media
    // URLs (well under 1 KB). A 100 MB renderer-side bug would still
    // try to allocate the argv before the spawn step rejected it.
    const MAX_URL_LEN: usize = 8 * 1024;
    if url.len() > MAX_URL_LEN {
        return Err(format!("URL too long: {} > {}", url.len(), MAX_URL_LEN));
    }

    // Reject any control character or whitespace that could (a) break
    // out of the URL when read by a logger / parent process, (b) embed
    // newlines that some OS handlers split on. argv passes raw bytes so
    // shell injection isn't the threat — log-injection / handler
    // splitting is.
    if url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("URL must not contain control or whitespace characters".into());
    }

    // Defense-in-depth: refuse anything that isn't http(s). Substring
    // check is safe AFTER the control-char rejection above (otherwise a
    // `http://\nfile://...` could slip past). The video viewer only
    // passes node-built media URLs, but a misuse upstream shouldn't
    // turn into a file:// / javascript: / data: open.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http:// and https:// URLs are allowed".into());
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: try known video players in order of preference. The
        // first whose binary can be spawned wins. Each player accepts
        // an HTTP URL as argv — mpv, vlc, and mplayer all use
        // libavformat under the hood so the network handling is
        // identical to local-file playback.
        //
        // Order rationale:
        //   - mpv         : smallest, scriptable, modern OSD
        //   - vlc         : near-universal Linux install
        //   - celluloid   : GTK frontend over mpv; users who installed
        //                   it usually want it to be the handler
        //   - mplayer     : legacy, but still on minimal systems
        //   - ffplay      : ffmpeg's debug player; last resort, but
        //                   present anywhere ffmpeg is installed
        const PLAYERS: &[&str] = &["mpv", "vlc", "celluloid", "mplayer", "ffplay"];
        for player in PLAYERS {
            // `.spawn()` checks PATH for the binary; missing binaries
            // return Err("No such file or directory"). Successful spawn
            // means the process is launching — we don't wait for it.
            if std::process::Command::new(player).arg(&url).spawn().is_ok() {
                return Ok(());
            }
        }
        // No player found. Surface a clear, actionable error so the
        // UI's "open externally" fallback panel can show the user
        // exactly what to install — far better than silently falling
        // back to xdg-open (which would just open a browser download
        // dialog and confuse the user further).
        return Err(
            "No external video player found. Install one of mpv, vlc, \
             celluloid, mplayer, or ffplay. \
             Gentoo: `emerge media-video/mpv` or `emerge media-video/vlc`. \
             Debian/Ubuntu: `apt install mpv` or `apt install vlc`."
                .into(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: Safari/WebKit on this platform plays H.264 inline, so
        // a browser tab is acceptable. `open` respects the user's
        // default URL handler.
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("failed to open URL: {}", e))?;
        return Ok(());
    }

    // Windows: `explorer.exe <url>` forwards through the shell handler
    // chain, which has historically been a foot-gun for URI scheme
    // smuggling (CVE-2024-21412 family). The http(s)-only prefix check
    // above is the primary defense; downstream redirects are an OS
    // concern outside our threat model. Tracked as a known limitation
    // — switching to `ShellExecuteW` with explicit `lpOperation = open`
    // is the long-term Windows hardening path. Edge/Chromium WebView
    // plays H.264 inline so a browser tab is acceptable here.
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("failed to open URL: {}", e))?;
        return Ok(());
    }

    // Defensive fallback for unsupported target_os values. Never
    // reached when one of the three cfg blocks above matches.
    #[allow(unreachable_code)]
    Err("unsupported platform for open_media_external".into())
}

/// Tauri command: show a native save dialog and write content to the selected file.
#[tauri::command]
async fn save_export_file(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    // Build dialog on main thread, then run blocking save off Tokio runtime
    let dialog = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .add_filter("JSON", &["json"]);

    let path = tokio::task::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| format!("Dialog error: {}", e))?;

    match path {
        Some(file_path) => {
            let p = file_path.as_path().ok_or("Invalid path")?;
            std::fs::write(p, content.as_bytes())
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// True iff `ip` is a globally-routable public address. Rejects loopback,
/// RFC1918 private, link-local (incl. the 169.254.169.254 cloud-metadata
/// endpoint), CGNAT, ULA, multicast, unspecified, documentation, and
/// IPv4-mapped IPv6 — the SSRF-relevant ranges (audit 2026-06-07 C1). Mirrors
/// the node's `sc_views` routability classifier.
fn ip_is_publicly_routable(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            if v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
            {
                return false;
            }
            let o = v4.octets();
            // CGNAT 100.64.0.0/10 (RFC6598) — `is_shared` is unstable.
            if o[0] == 100 && (o[1] & 0xc0) == 0x40 {
                return false;
            }
            true
        }
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return false;
            }
            let s = v6.segments();
            if (s[0] & 0xfe00) == 0xfc00 {
                return false; // ULA fc00::/7
            }
            if (s[0] & 0xffc0) == 0xfe80 {
                return false; // link-local fe80::/10
            }
            if s[0..5].iter().all(|&x| x == 0) && s[5] == 0xffff {
                return false; // IPv4-mapped ::ffff:0:0/96
            }
            if s[0] == 0x2001 && s[1] == 0x0db8 {
                return false; // documentation 2001:db8::/32
            }
            true
        }
    }
}

/// A ureq resolver that performs the normal DNS lookup, then drops any
/// non-publicly-routable address from the result (audit 2026-06-07 C1). Because
/// ureq's connector dials *exactly* the addresses this returns — with no second
/// DNS lookup — filtering here both blocks SSRF to internal targets and pins
/// the connection against DNS-rebinding (a host that resolves to a public IP at
/// validation time can't flip to a private IP at connect time). NOTE: depends
/// on ureq 3.3's `unversioned::resolver` API (pinned in Cargo.lock).
#[derive(Debug, Default)]
struct SsrfGuardResolver {
    inner: ureq::unversioned::resolver::DefaultResolver,
}

impl ureq::unversioned::resolver::Resolver for SsrfGuardResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        let resolved = self.inner.resolve(uri, config, timeout)?;
        let mut safe = ureq::unversioned::resolver::Resolver::empty(self);
        for addr in resolved.iter() {
            if ip_is_publicly_routable(&addr.ip()) {
                safe.push(*addr);
            }
        }
        if safe.is_empty() {
            // Every resolved address was private/internal (or the host had
            // none) → refuse rather than dial an internal target.
            return Err(ureq::Error::HostNotFound);
        }
        Ok(safe)
    }
}

/// Tauri command: fetch a URL with auth headers and return the body as a string.
/// Used for large responses that Tauri's HTTP plugin can't handle reliably.
/// Headers are restricted to x-ogmara-* for security (prevents SSRF with arbitrary auth tokens).
/// Response body is capped at 50 MB to prevent OOM. The custom resolver blocks
/// SSRF to private/internal IPs and pins against DNS-rebinding (audit C1).
#[tauri::command]
async fn fetch_and_save(
    url: String,
    headers: HashMap<String, String>,
) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("only https:// URLs are allowed".into());
    }
    // Run blocking HTTP request off the Tokio runtime
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        // Disable redirect-following: a 3xx to http:// or another host would
        // bypass the https-only check (and could leak the x-ogmara-* auth
        // headers over plaintext). The export endpoint is a direct call with
        // no legitimate redirects (audit follow-up W1).
        let config = ureq::config::Config::builder()
            .max_redirects(0)
            .build();
        let agent = ureq::Agent::with_parts(
            config,
            ureq::unversioned::transport::DefaultConnector::default(),
            SsrfGuardResolver::default(),
        );
        let mut req = agent.get(&url);
        for (k, v) in &headers {
            if k.starts_with("x-ogmara-") {
                req = req.header(k, v);
            }
        }
        let mut resp = req.call().map_err(|e| format!("HTTP error: {}", e))?;
        let body = resp
            .body_mut()
            .with_config()
            .limit(50_000_000)
            .read_to_string()
            .map_err(|e| format!("Read error: {}", e))?;
        Ok(body)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Tauri command: update the tray icon with an unread badge.
/// Receives RGBA pixel data from the frontend (rendered via canvas).
#[tauri::command]
fn update_tray_badge(app: tauri::AppHandle, rgba: Vec<u8>, width: u32, height: u32, count: u32) -> Result<(), String> {
    // Validate RGBA buffer dimensions
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected || width > 256 || height > 256 {
        return Err("invalid icon dimensions".into());
    }

    if let Some(tray) = app.tray_by_id("Ogmara") {
        // Update tooltip
        let tooltip = if count > 0 {
            format!("Ogmara Desktop ({} unread)", count)
        } else {
            "Ogmara Desktop".to_string()
        };
        tray.set_tooltip(Some(&tooltip)).map_err(|e| format!("{}", e))?;

        // Update icon with badge overlay
        let icon = tauri::image::Image::new_owned(rgba, width, height);
        tray.set_icon(Some(icon)).map_err(|e| format!("{}", e))?;
    }
    Ok(())
}

/// Show the main window and restore its saved position.
fn restore_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        // Restore saved position (window manager may not preserve it after hide)
        if let Some(saved) = app.try_state::<SavedPosition>() {
            if let Some(pos) = saved.0.lock().ok().and_then(|mut g| g.take()) {
                let _ = window.set_position(pos);
            }
        }
        let _ = window.set_focus();
        // Notify the frontend to refresh data (WS may have disconnected while hidden)
        let _ = app.emit("app-restored", ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize file-based secure store in the app data directory.
    // On Linux: ~/.local/share/org.ogmara.desktop/
    // On macOS: ~/Library/Application Support/org.ogmara.desktop/
    // On Windows: C:\Users\<user>\AppData\Local\org.ogmara.desktop\
    let app_data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("org.ogmara.desktop");
    let secure_store = SecureFileStore::new(app_data_dir);

    tauri::Builder::default()
        .manage(SavedPosition(Mutex::new(None)))
        .manage(secure_store)
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE,
                    // Deliberately omit DECORATIONS and FULLSCREEN — decorations
                    // are always false (custom title bar), fullscreen is unused.
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_platform,
            send_notification,
            secure_store_get,
            secure_store_set,
            secure_store_delete,
            open_url,
            open_media_external,
            save_export_file,
            fetch_and_save,
            update_tray_badge,
        ])
        .setup(|app| {
            // Build system tray menu
            let show_item = MenuItem::with_id(app, "show", "Show Ogmara", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Create tray icon with explicit icon for Linux compatibility
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("app icon must be set");
            let _tray = TrayIconBuilder::with_id("Ogmara")
                .icon(icon)
                .menu(&menu)
                .title("Ogmara Desktop")
                .tooltip("Ogmara Desktop")
                .menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        restore_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        restore_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Intercept window close → save position + hide to tray instead of quitting
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Save window position for restore on show
                        if let Ok(pos) = window_clone.outer_position() {
                            if let Some(saved) = window_clone.app_handle().try_state::<SavedPosition>() {
                                if let Ok(mut guard) = saved.0.lock() {
                                    *guard = Some(pos);
                                }
                            }
                        }
                        // Save window state to disk for persistence across restarts
                        use tauri_plugin_window_state::AppHandleExt;
                        let _ = window_clone.app_handle().save_window_state(
                            tauri_plugin_window_state::StateFlags::POSITION
                                | tauri_plugin_window_state::StateFlags::SIZE
                                | tauri_plugin_window_state::StateFlags::MAXIMIZED
                                | tauri_plugin_window_state::StateFlags::VISIBLE,
                        );
                        // Prevent the window from actually closing
                        api.prevent_close();
                        // Hide it to the system tray
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running Ogmara desktop app");
}
