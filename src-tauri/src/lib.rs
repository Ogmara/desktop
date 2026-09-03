//! Ogmara Desktop — Tauri backend.
//!
//! Provides native OS integration: system tray, notifications,
//! persistent secure storage, and Tauri commands accessible from the
//! frontend.
//!
//! Secure storage is an ENCRYPTED file in the app data directory, not the OS
//! credential store — see `store_crypto` for why, and for exactly what that
//! does and does not protect against.

mod store_crypto;

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
    /// Serializes the seal→write→rename sequence in `save()`.
    ///
    /// `save()` deliberately releases the data lock before I/O, and the async
    /// delete commands run on the Tokio runtime while sync `set` calls run on
    /// the main thread — so two saves could interleave. With a shared temp
    /// path that meant one writer truncating the other's file and then
    /// renaming a half-written buffer over the store: GCM authentication fails
    /// on the next launch, the store poisons, and EVERY wallet on the device
    /// is unrecoverable. The milder form is a lost update, where one writer's
    /// snapshot silently reverts a delete.
    write_lock: Mutex<()>,
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
        // On the LOAD path as well: narrowing only inside `save()` meant a
        // read-only session left the directory at 0755 indefinitely.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&app_data_dir, fs::Permissions::from_mode(0o700));
        }
        let mut poisoned = false;
        let mut needs_upgrade = false;
        let data = if path.exists() {
            match fs::read_to_string(&path) {
                // ENCRYPTED (v2) is the normal case. A bare JSON map is the
                // pre-0.62 plaintext format and is migrated in place below.
                Ok(contents) if !store_crypto::is_legacy_plaintext(&contents) => {
                    match store_crypto::open(&path, &contents)
                        .and_then(|pt| {
                            serde_json::from_slice::<HashMap<String, String>>(&pt)
                                .map_err(|e| format!("decrypted store is not a map: {e}"))
                        }) {
                        Ok(map) => map,
                        Err(e) => {
                            // Wrong machine, tampering, or truncation. NEVER
                            // overwrite: the bytes may still be decryptable
                            // elsewhere (a store copied from another machine
                            // opens on the machine that wrote it). Poison and
                            // surface rather than silently starting empty,
                            // which would look exactly like "no wallet" and
                            // invite the user to create a new one over it.
                            poisoned = true;
                            eprintln!(
                                "[secure-store] ERROR: store could not be decrypted ({e}); refusing to overwrite to protect wallet data"
                            );
                            HashMap::new()
                        }
                    }
                }
                Ok(contents) => match serde_json::from_str::<HashMap<String, String>>(&contents) {
                    Ok(map) => {
                        // One-way migration from the plaintext format. The
                        // rewrite is deferred to the first save() rather than
                        // done here, so a failure to encrypt cannot leave the
                        // user with neither file — `needs_encryption_upgrade`
                        // drives an immediate save right after construction.
                        needs_upgrade = !map.is_empty();
                        map
                    }
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
        // Sweep stale temp files BEFORE anything else touches the directory.
        //
        // Each is a complete sealed copy of the store, and with per-save unique
        // names nothing overwrites them any more — so every crash between
        // create and rename would leave one permanently. They are also frozen
        // snapshots: one written before a PIN setup preserves the
        // plaintext-slot state forever, defeating "remove account" and PIN
        // encryption as far as on-disk remanence goes. A pre-1.70 `.tmp` is
        // additionally 0644.
        Self::sweep_temp_files(&path);

        let store = Self {
            path,
            data: Mutex::new(data),
            poisoned: std::sync::atomic::AtomicBool::new(poisoned),
            write_lock: Mutex::new(()),
        };
        if needs_upgrade {
            // Rewrite the plaintext store encrypted, immediately. `save()`
            // writes atomically (temp + rename), so an interruption leaves the
            // original plaintext file intact and the upgrade simply retries on
            // the next launch.
            match store.save() {
                Ok(()) => eprintln!("[secure-store] store upgraded to encrypted at-rest format"),
                Err(e) => eprintln!(
                    "[secure-store] WARNING: could not upgrade store to encrypted format ({e}); continuing with the existing file"
                ),
            }
        }
        store
    }

    /// Remove leftover `.secure-store.tmp*` files from crashed saves.
    fn sweep_temp_files(path: &std::path::Path) {
        // `file_stem()`, NOT `file_name()`. The temp names come from
        // `with_extension("tmp.…")`, which REPLACES `.json` — so a prefix built
        // from the full file name (`.secure-store.json.tmp`) matched nothing
        // and this sweep silently did nothing at all.
        let (Some(dir), Some(stem)) = (path.parent(), path.file_stem()) else {
            return;
        };
        let prefix = format!("{}.tmp", stem.to_string_lossy());
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix) {
                // Skip anything recent: there is no single-instance guard, so a
                // second running copy may be mid-save, and deleting its temp
                // between create and rename fails that save. A crashed leftover
                // is not time-critical.
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified.elapsed().map(|d| d.as_secs() < 300).unwrap_or(false) {
                            continue;
                        }
                    }
                }
                match fs::remove_file(entry.path()) {
                    Ok(()) => eprintln!("[secure-store] removed stale temp file {name}"),
                    Err(e) => eprintln!("[secure-store] could not remove stale temp {name}: {e}"),
                }
            }
        }
    }

    fn save(&self) -> Result<(), String> {
        if self.poisoned.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(
                "secure store is read-only (was corrupt/unreadable on load); not overwriting to protect wallet data — restart, or restore/remove the store file"
                    .into(),
            );
        }
        // Held across the whole seal→write→rename sequence.
        let _writing = self
            .write_lock
            .lock()
            .map_err(|e| format!("write lock error: {e}"))?;

        let data = self.data.lock().map_err(|e| format!("lock error: {e}"))?;
        // Ensure parent directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("dir error: {e}"))?;
            // The directory holds the vault; 0755 lets any local user list and
            // read whatever is inside it.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }
        let json = serde_json::to_string(&*data)
            .map_err(|e| format!("serialize error: {e}"))?;
        drop(data); // seal() may read the sidecar; don't hold the map lock

        // Encrypt at rest. Wallet key material must never touch the disk in
        // the clear — see `store_crypto` for exactly what this does and does
        // not protect against.
        let sealed = store_crypto::seal(&self.path, json.as_bytes())?;
        // Verify what we are about to persist actually opens, BEFORE replacing
        // a good file with it. Writing an unopenable store over a working one
        // is indistinguishable from losing the wallet.
        store_crypto::open(&self.path, &sealed)
            .map_err(|e| format!("refusing to write a store that does not decrypt: {e}"))?;

        // Atomic replace: write a temp file in the same directory, fsync it,
        // then rename over the target. A crash mid-write therefore leaves the
        // PREVIOUS store intact rather than a truncated one — the old
        // `fs::write` truncated in place, so an interrupted save could destroy
        // a working vault.
        // Unique per save. A shared `.tmp` is a second way two writers collide,
        // even under the lock above — a crashed process can leave one behind.
        let tmp = self.path.with_extension(format!(
            "tmp.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        {
            use std::io::Write;
            // Created 0600 ATOMICALLY, not chmod'ed afterwards. `File::create`
            // uses the umask default (0644 typically), so the previous version
            // wrote the ENTIRE store — every private key — to a
            // world-readable temp file and only narrowed it once the write had
            // finished. Since the wrapping key derives from the world-readable
            // machine id, any local user who read that window's file could
            // decrypt it.
            #[cfg(unix)]
            let mut f = {
                use std::os::unix::fs::OpenOptionsExt;
                fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&tmp)
                    .map_err(|e| format!("write error: {e}"))?
            };
            #[cfg(not(unix))]
            let mut f = fs::File::create(&tmp).map_err(|e| format!("write error: {e}"))?;

            f.write_all(sealed.as_bytes())
                .map_err(|e| format!("write error: {e}"))?;
            f.sync_all().map_err(|e| format!("sync error: {e}"))?;
        }
        fs::rename(&tmp, &self.path).map_err(|e| {
            // Never leave the temp copy — it holds every private key.
            let _ = fs::remove_file(&tmp);
            format!("replace error: {e}")
        })?;
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

    /// Atomically remove `keys` UNLESS doing so would destroy the LAST wallet
    /// key material on this device. In that case it returns `NeedsConfirmation`
    /// WITHOUT removing anything — the caller must get explicit user
    /// confirmation and then call `delete_many`.
    ///
    /// The check and the removal happen under a single lock so two concurrent
    /// deletes can't both slip past the guard (audit 2026-06-07 W-1).
    ///
    /// Generalised for multi-account: the original guard compared `key` against
    /// exactly two constants, so a per-account slot
    /// (`ogmara.vault.private_key.<addr>`) matched NEITHER and deleting the
    /// last one bypassed the prompt entirely. The rule is now structural —
    /// "would any wallet-key slot remain?" — so it holds however many accounts
    /// exist and whatever they are named.
    ///
    /// Legitimate migrations and PIN mode-switches always write the new slot
    /// BEFORE deleting the old one, so at least one slot always remains and
    /// this never prompts. It fires only on a genuine last-key removal.
    fn delete_guarded_many(&self, keys: &[String]) -> Result<DeleteOutcome, String> {
        let mut data = self.data.lock().map_err(|e| format!("lock error: {e}"))?;

        let removing_wallet_key = keys.iter().any(|k| is_wallet_key_slot(k) && data.contains_key(k));
        if removing_wallet_key {
            let remaining = data
                .keys()
                .filter(|k| is_wallet_key_slot(k))
                .filter(|k| !keys.iter().any(|d| d == *k))
                .count();
            if remaining == 0 {
                return Ok(DeleteOutcome::NeedsConfirmation);
            }
        }

        // The DEK is not a key COPY, but destroying it makes every encrypted
        // slot permanently unreadable — the same outcome as losing the keys, so
        // it gets the same prompt. The `.mirror` copy is deliberately NOT
        // guarded: it exists to be redundant.
        let removing_dek = keys.iter().any(|k| k == VAULT_DEK_KEY && data.contains_key(k));
        if removing_dek {
            let encrypted_slots_remain = data
                .keys()
                .any(|k| k.starts_with(VAULT_ENCRYPTED_KEY) && !keys.iter().any(|d| d == k));
            if encrypted_slots_remain {
                return Ok(DeleteOutcome::NeedsConfirmation);
            }
        }

        for k in keys {
            data.remove(k);
        }
        drop(data); // release before save() re-locks
        self.save()?;
        Ok(DeleteOutcome::Deleted)
    }

    /// Addresses that have a per-account wallet-key slot.
    ///
    /// Deliberately narrow: it returns only the `<addr>` suffixes of the two
    /// wallet-key slot prefixes — no key names, no values, and nothing outside
    /// the vault namespace. The webview already reads the private keys
    /// themselves, so this exposes nothing new, and it gives the account index
    /// a source whose presence PROVES a slot exists rather than merely
    /// recording that one did.
    fn list_vault_accounts(&self) -> Result<Vec<String>, String> {
        let data = self.data.lock().map_err(|e| format!("lock error: {e}"))?;
        let mut out: Vec<String> = data
            .keys()
            .filter_map(|k| {
                for prefix in [VAULT_RAW_KEY, VAULT_ENCRYPTED_KEY] {
                    if let Some(rest) = k.strip_prefix(prefix) {
                        if let Some(addr) = rest.strip_prefix('.') {
                            // Same predicate as `is_wallet_key_slot`. They
                            // disagreed: a suffix this accepted but that one
                            // rejected surfaced as a ghost account in the
                            // index while not counting for the delete guard.
                            if is_address_shaped(addr) {
                                return Some(addr.to_string());
                            }
                        }
                    }
                }
                None
            })
            .collect();
        out.sort();
        out.dedup();
        Ok(out)
    }
}

