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
    pub auth: String,
    pub key_id: String,
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
            self.auth == "key" || self.auth == "password",
            "Kiểu xác thực không hợp lệ."
        );
        Ok(())
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
}
pub struct Store {
    pub data: Data,
    pub directory: PathBuf,
}
impl Store {
    pub fn load(directory: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&directory)?;
        let file = directory.join("workspace.json");
        let data = if file.exists() {
            serde_json::from_slice(&std::fs::read(file)?)?
        } else {
            Data::default()
        };
        Ok(Self { data, directory })
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
        data["home"] = serde_json::json!(dirs::home_dir().unwrap_or_default().to_string_lossy());
        data
    }
    pub fn add_key(&mut self, name: String, private: &str, passphrase: &str) -> anyhow::Result<()> {
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
}
