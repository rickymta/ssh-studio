use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, OsRng, rand_core::RngCore},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use russh::keys::{HashAlg, decode_secret_key};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    /// `password` | `key` | `agent` | `interactive` (keyboard-interactive / MFA).
    pub auth: String,
    pub key_id: String,
    /// Saved host used as ProxyJump (empty: direct connection).
    #[serde(default)]
    pub jump_host_id: String,
    #[serde(default)]
    pub proxy: Proxy,
    /// Port forwards started automatically when the session connects (F5).
    #[serde(default)]
    pub forwards: Vec<crate::forward::Spec>,
    /// Login password the user chose to remember, sealed in the vault (empty: ask on every
    /// connection). Never sent to the frontend: the snapshot only has `hasSavedPassword`.
    #[serde(default)]
    pub password_secret: String,
    /// Password typed in the server form; moved into `password_secret`, never serialized.
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    /// Set by the server form to drop the remembered password; never serialized.
    #[serde(default, skip_serializing)]
    pub forget_password: bool,
}
/// Methods where a remembered password is used (as the password, or to answer the server's
/// own "Password:" question over keyboard-interactive). OTP answers are never remembered.
pub fn remembers_password(auth: &str) -> bool {
    matches!(auth, "password" | "interactive")
}
pub const AUTH_METHODS: [&str; 4] = ["password", "key", "agent", "interactive"];