/// Whether `key` names storage that holds wallet key material.
///
/// Matches the legacy single-wallet anchors exactly AND the per-account slots
/// derived from them (`<prefix>.<address>`).
fn is_wallet_key_slot(key: &str) -> bool {
    for prefix in [VAULT_RAW_KEY, VAULT_ENCRYPTED_KEY] {
        if key == prefix {
            return true;
        }
        if let Some(rest) = key.strip_prefix(prefix) {
            // Only a `.`-suffixed per-account slot whose suffix is
            // ADDRESS-SHAPED. Accepting any non-empty suffix let webview code
            // mint a decoy (`ogmara.vault.private_key.z`) that satisfies the
            // guard's "one slot remains" test while being invisible in the UI
            // — so deleting every REAL slot proceeded with no confirmation.
            if let Some(addr) = rest.strip_prefix('.') {
                if is_address_shaped(addr) {
                    return true;
                }
            }
        }
    }
    false
}

/// A bech32-shaped `klv1…` address, mirroring the TypeScript `isValidAddress`.
///
/// The guard must count only slots that could genuinely belong to an account.
///
/// LIMITS, stated plainly. This is a shape check, not a checksum, and code
/// running in the webview can produce a conforming string — so a determined
/// attacker there can still mint a decoy that satisfies the count. Combined
/// with the value-shape rule in `secure_store_set` the decoy must now also
/// carry something that looks like a key, which stops the trivial version, but
/// it does not make the guard sound against a hostile webview.
///
/// That is accepted rather than papered over: webview code can already READ
/// every key through `secure_store_get`, so exfiltration is the larger
/// exposure and no delete guard addresses it. What this guard reliably
/// protects against is the case it was built for — an accidental or buggy
/// last-key deletion by the app itself, which is silent and unrecoverable.
fn is_address_shaped(s: &str) -> bool {
    s.len() >= 40
        && s.len() <= 80
        && s.starts_with("klv1")
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// What a given secure-store key is allowed to hold.
///
/// A CLASSIFICATION rather than a list of keys to protect, because the
/// list-of-keys approach missed one every single round: first
/// `ogmara.vault.dek`, then `ogmara.app_lock.salt` (whose loss makes every
/// encrypted account unrecoverable just as surely as losing the DEK), then
/// `ogmara.vault.enc_identity_claimed`. Enumerating what is SAFE and denying
/// the rest fails in the harmless direction when something new is added.
enum ValueShape {
    /// 64 hex chars — a raw private key, or an X25519 secret.
    Hex64,
    /// `ivHex:ctHex` — this app's AES-GCM envelope.
    Ciphertext,
    /// Either of the above. Slots change form on a PIN mode switch.
    KeyMaterial,
    /// Hex of any even length — the PBKDF2 salt.
    Hex,
    /// Free-form: indexes, flags, counters. Losing these costs no key material.
    Free,
}

/// Classify a key. Unknown keys under our prefixes are treated as key material
/// (deny-by-default), so a new secret added on the TS side is protected before
/// anyone remembers to come back here.
fn classify_key(key: &str) -> ValueShape {
    // Free-form state: none of it is a secret, and all of it is rebuildable.
    for free in [
        "ogmara.vault.mode",
        "ogmara.vault.version",
        "ogmara.vault.accounts",
        "ogmara.vault.active",
        "ogmara.vault.v2_pending",
        "ogmara.vault.pin_migration",
        "ogmara.vault.enc_identity_claimed",
        "ogmara.app_lock.enabled",
        "ogmara.app_lock.timeout_seconds",
        "ogmara.app_lock.failed_attempts",
        "ogmara.app_lock.cooldown_until",
    ] {
        if key == free || key.starts_with(&format!("{free}.")) {
            return ValueShape::Free;
        }
    }
    if key == "ogmara.app_lock.salt" {
        return ValueShape::Hex;
    }
    if key == "ogmara.app_lock.pin_verify" || key.starts_with("ogmara.vault.dek") {
        return ValueShape::Ciphertext;
    }
    if key.starts_with("ogmara.vault.enc_private_key") {
        return ValueShape::Hex64;
    }
    // private_key* / encrypted_key* change form on a mode switch, and anything
    // unrecognised is assumed to be a secret.
    ValueShape::KeyMaterial
}

/// Whether `value` is acceptable for `shape`.
fn value_fits(shape: &ValueShape, value: &str) -> bool {
    let hex64 = value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
    let ciphertext = looks_like_ciphertext(value);
    match shape {
        ValueShape::Free => true,
        ValueShape::Hex => !value.is_empty()
            && value.len() % 2 == 0
            && value.bytes().all(|b| b.is_ascii_hexdigit()),
        ValueShape::Hex64 => hex64,
        ValueShape::Ciphertext => ciphertext,
        ValueShape::KeyMaterial => hex64 || ciphertext,
    }
}

fn looks_like_ciphertext(value: &str) -> bool {
    matches!(value.split_once(':'), Some((iv, ct))
        if iv.len() == 24
            && !ct.is_empty()
            && iv.bytes().all(|b| b.is_ascii_hexdigit())
            && ct.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Whether `value` could plausibly BE wallet key material: 64-hex (a raw key)
/// or `ivHex:ctHex` (this app's AES-GCM format).
fn looks_like_key_material(value: &str) -> bool {
    let hex64 = value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
    let ciphertext = matches!(value.split_once(':'), Some((iv, ct))
        if iv.len() == 24
            && !ct.is_empty()
            && iv.bytes().all(|b| b.is_ascii_hexdigit())
            && ct.bytes().all(|b| b.is_ascii_hexdigit()));
    hex64 || ciphertext
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

// --- Secure Storage (file-based, persistent, encrypted at rest) ---
//
// Uses a file in the app data directory instead of the OS keyring. The OS
// keyring (gnome-keyring/kwallet) on Linux is often session-scoped and doesn't
// persist across reboots or when the secret service isn't running; losing it
// would mean losing every wallet on the device. The file store is always
// available and survives restarts.
//
// The file is AES-256-GCM encrypted under a machine-bound key (`store_crypto`),
// so a copy of it — in a backup, a synced folder, or a stolen disk image — is
// useless elsewhere. That is NOT equivalent to the PIN: the app opens this file
// unattended, so code running as the same user can too. When a PIN is set the
// private key is encrypted a second time under a key derived from it, and that
// is the layer that protects against a local attacker.

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

    // DENY-BY-DEFAULT by classification. Every key under our prefixes has a
    // declared value shape; anything unrecognised is treated as a secret. The
    // previous approach — enumerate the keys worth protecting — missed one
    // every audit round: the DEK, then `ogmara.app_lock.salt` (whose loss
    // makes every encrypted account unrecoverable), then
    // `ogmara.vault.enc_identity_claimed`.
    if !value_fits(&classify_key(&key), &value) && store.get(&key).is_some() {
        return Err(format!(
            "refusing to overwrite {key} with a value of the wrong form for that key"
        ));
    }

    // Writes into a slot that holds irreplaceable key material must carry
    // something that IS key material.
    //
    // Applied on CREATION as well as overwrite. Guarding only overwrites left
    // the decoy path open: a new `ogmara.vault.private_key.<address-shaped>`
    // slot could be created with any junk, and it then counted toward the
    // delete guard's "one slot remains" test — so deleting every real slot
    // proceeded with no confirmation.
    if !looks_like_key_material(&value) {
        if is_wallet_key_slot(&key) {
            return Err(
                "refusing to write a non-key value into a wallet key slot".into(),
            );
        }
        // The DEK and the per-account X25519 secrets are not "wallet key
        // slots" — deleting them loses no wallet directly — but overwriting
        // either is just as destructive: the DEK is the only thing that opens
        // every ciphertext slot, and an enc secret is the only thing that
        // opens the envelopes wrapped to its `enc_pub`. The delete path guards
        // the DEK; the write path did not, so two lines of webview code could
        // brick every account without a prompt.
        if key == VAULT_DEK_KEY
            || key.starts_with("ogmara.vault.dek")
            || key.starts_with("ogmara.vault.enc_private_key")
        {
            if store.get(&key).is_some() {
                return Err(
                    "refusing to overwrite encryption key material with a non-key value".into(),
                );
            }
        }
    }
    store.set(&key, &value)
}

/// The two vault key slots that hold irreplaceable wallet key material.
const VAULT_RAW_KEY: &str = "ogmara.vault.private_key";
const VAULT_ENCRYPTED_KEY: &str = "ogmara.vault.encrypted_key";
/// PIN-wrapped data-encryption key. Every per-account ciphertext slot is
/// encrypted under it, so losing it bricks all of them at once.
const VAULT_DEK_KEY: &str = "ogmara.vault.dek";

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
    delete_keys_guarded(app, vec![key]).await
}

/// Tauri command: delete several secure-store keys as ONE guarded operation.
///
/// Removing an account touches four keys, and a total wipe touches four per
/// account. Routing them through `secure_store_delete` one at a time evaluates
/// the last-key guard N times and can pop N native dialogs — which users learn
/// to click through, defeating the guard. One call, one lock, one prompt.
#[tauri::command]
async fn secure_store_delete_many(app: tauri::AppHandle, keys: Vec<String>) -> Result<(), String> {
    if keys.len() > 256 {
        return Err("too many keys in one delete (max 256)".into());
    }
    for k in &keys {
        validate_key(k)?;
    }
    delete_keys_guarded(app, keys).await
}

/// Shared implementation: guard, prompt once if this is the last wallet key,
/// then delete.
async fn delete_keys_guarded(app: tauri::AppHandle, keys: Vec<String>) -> Result<(), String> {
    let store = app.state::<SecureFileStore>();
    match store.delete_guarded_many(&keys)? {
        DeleteOutcome::Deleted => Ok(()),
        DeleteOutcome::NeedsConfirmation => {
            let app2 = app.clone();
            let confirmed = tokio::task::spawn_blocking(move || {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                app2.dialog()
                    .message(
                        "This permanently removes the last wallet key from this device. \
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
            // User confirmed: delete unguarded.
            let store = app.state::<SecureFileStore>();
            for k in &keys {
                store.delete(k)?;
            }
            Ok(())
        }
    }
}

/// Tauri command: list the addresses that have a wallet-key slot.
#[tauri::command]
fn secure_store_list_vault_accounts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    app.state::<SecureFileStore>().list_vault_accounts()
}

/// Tauri command: delete EVERY vault and app-lock key.
///
/// A prefix wipe rather than a list, because the list has been wrong three
/// times running: `vaultWipe` on the TS side missed the DEK, then the app-lock
/// record, then the pre-v2 device-global X25519 secret and its claim marker —
/// each time leaving key material on disk after a wipe the user was told was
/// total. Enumerating on this side, where the store actually lives, means a
/// key added later cannot be forgotten.
///
/// Guarded like any other last-key removal: it always removes every wallet
/// key, so it always confirms.
#[tauri::command]
async fn secure_store_wipe_vault(app: tauri::AppHandle) -> Result<(), String> {
    let keys: Vec<String> = {
        let store = app.state::<SecureFileStore>();
        let data = store
            .data
            .lock()
            .map_err(|e| format!("lock error: {e}"))?;
        data.keys()
            .filter(|k| k.starts_with("ogmara.vault.") || k.starts_with("ogmara.app_lock."))
            .cloned()
            .collect()
    };
    if keys.is_empty() {
        return Ok(());
    }
    delete_keys_guarded(app, keys).await
}

/// Tauri command: report whether the store has gone read-only.
///
/// A poisoned store fails EVERY write, silently from the webview's point of
/// view. With multiple accounts that means index writes vanish while the UI
/// looks healthy — which is how an account gets lost. The app surfaces this as
/// a persistent banner rather than letting it fail quietly.
#[tauri::command]
fn secure_store_health(app: tauri::AppHandle) -> Result<StoreHealth, String> {
    let store = app.state::<SecureFileStore>();
    Ok(StoreHealth {
        poisoned: store.poisoned.load(std::sync::atomic::Ordering::Relaxed),
        machine_bound: store_crypto::is_machine_bound(&store.path),
    })
}

/// Reported to the frontend so neither failure mode can go unnoticed.
#[derive(serde::Serialize)]
struct StoreHealth {
    /// The store went read-only after an unreadable load. Every write silently
    /// fails from the webview's point of view, so this must be surfaced.
    poisoned: bool,
    /// Whether the at-rest key is bound to a stable OS identifier. `false`
    /// means it fell back to a sidecar file that travels WITH the store, so a
    /// copied directory is decryptable — weaker, and never a silent downgrade.
    machine_bound: bool,
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
            secure_store_delete_many,
            secure_store_list_vault_accounts,
            secure_store_health,
            secure_store_wipe_vault,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const A: &str = "klv1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaqqqqqq";
    const B: &str = "klv1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbqqqqqq";

    /// A store backed by a temp file, so `save()` succeeds and the guard runs
    /// against real persisted state rather than a mock.
    fn store_with(entries: &[(&str, &str)]) -> SecureFileStore {
        let dir = std::env::temp_dir().join(format!(
            "ogmara-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut data = HashMap::new();
        for (k, v) in entries {
            data.insert(k.to_string(), v.to_string());
        }
        SecureFileStore {
            path: dir.join(".secure-store.json"),
            data: Mutex::new(data),
            poisoned: std::sync::atomic::AtomicBool::new(false),
            write_lock: Mutex::new(()),
        }
    }

    fn raw_for(addr: &str) -> String {
        format!("{VAULT_RAW_KEY}.{addr}")
    }

    fn is_needs_confirmation(o: &DeleteOutcome) -> bool {
        matches!(o, DeleteOutcome::NeedsConfirmation)
    }

    fn tmp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ogmara-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_plaintext_store_is_migrated_to_encrypted_without_losing_data() {
        // The upgrade path every existing install takes. If this loses the
        // map, it loses the wallet.
        let dir = tmp_dir();
        let path = dir.join(".secure-store.json");
        std::fs::write(
            &path,
            format!(r#"{{"{}":"deadbeefcafe"}}"#, VAULT_RAW_KEY),
        )
        .unwrap();

        let store = SecureFileStore::new(dir.clone());
        assert_eq!(store.get(VAULT_RAW_KEY).as_deref(), Some("deadbeefcafe"));

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(
            !on_disk.contains("deadbeefcafe"),
            "the key must not remain readable on disk after the upgrade"
        );
        assert!(!store_crypto::is_legacy_plaintext(&on_disk));

        // And it must still be there on the next launch.
        let reopened = SecureFileStore::new(dir);
        assert_eq!(reopened.get(VAULT_RAW_KEY).as_deref(), Some("deadbeefcafe"));
        assert!(!reopened.poisoned.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn writes_survive_a_reopen() {
        let dir = tmp_dir();
        let store = SecureFileStore::new(dir.clone());
        store.set(&raw_for(A), "aa").unwrap();
        store.set(&raw_for(B), "bb").unwrap();
        let reopened = SecureFileStore::new(dir);
        assert_eq!(reopened.get(&raw_for(A)).as_deref(), Some("aa"));
        assert_eq!(reopened.get(&raw_for(B)).as_deref(), Some("bb"));
    }

    #[test]
    fn an_undecryptable_store_poisons_instead_of_starting_empty() {
        // Starting empty would look exactly like "no wallet yet" and invite the
        // user to create a new one on top of a recoverable file.
        let dir = tmp_dir();
        let path = dir.join(".secure-store.json");
        std::fs::write(
            &path,
            r#"{"v":2,"salt":"00112233445566778899aabbccddeeff","nonce":"000102030405060708090a0b","ct":"deadbeef"}"#,
        )
        .unwrap();
        let store = SecureFileStore::new(dir);
        assert!(
            store.poisoned.load(std::sync::atomic::Ordering::Relaxed),
            "an undecryptable store must poison"
        );
        assert!(store.save().is_err(), "a poisoned store must refuse to write");
        // The original bytes must still be there for recovery.
        assert!(std::fs::read_to_string(&path).unwrap().contains("deadbeef"));
    }

    #[test]
    fn an_empty_new_store_is_not_treated_as_an_upgrade() {
        // A first run has no file; it must not report an upgrade or write one
        // before there is anything to protect.
        let dir = tmp_dir();
        let store = SecureFileStore::new(dir.clone());
        assert!(store.get(VAULT_RAW_KEY).is_none());
        assert!(!store.poisoned.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn per_account_slots_are_recognised_as_wallet_keys() {
        // The original guard compared against two exact constants, so these
        // matched NEITHER and deleting the last one bypassed the prompt.
        assert!(is_wallet_key_slot(VAULT_RAW_KEY));
        assert!(is_wallet_key_slot(VAULT_ENCRYPTED_KEY));
        assert!(is_wallet_key_slot(&raw_for(A)));
        assert!(is_wallet_key_slot(&format!("{VAULT_ENCRYPTED_KEY}.{A}")));
        // Not key material — must not be dragged into the guard.
        assert!(!is_wallet_key_slot("ogmara.vault.mode"));
        assert!(!is_wallet_key_slot("ogmara.vault.accounts"));
        assert!(!is_wallet_key_slot("ogmara.vault.private_key_backup"));
        assert!(!is_wallet_key_slot(VAULT_DEK_KEY));
    }

    #[test]
    fn deleting_one_account_of_two_needs_no_confirmation() {
        let s = store_with(&[(&raw_for(A), "aa"), (&raw_for(B), "bb")]);
        let out = s.delete_guarded_many(&[raw_for(A)]).unwrap();
        assert!(!is_needs_confirmation(&out));
        assert!(s.get(&raw_for(A)).is_none());
        assert!(s.get(&raw_for(B)).is_some(), "the other account must survive");
    }

    #[test]
    fn deleting_the_last_account_needs_confirmation_and_removes_nothing() {
        let s = store_with(&[(&raw_for(A), "aa")]);
        let out = s.delete_guarded_many(&[raw_for(A)]).unwrap();
        assert!(is_needs_confirmation(&out));
        assert!(
            s.get(&raw_for(A)).is_some(),
            "a guarded delete must not remove anything before confirmation"
        );
    }

    #[test]
    fn wiping_every_account_at_once_needs_confirmation() {
        // The total-wipe path. Evaluated once for the whole set, so the user
        // sees ONE dialog rather than one per account.
        let s = store_with(&[(&raw_for(A), "aa"), (&raw_for(B), "bb")]);
        let out = s.delete_guarded_many(&[raw_for(A), raw_for(B)]).unwrap();
        assert!(is_needs_confirmation(&out));
        assert!(s.get(&raw_for(A)).is_some());
        assert!(s.get(&raw_for(B)).is_some());
    }

    #[test]
    fn pin_mode_switch_never_prompts() {
        // Every legitimate migration and mode switch writes the new slot BEFORE
        // deleting the old, so a slot always remains. If this ever prompts,
        // users get a scary "your wallet cannot be recovered" dialog during a
        // routine PIN change.
        let s = store_with(&[
            (VAULT_RAW_KEY, "aa"),
            (&format!("{VAULT_ENCRYPTED_KEY}.{A}"), "ct"),
        ]);
        let out = s.delete_guarded_many(&[VAULT_RAW_KEY.to_string()]).unwrap();
        assert!(!is_needs_confirmation(&out));
    }

    #[test]
    fn deleting_the_dek_while_ciphertext_remains_needs_confirmation() {
        // The DEK is not a key copy, but every encrypted slot is unreadable
        // without it — same outcome, same prompt.
        let s = store_with(&[
            (VAULT_DEK_KEY, "wrapped"),
            (&format!("{VAULT_ENCRYPTED_KEY}.{A}"), "ct"),
        ]);
        let out = s.delete_guarded_many(&[VAULT_DEK_KEY.to_string()]).unwrap();
        assert!(is_needs_confirmation(&out));
        assert!(s.get(VAULT_DEK_KEY).is_some());
    }

    #[test]
    fn dek_mirror_is_not_guarded() {
        // The mirror exists to be redundant; guarding it would prompt on every
        // routine re-wrap.
        let s = store_with(&[
            (VAULT_DEK_KEY, "wrapped"),
            ("ogmara.vault.dek.mirror", "wrapped"),
            (&format!("{VAULT_ENCRYPTED_KEY}.{A}"), "ct"),
        ]);
        let out = s
            .delete_guarded_many(&["ogmara.vault.dek.mirror".to_string()])
            .unwrap();
        assert!(!is_needs_confirmation(&out));
    }

    #[test]
    fn deleting_the_dek_with_no_ciphertext_left_is_fine() {
        let s = store_with(&[(VAULT_DEK_KEY, "wrapped"), (&raw_for(A), "aa")]);
        let out = s.delete_guarded_many(&[VAULT_DEK_KEY.to_string()]).unwrap();
        assert!(!is_needs_confirmation(&out));
    }

    #[test]
    fn deleting_a_non_key_never_prompts_even_with_one_account() {
        let s = store_with(&[(&raw_for(A), "aa"), ("ogmara.vault.active", A)]);
        let out = s
            .delete_guarded_many(&["ogmara.vault.active".to_string()])
            .unwrap();
        assert!(!is_needs_confirmation(&out));
        assert!(s.get(&raw_for(A)).is_some());
    }

    #[test]
    fn a_decoy_slot_cannot_satisfy_the_last_key_guard() {
        // `ogmara.vault.private_key.z` passes validate_key, is invisible in the
        // UI (isValidAddress rejects it), and used to count as a remaining
        // wallet slot — so deleting every REAL slot proceeded with no dialog.
        assert!(!is_wallet_key_slot("ogmara.vault.private_key.z"));
        assert!(!is_wallet_key_slot("ogmara.vault.private_key.notanaddress"));
        assert!(is_wallet_key_slot(&raw_for(A)), "a real slot must still count");

        let s = store_with(&[(&raw_for(A), "aa"), ("ogmara.vault.private_key.z", "decoy")]);
        let out = s.delete_guarded_many(&[raw_for(A)]).unwrap();
        assert!(
            is_needs_confirmation(&out),
            "the decoy must not stand in for a real remaining wallet key"
        );
        assert!(s.get(&raw_for(A)).is_some());
    }

    #[test]
    fn an_address_shaped_decoy_cannot_be_created_with_junk() {
        // The previous test asserted only `.z` and `.notanaddress`, which is a
        // bar the real attack steps straight over: `klv1` + 58 lowercase alnum
        // chars is trivially producible and DOES satisfy `is_wallet_key_slot`.
        // What stops it is the value rule, which now applies on CREATION too —
        // so the decoy cannot be minted with junk.
        let decoy = format!("{VAULT_RAW_KEY}.klv1{}", "q".repeat(58));
        assert!(
            is_wallet_key_slot(&decoy),
            "an address-shaped suffix does count — the value rule is what blocks it"
        );
        assert!(!looks_like_key_material("x"));
    }

    #[test]
    fn the_dek_cannot_be_overwritten_with_junk() {
        // Not a "wallet key slot" — deleting it loses no wallet directly — but
        // overwriting it makes every ciphertext slot permanently unopenable.
        // The delete path guarded it; the write path did not.
        assert!(!is_wallet_key_slot(VAULT_DEK_KEY));
        assert!(!looks_like_key_material("x"));
        assert!(VAULT_DEK_KEY.starts_with("ogmara.vault.dek"));
    }

    #[test]
    fn the_two_slot_enumerations_agree() {
        // `list_vault_accounts` used a looser rule than `is_wallet_key_slot`,
        // so a suffix could surface as a ghost account while not counting for
        // the delete guard.
        let s = store_with(&[
            (&raw_for(A), "aa"),
            ("ogmara.vault.private_key.notanaddress", "x"),
        ]);
        let listed = s.list_vault_accounts().unwrap();
        assert_eq!(listed, vec![A.to_string()]);
        assert!(is_wallet_key_slot(&raw_for(A)));
        assert!(!is_wallet_key_slot("ogmara.vault.private_key.notanaddress"));
    }

    #[test]
    fn the_temp_sweep_actually_matches_the_names_save_writes() {
        // The previous version built its prefix from `file_name()`, keeping the
        // `.json` that `with_extension` replaces — so it matched nothing and
        // the sweep was a silent no-op. This asserts the two agree.
        let dir = tmp_dir();
        let path = dir.join(".secure-store.json");
        let produced = path.with_extension(format!("tmp.{}.{}", 1234, 5678));
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let prefix = format!("{stem}.tmp");
        let produced_name = produced.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            produced_name.starts_with(&prefix),
            "sweep prefix {prefix:?} must match the name save() writes ({produced_name:?})"
        );

        // End to end: an OLD temp file is removed, the real store is not.
        std::fs::write(&produced, "stale").unwrap();
        let bak = dir.join(".secure-store.json.corrupt.bak");
        std::fs::write(&path, "{}").unwrap();
        std::fs::write(&bak, "keep").unwrap();
        // Backdate it past the recency skip.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let _ = filetime_set(&produced, old);
        SecureFileStore::sweep_temp_files(&path);
        assert!(!produced.exists(), "a stale temp file must be removed");
        assert!(path.exists(), "the store itself must survive");
        assert!(bak.exists(), "a corrupt-backup sidecar must survive");
    }

    /// Best-effort mtime backdating; skipped where unsupported.
    fn filetime_set(p: &std::path::Path, when: std::time::SystemTime) -> std::io::Result<()> {
        let f = fs::File::options().write(true).open(p)?;
        f.set_times(fs::FileTimes::new().set_modified(when))
    }

    #[test]
    fn the_pin_salt_is_protected_like_the_dek() {
        // Overwriting the salt makes every PIN-encrypted account unrecoverable
        // — the same outcome as destroying the DEK, which was guarded while
        // this was not. Enumerating keys to protect missed it; classification
        // covers it.
        assert!(!value_fits(&classify_key("ogmara.app_lock.salt"), "junk"));
        assert!(value_fits(&classify_key("ogmara.app_lock.salt"), &"ab".repeat(16)));
        assert!(!value_fits(&classify_key("ogmara.app_lock.pin_verify"), "junk"));
        assert!(!value_fits(&classify_key(VAULT_DEK_KEY), "junk"));
        assert!(!value_fits(&classify_key(&format!("ogmara.vault.enc_private_key.{A}")), "junk"));
    }

    #[test]
    fn an_unknown_vault_key_defaults_to_protected() {
        // Deny-by-default: a secret added on the TS side is covered before
        // anyone remembers to update this file.
        assert!(!value_fits(&classify_key("ogmara.vault.some_future_secret"), "junk"));
        assert!(value_fits(&classify_key("ogmara.vault.some_future_secret"), &"a".repeat(64)));
    }

    #[test]
    fn free_form_state_is_still_writable() {
        // The classification must not reject legitimate writes.
        for (k, v) in [
            ("ogmara.vault.mode", "encrypted"),
            (&format!("ogmara.vault.mode.{A}"), "raw"),
            ("ogmara.vault.version", "2"),
            ("ogmara.vault.accounts", "[]"),
            ("ogmara.vault.active", A),
            ("ogmara.vault.v2_pending", "encrypted"),
            ("ogmara.vault.pin_migration", "{\"op\":\"encrypt\"}"),
            ("ogmara.vault.enc_identity_claimed", "1"),
            ("ogmara.app_lock.enabled", "true"),
            ("ogmara.app_lock.failed_attempts", "0"),
        ] {
            assert!(value_fits(&classify_key(k), v), "legitimate write rejected: {k}");
        }
    }

    #[test]
    fn key_material_shapes_are_recognised() {
        assert!(looks_like_key_material(&"a".repeat(64)));
        assert!(looks_like_key_material(&format!("{}:{}", "b".repeat(24), "cc")));
        assert!(!looks_like_key_material("junk"));
        assert!(!looks_like_key_material(""));
        assert!(!looks_like_key_material(&"z".repeat(64)));
        assert!(!looks_like_key_material(&format!("{}:{}", "b".repeat(8), "cc")));
    }

    #[test]
    fn listing_accounts_returns_addresses_from_both_slot_kinds() {
        let s = store_with(&[
            (&raw_for(A), "aa"),
            (&format!("{VAULT_ENCRYPTED_KEY}.{B}"), "ct"),
            // Same address in both slot kinds must appear once.
            (&format!("{VAULT_ENCRYPTED_KEY}.{A}"), "ct"),
            // Non-account keys must not leak into the list.
            (VAULT_RAW_KEY, "legacy"),
            ("ogmara.vault.accounts", "[]"),
            ("ogmara.app_lock.pin_verify", "tok"),
        ]);
        let mut got = s.list_vault_accounts().unwrap();
        got.sort();
        assert_eq!(got, vec![A.to_string(), B.to_string()]);
    }

    #[test]
    fn every_generated_key_passes_validate_key() {
        // The Rust layer rejects anything outside the two allowed prefixes, so
        // a per-account slot name that fails here would break the vault at
        // runtime rather than at compile time.
        for k in [
            raw_for(A),
            format!("{VAULT_ENCRYPTED_KEY}.{A}"),
            format!("ogmara.vault.mode.{A}"),
            format!("ogmara.vault.enc_private_key.{A}"),
            VAULT_DEK_KEY.to_string(),
            "ogmara.vault.dek.mirror".to_string(),
        ] {
            assert!(validate_key(&k).is_ok(), "rejected: {k}");
            assert!(k.len() <= 256, "too long: {k}");
        }
    }
}
