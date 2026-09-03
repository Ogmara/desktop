//! At-rest encryption for the secure store.
//!
//! # What this does and does not protect
//!
//! The store file is encrypted with AES-256-GCM under a key derived from a
//! **machine-bound secret**, so the file ALONE is useless: a copy in a backup,
//! a synced folder, a stolen disk image, or another user's hands does not
//! yield wallet keys.
//!
//! It is NOT a substitute for the app PIN, and must never be described as one.
//! The app decrypts this file unattended at startup, so the unwrapping key is
//! necessarily reachable on the same machine — code running as the same user
//! can do exactly what the app does. Only the PIN, which is never stored,
//! protects key material against a local attacker; with a PIN set, private
//! keys are encrypted a second time under a PIN-derived key and this layer is
//! defence in depth.
//!
//! # Why machine-bound rather than the OS keyring
//!
//! Using the keyring to hold the wrapping key would be stronger, but on Linux
//! gnome-keyring/kwallet is frequently session-scoped and unavailable — the
//! documented reason this store is a file in the first place. A keyring entry
//! that silently disappears would make every wallet on the device permanently
//! unopenable, which is a worse failure than the one being fixed. The machine
//! secret is derived from a stable OS identifier, so it survives reboots and
//! app updates.
//!
//! # Failure policy
//!
//! Decryption failure NEVER destroys the file. It surfaces as a load error,
//! the caller preserves the original to a `.bak` sidecar and marks the store
//! poisoned (read-only), and the user is told. Overwriting an
//! undecryptable-but-present store is how a wallet gets lost for good.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::path::Path;
use zeroize::Zeroize;

/// Bound into the KDF so this key can never collide with another use of the
/// same machine secret.
const KDF_INFO: &[u8] = b"ogmara.secure-store.v2";

/// Authenticated (not encrypted) alongside the ciphertext, so a file from a
/// different format version cannot be silently reinterpreted.
const AAD: &[u8] = b"ogmara.secure-store.v2";

/// On-disk envelope. Only `v` is meaningful without the key.
#[derive(Serialize, Deserialize)]
pub struct Envelope {
    /// Format version. 2 = encrypted. A bare JSON object is the v1 plaintext.
    pub v: u8,
    /// Per-file random KDF salt. Public by design — the secret is the machine
    /// identifier, not this.
    pub salt: String,
    pub nonce: String,
    pub ct: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// A stable per-machine identifier.
///
/// Not a secret in the cryptographic sense — on Linux `/etc/machine-id` is
/// world-readable — but it does not travel with the store file, which is
/// exactly the property needed: the file alone cannot be decrypted elsewhere.
fn machine_id() -> Option<Vec<u8>> {
    #[cfg(target_os = "linux")]
    {
        for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(s) = std::fs::read_to_string(p) {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.as_bytes().to_vec());
                }
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let line = s.lines().find(|l| l.contains("IOPlatformUUID"))?;
        let uuid = line.split('"').nth(3)?;
        if uuid.is_empty() {
            return None;
        }
        Some(uuid.as_bytes().to_vec())
    }
    #[cfg(target_os = "windows")]
    {
        // Absolute path: bare `reg` lets CreateProcess resolve the application
        // directory before PATH, which is a hijack vector. macOS already uses
        // an absolute `/usr/sbin/ioreg`.
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let out = std::process::Command::new(format!(r"{system_root}\System32\reg.exe"))
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let guid = s.split_whitespace().last()?;
        if guid.is_empty() {
            return None;
        }
        Some(guid.as_bytes().to_vec())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// The machine secret, with a per-install fallback.
///
/// If no OS identifier is available the fallback is a random 32-byte value in a
/// 0600 sidecar next to the store. That is **weaker** — an attacker who copies
/// the store directory gets the sidecar too — but it keeps the app usable on
/// platforms without a stable identifier, and it is still stronger than the
/// plaintext store it replaces. The app reports which mode is in effect so this
/// is never a silent downgrade.
fn machine_secret(store_path: &Path) -> Result<(Vec<u8>, bool), String> {
    if let Some(id) = machine_id() {
        return Ok((id, true));
    }
    let side = store_path.with_extension("machine-key");
    if let Ok(s) = std::fs::read_to_string(&side) {
        if let Some(b) = unhex(s.trim()) {
            if b.len() == 32 {
                return Ok((b, false));
            }
        }
    }
    let mut fresh = [0u8; 32];
    getrandom::fill(&mut fresh).map_err(|e| format!("rng error: {e}"))?;
    let encoded = hex(&fresh);
    // Created 0600 ATOMICALLY. On a system with no OS identifier this file IS
    // the wrapping key, and `fs::write` + chmod left it world-readable for the
    // duration of the write.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&side)
            .map_err(|e| format!("sidecar write error: {e}"))?;
        f.write_all(encoded.as_bytes())
            .map_err(|e| format!("sidecar write error: {e}"))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&side, &encoded).map_err(|e| format!("sidecar write error: {e}"))?;
    Ok((fresh.to_vec(), false))
}

/// Whether the key is bound to a stable OS identifier (`true`) or to a sidecar
/// file that travels with the store (`false`).
///
/// Reads only. It used to go through `machine_secret`, which CREATES the
/// sidecar when no OS identifier exists — so the health probe, called on every
/// boot, minted key material as a side effect.
pub fn is_machine_bound(_store_path: &Path) -> bool {
    machine_id().is_some()
}

fn derive_key(secret: &[u8], salt: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), secret);
    let mut out = [0u8; 32];
    // Only fails for absurd output lengths; 32 bytes cannot.
    hk.expand(KDF_INFO, &mut out).expect("hkdf expand");
    out
}