/// SOCKS5 / HTTP CONNECT proxy. The password only exists encrypted in `secret` (vault); the
/// plain `password` field is accepted from the frontend when saving and never serialized.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Proxy {
    /// `none` | `socks5` | `http` (empty means none).
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub secret: String,
    #[serde(skip_serializing)]
    pub password: Option<String>,
}
impl Proxy {
    pub fn enabled(&self) -> bool {
        !self.kind.is_empty() && self.kind != "none"
    }
    pub fn password(&self) -> anyhow::Result<Option<String>> {
        if self.secret.is_empty() {
            Ok(None)
        } else {
            Ok(Some(unlock(&self.secret)?))
        }
    }
}
impl Host {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.name.trim().is_empty()
                && !self.host.trim().is_empty()
                && !self.username.trim().is_empty()
                && self.port > 0,
            "Điền tên, địa chỉ, username và port hợp lệ."
        );
        anyhow::ensure!(
            AUTH_METHODS.contains(&self.auth.as_str()),
            "Kiểu xác thực không hợp lệ."
        );
        anyhow::ensure!(
            self.jump_host_id != self.id,
            "Server không thể làm jump host cho chính nó."
        );
        match self.proxy.kind.as_str() {
            "" | "none" => {}
            "socks5" | "http" => anyhow::ensure!(
                !self.proxy.host.trim().is_empty() && self.proxy.port > 0,
                "Điền địa chỉ và port của proxy."
            ),
            _ => anyhow::bail!("Kiểu proxy không hợp lệ."),
        }
        anyhow::ensure!(
            !self.proxy.enabled() || self.jump_host_id.is_empty(),
            "Chọn jump host hoặc proxy, không dùng cả hai cho cùng server."
        );
        for forward in &self.forwards {
            forward.validate()?;
        }
        Ok(())
    }
    /// Moves a proxy password typed in the form into the vault. `previous` is the stored
    /// version of this host: an empty password keeps its secret (same proxy user).
    pub fn seal_proxy_password(&mut self, previous: Option<&Host>) -> anyhow::Result<()> {
        let typed = self.proxy.password.take().unwrap_or_default();
        self.proxy.secret = if !self.proxy.enabled() || self.proxy.username.is_empty() {
            String::new()
        } else if !typed.is_empty() {
            encrypt(typed.as_bytes(), &master_key()?)?
        } else {
            previous
                .filter(|p| p.proxy.username == self.proxy.username)
                .map(|p| p.proxy.secret.clone())
                .unwrap_or_default()
        };
        Ok(())
    }
    /// Applies the server form's password choice. The frontend never sees the sealed value,
    /// so it is taken from `previous` (the stored host): kept unless the user typed a new
    /// password, asked to forget it, or changed the login (address, port, user, method).
    pub fn seal_login_password(&mut self, previous: Option<&Host>) -> anyhow::Result<()> {
        let typed = self.password.take().unwrap_or_default();
        let forget = std::mem::take(&mut self.forget_password);
        let same_login = |p: &&Host| {
            p.host == self.host
                && p.port == self.port
                && p.username == self.username
                && remembers_password(&p.auth)
        };
        self.password_secret = if forget || !remembers_password(&self.auth) {
            String::new()
        } else if !typed.is_empty() {
            seal(typed.as_bytes())?
        } else {
            previous
                .filter(same_login)
                .map(|p| p.password_secret.clone())
                .unwrap_or_default()
        };
        Ok(())
    }
    pub fn saved_password(&self) -> anyhow::Result<Option<String>> {
        if self.password_secret.is_empty() || !remembers_password(&self.auth) {
            Ok(None)
        } else {
            Ok(Some(unlock(&self.password_secret)?))
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub id: String,
    pub name: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
    pub secret: String,
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    pub hosts: Vec<Host>,
    pub keys: Vec<Key>,
    pub known_hosts: BTreeMap<String, String>,
    /// Older workspace files have no settings; they start with the defaults (F7).
    #[serde(default)]
    pub settings: Settings,
}

/// Application preferences (F7). Unknown or missing fields fall back to the defaults.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub font_family: String,
    pub font_size: u8,
    pub line_height: f32,
    pub scrollback: u32,
    /// `block` | `bar` | `underline`.
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub copy_on_select: bool,
    /// View of new sessions: `terminal` | `files` | `split`.
    pub default_view: String,
    /// Ask before closing a connected session or the window with work in progress.
    pub confirm_close: bool,
    /// Closing the window hides it to the system tray; sessions keep running.
    pub close_to_tray: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            font_family: "Cascadia Code, Consolas, monospace".into(),
            font_size: 14,
            line_height: 1.3,
            scrollback: 10_000,
            cursor_style: "block".into(),
            cursor_blink: true,
            copy_on_select: false,
            default_view: "terminal".into(),
            confirm_close: true,
            close_to_tray: false,
        }
    }
}
pub const FONT_SIZES: std::ops::RangeInclusive<u8> = 8..=32;
impl Settings {
    /// Clamps numbers into usable ranges and replaces unknown choices with the defaults.
    pub fn normalized(mut self) -> Self {
        let defaults = Self::default();
        self.font_family = self.font_family.trim().chars().take(200).collect();
        if self.font_family.is_empty() {
            self.font_family = defaults.font_family;
        }
        self.font_size = self.font_size.clamp(*FONT_SIZES.start(), *FONT_SIZES.end());
        self.line_height = if self.line_height.is_finite() {
            self.line_height.clamp(1.0, 2.0)
        } else {
            defaults.line_height
        };
        self.scrollback = self.scrollback.clamp(500, 100_000);
        if !["block", "bar", "underline"].contains(&self.cursor_style.as_str()) {
            self.cursor_style = defaults.cursor_style;
        }
        if !["terminal", "files", "split"].contains(&self.default_view.as_str()) {
            self.default_view = defaults.default_view;
        }
        self
    }
}
pub struct Store {
    pub data: Data,
    pub directory: PathBuf,
    /// Name of the corrupt workspace file that was set aside at startup, if any.
    pub recovered: Option<String>,
}
/// Key names are shown in lists and selects: 1–100 characters after trimming.
pub fn key_name(name: &str) -> anyhow::Result<String> {
    let name = name.trim();
    anyhow::ensure!(
        !name.is_empty() && name.chars().count() <= 100,
        "Tên key phải có từ 1 đến 100 ký tự."
    );
    Ok(name.to_string())
}
impl Store {
    pub fn load(directory: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&directory)?;
        let file = directory.join("workspace.json");
        let mut recovered = None;
        let data = if file.exists() {
            let bytes = std::fs::read(&file)?;
            match serde_json::from_slice(&bytes) {
                Ok(data) => data,
                Err(_) => {
                    // Keep the damaged file for manual recovery and start with an empty workspace.
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let name = format!("workspace.json.corrupt-{stamp}");
                    std::fs::rename(&file, directory.join(&name))?;
                    recovered = Some(name);
                    Data::default()
                }
            }
        } else {
            Data::default()
        };
        Ok(Self {
            data,
            directory,
            recovered,
        })
    }
    pub fn save(&self) -> anyhow::Result<()> {
        let content = serde_json::to_vec_pretty(&self.data)?;
        let target = self.directory.join("workspace.json");
        let temp = self.directory.join("workspace.json.tmp");
        std::fs::write(&temp, content)?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&temp)?
            .sync_all()?;
        std::fs::rename(temp, target)?;
        Ok(())
    }
    pub fn snapshot(&self) -> serde_json::Value {
        let mut data = serde_json::to_value(&self.data).unwrap();
        for key in data["keys"].as_array_mut().unwrap() {
            key.as_object_mut().unwrap().remove("secret");
        }
        for host in data["hosts"].as_array_mut().unwrap() {
            let saved = host
                .as_object_mut()
                .unwrap()
                .remove("passwordSecret")
                .is_some_and(|s| s.as_str().is_some_and(|s| !s.is_empty()));
            host["hasSavedPassword"] = serde_json::json!(saved);
            if let Some(proxy) = host["proxy"].as_object_mut() {
                let saved = proxy
                    .remove("secret")
                    .is_some_and(|s| s.as_str().is_some_and(|s| !s.is_empty()));
                proxy.insert("hasPassword".into(), serde_json::json!(saved));
            }
        }
        data["home"] = serde_json::json!(dirs::home_dir().unwrap_or_default().to_string_lossy());
        data["os"] = serde_json::json!(std::env::consts::OS);
        data["recovered"] = serde_json::json!(self.recovered);
        data
    }
    pub fn add_key(&mut self, name: String, private: &str, passphrase: &str) -> anyhow::Result<()> {
        let name = key_name(&name)?;
        let key = decode_secret_key(
            private,
            if passphrase.is_empty() {
                None
            } else {
                Some(passphrase)
            },
        )?;
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        anyhow::ensure!(
            !self.data.keys.iter().any(|k| k.fingerprint == fingerprint),
            "Key đã có trong thư viện."
        );
        self.data.keys.push(Key {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            algorithm: key.algorithm().to_string(),
            fingerprint,
            public_key: key.public_key().to_openssh()?,
            secret: encrypt(
                key.to_openssh(russh::keys::ssh_key::LineEnding::LF)?
                    .as_bytes(),
                &master_key()?,
            )?,
        });
        self.save()
    }
}
fn master_key() -> anyhow::Result<Vec<u8>> {
    // Serialize get-or-create so two first-time callers never generate different keys.
    static CREATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = CREATE.lock().unwrap_or_else(|e| e.into_inner());
    let entry = keyring::Entry::new(credential_service(), "vault-master-key")?;
    match entry.get_password() {
        Ok(value) => {
            let key = STANDARD.decode(value)?;
            anyhow::ensure!(key.len() == 32, "Master key không hợp lệ.");
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = vec![0; 32];
            OsRng.fill_bytes(&mut key);
            entry.set_password(&STANDARD.encode(&key))?;
            Ok(key)
        }
        Err(error) => Err(error.into()),
    }
}
#[cfg(not(test))]
fn credential_service() -> &'static str {
    "dev.sshstudio.desktop"
}
#[cfg(test)]
pub fn credential_service() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| format!("dev.sshstudio.integration.{}", uuid::Uuid::new_v4()))
}
/// Encrypts a secret (private key, proxy password) with the vault master key.
pub fn seal(bytes: &[u8]) -> anyhow::Result<String> {
    encrypt(bytes, &master_key()?)
}
pub fn unlock(secret: &str) -> anyhow::Result<String> {
    Ok(String::from_utf8(decrypt(secret, &master_key()?)?)?)
}
fn encrypt(bytes: &[u8], key: &[u8]) -> anyhow::Result<String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), bytes)
        .map_err(|_| anyhow::anyhow!("Không mã hóa được key"))?;
    Ok(STANDARD.encode([nonce.to_vec(), encrypted].concat()))
}
fn decrypt(secret: &str, key: &[u8]) -> anyhow::Result<Vec<u8>> {
    let bytes = STANDARD.decode(secret)?;
    anyhow::ensure!(bytes.len() >= 28, "Dữ liệu key bị hỏng");
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| anyhow::anyhow!("Invalid encryption key"))?
        .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("Không giải mã được SSH key"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vault_detects_tampering() {
        let k = [7; 32];
        let value = encrypt(b"private-key", &k).unwrap();
        assert_eq!(decrypt(&value, &k).unwrap(), b"private-key");
        assert!(decrypt(&value, &[8; 32]).is_err());
        let mut bytes = STANDARD.decode(value).unwrap();
        bytes[20] ^= 1;
        assert!(decrypt(&STANDARD.encode(bytes), &k).is_err());
    }
    #[test]
    fn settings_default_for_old_files_and_are_clamped() {
        // A v0.1 workspace has no "settings" key.
        let old: Data = serde_json::from_str(r#"{"hosts":[],"keys":[],"knownHosts":{}}"#).unwrap();
        assert_eq!(old.settings, Settings::default());
        // Partial settings keep the other defaults.
        let partial: Settings = serde_json::from_str(r#"{"fontSize":18}"#).unwrap();
        assert_eq!(partial.font_size, 18);
        assert!(partial.confirm_close);
        let wild = Settings {
            font_family: "   ".into(),
            font_size: 200,
            line_height: f32::NAN,
            scrollback: 5,
            cursor_style: "beam".into(),
            default_view: "ports".into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(wild.font_family, Settings::default().font_family);
        assert_eq!(wild.font_size, 32);
        assert_eq!(wild.line_height, 1.3);
        assert_eq!(wild.scrollback, 500);
        assert_eq!(wild.cursor_style, "block");
        assert_eq!(wild.default_view, "terminal");
        // Saved and loaded back.
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::load(dir.path().to_owned()).unwrap();
        store.data.settings.close_to_tray = true;
        store.save().unwrap();
        let loaded = Store::load(dir.path().to_owned()).unwrap();
        assert!(loaded.data.settings.close_to_tray);
        assert_eq!(loaded.snapshot()["settings"]["closeToTray"], true);
    }
    #[test]
    fn snapshot_never_exposes_private_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::load(dir.path().to_owned()).unwrap();
        store.data.keys.push(Key {
            id: "a".into(),
            name: "n".into(),
            algorithm: "ed25519".into(),
            fingerprint: "f".into(),
            public_key: "pub".into(),
            secret: "PRIVATE".into(),
        });
        assert!(!store.snapshot().to_string().contains("PRIVATE"));
        store.save().unwrap();
        store.save().unwrap();
        assert_eq!(
            Store::load(dir.path().to_owned()).unwrap().data.keys.len(),
            1
        );
    }
    #[test]
    fn corrupt_workspace_is_set_aside_instead_of_crashing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("workspace.json"), b"{ not json").unwrap();
        let store = Store::load(dir.path().to_owned()).unwrap();
        assert!(store.data.hosts.is_empty());
        let name = store.recovered.clone().unwrap();
        assert!(name.starts_with("workspace.json.corrupt-"));
        assert_eq!(
            std::fs::read(dir.path().join(&name)).unwrap(),
            b"{ not json"
        );
        assert!(!dir.path().join("workspace.json").exists());
        assert_eq!(store.snapshot()["recovered"], name.as_str());
        store.save().unwrap();
        assert!(
            Store::load(dir.path().to_owned())
                .unwrap()
                .recovered
                .is_none()
        );
    }
    #[test]
    fn proxy_password_is_sealed_and_never_exposed() {
        let _vault = crate::integration::fixture::VaultGuard::new();
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::load(dir.path().to_owned()).unwrap();
        let host_json = serde_json::json!({
            "id": "h", "name": "n", "host": "example.test", "port": 22, "username": "u",
            "group": "", "auth": "password", "keyId": "",
            "proxy": {"kind": "socks5", "host": "proxy.test", "port": 1080,
                      "username": "alice", "password": "proxy-secret-pw"}
        });
        let mut host: Host = serde_json::from_value(host_json.clone()).unwrap();
        host.validate().unwrap();
        host.seal_proxy_password(None).unwrap();
        assert!(host.proxy.password.is_none());
        assert_eq!(host.proxy.password().unwrap().unwrap(), "proxy-secret-pw");
        store.data.hosts.push(host.clone());
        store.save().unwrap();
        let disk = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        assert!(!disk.contains("proxy-secret-pw"));
        let snapshot = store.snapshot().to_string();
        assert!(!snapshot.contains("proxy-secret-pw"));
        assert!(!snapshot.contains(&host.proxy.secret));
        assert_eq!(store.snapshot()["hosts"][0]["proxy"]["hasPassword"], true);

        // Re-saving with an empty password keeps the secret; another user drops it.
        let mut edited: Host = serde_json::from_value(host_json.clone()).unwrap();
        edited.proxy.password = None;
        edited.seal_proxy_password(Some(&host)).unwrap();
        assert_eq!(edited.proxy.secret, host.proxy.secret);
        edited.proxy.username = "bob".into();
        edited.seal_proxy_password(Some(&host)).unwrap();
        assert!(edited.proxy.secret.is_empty());

        // The login password follows the same rules, and is dropped on request or when the
        // login changes.
        let mut login = host.clone();
        login.password = Some("login-secret-pw".into());
        login.seal_login_password(None).unwrap();
        assert!(login.password.is_none());
        assert_eq!(login.saved_password().unwrap().unwrap(), "login-secret-pw");
        store.data.hosts = vec![login.clone()];
        store.save().unwrap();
        let disk = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        let snapshot = store.snapshot();
        assert!(!disk.contains("login-secret-pw"));
        assert!(!snapshot.to_string().contains("login-secret-pw"));
        assert!(!snapshot.to_string().contains(&login.password_secret));
        assert_eq!(snapshot["hosts"][0]["hasSavedPassword"], true);
        let mut kept = host.clone();
        kept.seal_login_password(Some(&login)).unwrap();
        assert_eq!(kept.password_secret, login.password_secret);
        let mut forgotten = host.clone();
        forgotten.forget_password = true;
        forgotten.seal_login_password(Some(&login)).unwrap();
        assert!(forgotten.password_secret.is_empty());
        let changes: [fn(&mut Host); 3] = [
            |h| h.username = "root".into(),
            |h| h.port = 2222,
            |h| h.auth = "key".into(),
        ];
        for change in changes {
            let mut moved = host.clone();
            change(&mut moved);
            moved.seal_login_password(Some(&login)).unwrap();
            assert!(moved.password_secret.is_empty());
        }
        // A sealed value sent back by a client is never trusted.
        let mut injected = host.clone();
        injected.password_secret = login.password_secret.clone();
        injected.seal_login_password(None).unwrap();
        assert!(injected.password_secret.is_empty());

        let mut bad = host.clone();
        bad.jump_host_id = "other".into();
        assert!(bad.validate().is_err(), "proxy and jump host together");
        bad.proxy.kind = "none".into();
        bad.jump_host_id = "h".into();
        assert!(bad.validate().is_err(), "self jump");
        bad.jump_host_id.clear();
        bad.auth = "telnet".into();
        assert!(bad.validate().is_err());
    }
    #[test]
    fn hosts_saved_by_v0_1_still_load() {
        let host: Host = serde_json::from_value(serde_json::json!({
            "id": "h", "name": "n", "host": "x", "port": 22, "username": "u",
            "group": "", "auth": "key", "keyId": "k"
        }))
        .unwrap();
        assert!(host.jump_host_id.is_empty() && !host.proxy.enabled());
        host.validate().unwrap();
    }
    #[test]
    fn key_names_are_validated() {
        assert!(key_name("").is_err());
        assert!(key_name("   ").is_err());
        assert!(key_name(&"k".repeat(101)).is_err());
        assert_eq!(key_name("  Work laptop ").unwrap(), "Work laptop");
        assert!(key_name(&"ă".repeat(100)).is_ok());
    }
}
