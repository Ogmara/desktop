//! Ogmara Desktop — Tauri backend.
//!
//! Provides native OS integration: system tray, notifications,
//! secure storage via OS credential store, and Tauri commands
//! accessible from the frontend.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Service name used for all keyring entries.
const KEYRING_SERVICE: &str = "ogmara-desktop";

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

// --- Secure Storage (OS credential store) ---

/// Tauri command: read a value from the OS credential store.
#[tauri::command]
fn secure_store_get(key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("keyring error: {e}"))?;
    match entry.get_password() {
        Ok(val) => Ok(Some(val)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get error: {e}")),
    }
}

/// Tauri command: write a value to the OS credential store.
#[tauri::command]
fn secure_store_set(key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    if value.len() > 65536 {
        return Err("value too large (max 64KB)".into());
    }
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("keyring error: {e}"))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("keyring set error: {e}"))
}

/// Tauri command: delete a value from the OS credential store.
#[tauri::command]
fn secure_store_delete(key: String) -> Result<(), String> {
    validate_key(&key)?;
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("keyring error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone, that's fine
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_platform,
            send_notification,
            secure_store_get,
            secure_store_set,
            secure_store_delete,
        ])
        .setup(|app| {
            // Build system tray menu
            let show_item = MenuItem::with_id(app, "show", "Show Ogmara", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Create tray icon
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Ogmara")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
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
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Intercept window close → hide to tray instead of quitting
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