/// Encrypt `plaintext` into a serialized envelope.
pub fn seal(store_path: &Path, plaintext: &[u8]) -> Result<String, String> {
    let (secret, _) = machine_secret(store_path)?;
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| format!("rng error: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut nonce_bytes).map_err(|e| format!("rng error: {e}"))?;

    let mut key_bytes = derive_key(&secret, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let result = cipher.encrypt(
        Nonce::from_slice(&nonce_bytes),
        Payload { msg: plaintext, aad: AAD },
    );
    // Before the `?`, not after it: the previous version returned on the error
    // path with the derived key still in memory.
    key_bytes.zeroize();
    let ct = result.map_err(|_| "encrypt failed".to_string())?;

    serde_json::to_string_pretty(&Envelope {
        v: 2,
        salt: hex(&salt),
        nonce: hex(&nonce_bytes),
        ct: hex(&ct),
    })
    .map_err(|e| format!("serialize error: {e}"))
}

/// Decrypt a serialized envelope.
///
/// Returns `Err` for a corrupt, truncated, or foreign-machine file. The caller
/// MUST treat that as "preserve and refuse to write", never as "start fresh".
pub fn open(store_path: &Path, contents: &str) -> Result<Vec<u8>, String> {
    let env: Envelope =
        serde_json::from_str(contents).map_err(|e| format!("not an envelope: {e}"))?;
    if env.v != 2 {
        return Err(format!("unsupported store version {}", env.v));
    }
    let salt = unhex(&env.salt).ok_or("bad salt encoding")?;
    let nonce = unhex(&env.nonce).ok_or("bad nonce encoding")?;
    let ct = unhex(&env.ct).ok_or("bad ciphertext encoding")?;
    if nonce.len() != 12 {
        return Err("bad nonce length".into());
    }
    let (secret, _) = machine_secret(store_path)?;
    let mut key_bytes = derive_key(&secret, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let result = cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: AAD });
    key_bytes.zeroize();
    Ok(result.map_err(|_| "decrypt failed — wrong machine, or the file was modified".to_string())?)
}

/// Whether `contents` is the pre-encryption plaintext format (a bare JSON map).
pub fn is_legacy_plaintext(contents: &str) -> bool {
    serde_json::from_str::<std::collections::HashMap<String, String>>(contents).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ogmara-sc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d.join(".secure-store.json")
    }

    #[test]
    fn seal_then_open_round_trips() {
        let p = tmp();
        let secret = br#"{"ogmara.vault.private_key":"deadbeef"}"#;
        let sealed = seal(&p, secret).unwrap();
        assert_eq!(open(&p, &sealed).unwrap(), secret);
    }

    #[test]
    fn the_key_material_never_appears_in_the_file() {
        // The whole point: a copy of this file must not yield the wallet.
        let p = tmp();
        let sealed = seal(&p, br#"{"ogmara.vault.private_key":"deadbeefcafe"}"#).unwrap();
        assert!(!sealed.contains("deadbeefcafe"));
        assert!(!sealed.contains("private_key"));
    }

    #[test]
    fn a_tampered_ciphertext_is_rejected_not_silently_accepted() {
        // AES-GCM is authenticated; a flipped byte must fail, not decrypt to
        // garbage that then parses as an empty store and looks like "no wallet".
        let p = tmp();
        let sealed = seal(&p, b"{}").unwrap();
        let mut env: Envelope = serde_json::from_str(&sealed).unwrap();
        let mut ct = unhex(&env.ct).unwrap();
        ct[0] ^= 0xff;
        env.ct = hex(&ct);
        let tampered = serde_json::to_string(&env).unwrap();
        assert!(open(&p, &tampered).is_err());
    }

    #[test]
    fn a_file_from_another_machine_fails_to_open() {
        // Simulated by changing the salt, which changes the derived key exactly
        // as a different machine secret would.
        let p = tmp();
        let sealed = seal(&p, b"{}").unwrap();
        let mut env: Envelope = serde_json::from_str(&sealed).unwrap();
        env.salt = hex(&[0x11u8; 16]);
        assert!(open(&p, &serde_json::to_string(&env).unwrap()).is_err());
    }

    #[test]
    fn each_seal_uses_a_fresh_nonce_and_salt() {
        // Nonce reuse under one key is catastrophic for GCM, and this function
        // runs on every save.
        let p = tmp();
        let a: Envelope = serde_json::from_str(&seal(&p, b"{}").unwrap()).unwrap();
        let b: Envelope = serde_json::from_str(&seal(&p, b"{}").unwrap()).unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.salt, b.salt);
    }

    #[test]
    fn legacy_plaintext_is_recognised_and_an_envelope_is_not() {
        assert!(is_legacy_plaintext(r#"{"ogmara.vault.private_key":"ab"}"#));
        assert!(is_legacy_plaintext("{}"));
        let p = tmp();
        assert!(!is_legacy_plaintext(&seal(&p, b"{}").unwrap()));
    }
}
