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
    Manager, PhysicalPosition,
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
}

impl SecureFileStore {
    fn new(app_data_dir: PathBuf) -> Self {
        let path = app_data_dir.join(".secure-store.json");
        let data = if path.exists() {
            match fs::read_to_string(&path) {
                Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
                Err(_) => HashMap::new(),
            }
        } else {
            HashMap::new()
        };
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn save(&self) -> Result<(), String> {
        let data = self.data.lock().map_err(|e| format!("lock error: {e}"))?;
        // Ensure parent directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("dir error: {e}"))?;
        }
        let json = serde_json::to_string_pretty(&*data)
            .map_err(|e| format!("serialize error: {e}"))?;
        fs::write(&self.path, json).map_err(|e| format!("write error: {e}"))?;
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

/// Tauri command: delete a value from the secure file store.
#[tauri::command]
fn secure_store_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    validate_key(&key)?;
    let store = app.state::<SecureFileStore>();
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
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Only allow https:// URLs
    if !url.starts_with("https://") {
        return Err("only https:// URLs are allowed".into());
    }
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("failed to open URL: {}", e))?;
    Ok(())
}

/// Show the main window and restore its saved position.
fn restore_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        // Restore saved position (window manager may not preserve it after hide)
        if let Some(saved) = app.try_state::<SavedPosition>() {
            if let Some(pos) = saved.0.lock().unwrap().take() {
                let _ = window.set_position(pos);
            }
        }
        let _ = window.set_focus();
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
            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Ogmara")
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
                                *saved.0.lock().unwrap() = Some(pos);
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
