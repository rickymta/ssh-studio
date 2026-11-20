//! F6: private key export and password-protected vault backups.
//!
//! A backup holds hosts (with forwards), decrypted private keys, proxy passwords and known
//! hosts, encrypted with AES-256-GCM under a key derived from the backup password with
//! Argon2id (random salt, parameters stored in the file and authenticated as AAD). It does not
//! depend on this machine's Credential Manager, so it restores on another computer.
use crate::store::{self, Host, Key, Store};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, OsRng, Payload as AeadPayload, rand_core::RngCore},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use russh::keys::{HashAlg, decode_secret_key, ssh_key::LineEnding};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

pub const MIN_PASSWORD: usize = 8;
const FORMAT: &str = "sshstudio-backup";
const VERSION: u32 = 1;
/// OWASP baseline for Argon2id: 19 MiB, 2 passes, 1 lane.
const MEMORY_KIB: u32 = 19 * 1024;
const ITERATIONS: u32 = 2;

#[derive(Clone, Serialize, Deserialize)]
struct Kdf {
    name: String,
    memory: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    kdf: Kdf,
    nonce: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupKey {
    id: String,
    name: String,
    /// OpenSSH private key, unencrypted inside the encrypted backup.
    private: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contents {
    created: u64,
    app_version: String,
    /// Hosts without their vault-sealed proxy secret (see `proxy_passwords`).
    hosts: Vec<Host>,
    keys: Vec<BackupKey>,
    #[serde(default)]
    proxy_passwords: BTreeMap<String, String>,
    known_hosts: BTreeMap<String, String>,
}

fn derive(password: &str, kdf: &Kdf) -> anyhow::Result<[u8; 32]> {
    anyhow::ensure!(kdf.name == "argon2id", "Thuật toán KDF không hỗ trợ.");
    anyhow::ensure!(
        kdf.memory <= 1024 * 1024 && kdf.iterations <= 16 && kdf.parallelism <= 8,
        "Tham số backup không hợp lệ."
    );
    let salt = STANDARD.decode(&kdf.salt)?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(kdf.memory, kdf.iterations, kdf.parallelism, Some(32))
            .map_err(|e| anyhow::anyhow!("Tham số Argon2 không hợp lệ: {e}"))?,
    )
    .hash_password_into(password.as_bytes(), &salt, &mut key)
    .map_err(|e| anyhow::anyhow!("Argon2: {e}"))?;
    Ok(key)
}

/// The header is authenticated: changing the KDF parameters breaks decryption.
fn aad(version: u32, kdf: &Kdf) -> anyhow::Result<Vec<u8>> {
    Ok(format!("{FORMAT}|{version}|{}", serde_json::to_string(kdf)?).into_bytes())
}

fn write_private(path: &Path, text: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(text)?;
    file.sync_all()?;
    Ok(())
}

/// Writes a vault key as an OpenSSH private key file, optionally passphrase-protected.
/// `path` comes from the save dialog, which already confirmed replacing an existing file.
pub fn export_key(
    store: &Store,
    key_id: &str,
    path: &Path,
    passphrase: &str,
) -> anyhow::Result<()> {
    let key = store
        .data
        .keys
        .iter()
        .find(|k| k.id == key_id)
        .ok_or_else(|| anyhow::anyhow!("Không tìm thấy SSH key."))?;
    let mut private = decode_secret_key(&store::unlock(&key.secret)?, None)?;
    if !passphrase.is_empty() {
        private = private.encrypt(&mut rand::rng(), passphrase)?;
    }
    write_private(path, private.to_openssh(LineEnding::LF)?.as_bytes())
}

/// Encrypts the whole workspace into `path`. Returns what it contains.
pub fn create(store: &Store, path: &Path, password: &str) -> anyhow::Result<Value> {
    anyhow::ensure!(
        password.chars().count() >= MIN_PASSWORD,
        "Mật khẩu backup cần ít nhất {MIN_PASSWORD} ký tự."
    );
    let mut proxy_passwords = BTreeMap::new();
    let hosts = store
        .data
        .hosts
        .iter()
        .map(|host| {
            let mut host = host.clone();
            if let Some(password) = host.proxy.password()? {
                proxy_passwords.insert(host.id.clone(), password);
            }
            host.proxy.secret.clear();
            Ok(host)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let keys = store
        .data
        .keys
        .iter()
        .map(|k| {
            Ok(BackupKey {
                id: k.id.clone(),
                name: k.name.clone(),
                private: store::unlock(&k.secret)?,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let contents = Contents {
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        hosts,
        keys,
        proxy_passwords,
        known_hosts: store.data.known_hosts.clone(),
    };
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let kdf = Kdf {
        name: "argon2id".into(),
        memory: MEMORY_KIB,
        iterations: ITERATIONS,
        parallelism: 1,
        salt: STANDARD.encode(salt),
    };
    let key = derive(password, &kdf)?;
    let plain = serde_json::to_vec(&contents)?;
    let sealed = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("Khóa không hợp lệ"))?
        .encrypt(
            Nonce::from_slice(&nonce),
            AeadPayload {
                msg: &plain,
                aad: &aad(VERSION, &kdf)?,
            },
        )
        .map_err(|_| anyhow::anyhow!("Không mã hóa được backup"))?;
    let envelope = Envelope {
        format: FORMAT.into(),
        version: VERSION,
        kdf,
        nonce: STANDARD.encode(nonce),
        data: STANDARD.encode(sealed),
    };
    write_private(path, &serde_json::to_vec_pretty(&envelope)?)?;
    Ok(json!({
        "hosts": contents.hosts.len(),
        "keys": contents.keys.len(),
        "knownHosts": contents.known_hosts.len(),
    }))
}

fn open(path: &Path, password: &str) -> anyhow::Result<Contents> {
    let bytes = std::fs::read(path)?;
    anyhow::ensure!(bytes.len() < 64 * 1024 * 1024, "File backup quá lớn.");
    let envelope: Envelope = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Đây không phải file backup của SSH Studio."))?;
    anyhow::ensure!(
        envelope.format == FORMAT,
        "Đây không phải file backup của SSH Studio."
    );
    anyhow::ensure!(
        envelope.version == VERSION,
        "Backup được tạo bởi phiên bản SSH Studio mới hơn."
    );
    let key = derive(password, &envelope.kdf)?;
    let nonce = STANDARD.decode(&envelope.nonce)?;
    anyhow::ensure!(nonce.len() == 12, "File backup bị hỏng.");
    let plain = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("Khóa không hợp lệ"))?
        .decrypt(
            Nonce::from_slice(&nonce),
            AeadPayload {
                msg: &STANDARD.decode(&envelope.data)?,
                aad: &aad(envelope.version, &envelope.kdf)?,
            },
        )
        .map_err(|_| anyhow::anyhow!("Sai mật khẩu hoặc file backup đã bị sửa đổi."))?;
    Ok(serde_json::from_slice(&plain)?)
}

fn fingerprint(private: &str) -> anyhow::Result<(russh::keys::PrivateKey, String)> {
    let key = decode_secret_key(private, None)?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    Ok((key, fingerprint))
}

/// What a restore would do, without changing anything (known host conflicts need a choice).
pub fn inspect(store: &Store, path: &Path, password: &str) -> anyhow::Result<Value> {
    let contents = open(path, password)?;
    let new_hosts = contents
        .hosts
        .iter()
        .filter(|h| !store.data.hosts.iter().any(|x| x.id == h.id))
        .count();
    let mut new_keys = 0;
    for key in &contents.keys {
        let (_, fp) = fingerprint(&key.private)?;
        if !store.data.keys.iter().any(|k| k.fingerprint == fp) {
            new_keys += 1;
        }
    }
    let mut conflicts = vec![];
    let mut new_known = 0;
    for (address, backup) in &contents.known_hosts {
        match store.data.known_hosts.get(address) {
            None => new_known += 1,
            Some(current) if current != backup => conflicts.push(json!({
                "address": address,
                "current": current,
                "backup": backup,
            })),
            Some(_) => {}
        }
    }
    Ok(json!({
        "created": contents.created,
        "hosts": {"total": contents.hosts.len(), "new": new_hosts},
        "keys": {"total": contents.keys.len(), "new": new_keys},
        "knownHosts": {"total": contents.known_hosts.len(), "new": new_known, "conflicts": conflicts},
    }))
}

/// Merges a backup into the workspace: hosts by id, keys by fingerprint, known hosts by
/// address (conflicting fingerprints are replaced only for addresses listed in `replace`).
/// Nothing is overwritten otherwise; the store is saved once, or left untouched on error.
pub fn restore(
    store: &mut Store,
    path: &Path,
    password: &str,
    replace: &[String],
) -> anyhow::Result<Value> {
    let contents = open(path, password)?;
    let before = store.data.clone();
    let result = merge(store, contents, replace).and_then(|report| {
        store.save()?;
        Ok(report)
    });
    if result.is_err() {
        store.data = before;
    }
    result
}

fn merge(store: &mut Store, contents: Contents, replace: &[String]) -> anyhow::Result<Value> {
    let mut report = json!({
        "hostsAdded": 0, "hostsSkipped": 0, "keysAdded": 0, "keysSkipped": 0,
        "knownAdded": 0, "knownReplaced": 0, "knownKept": 0,
    });
    let bump = |report: &mut Value, field: &str| {
        report[field] = json!(report[field].as_u64().unwrap_or(0) + 1);
    };
    // Keys first: hosts may point at a key that exists here under another id.
    let mut key_ids: HashMap<String, String> = HashMap::new();
    for backup in contents.keys {
        let (key, fp) = fingerprint(&backup.private)?;
        if let Some(existing) = store.data.keys.iter().find(|k| k.fingerprint == fp) {
            key_ids.insert(backup.id, existing.id.clone());
            bump(&mut report, "keysSkipped");
            continue;
        }
        let id = if store.data.keys.iter().any(|k| k.id == backup.id) {
            uuid::Uuid::new_v4().to_string()
        } else {
            backup.id.clone()
        };
        store.data.keys.push(Key {
            id: id.clone(),
            name: store::key_name(&backup.name).unwrap_or_else(|_| "Key khôi phục".into()),
            algorithm: key.algorithm().to_string(),
            fingerprint: fp,
            public_key: key.public_key().to_openssh()?,
            secret: store::seal(key.to_openssh(LineEnding::LF)?.as_bytes())?,
        });
        key_ids.insert(backup.id, id);
        bump(&mut report, "keysAdded");
    }
    let incoming: Vec<String> = contents.hosts.iter().map(|h| h.id.clone()).collect();
    for mut host in contents.hosts {
        if store.data.hosts.iter().any(|h| h.id == host.id) {
            bump(&mut report, "hostsSkipped");
            continue;
        }
        if let Some(id) = key_ids.get(&host.key_id) {
            host.key_id = id.clone();
        }
        host.proxy.password = None;
        host.proxy.secret = match contents.proxy_passwords.get(&host.id) {
            Some(password) if host.proxy.enabled() => store::seal(password.as_bytes())?,
            _ => String::new(),
        };
        if !host.jump_host_id.is_empty()
            && !incoming.contains(&host.jump_host_id)
            && !store.data.hosts.iter().any(|h| h.id == host.jump_host_id)
        {
            host.jump_host_id.clear();
        }
        if host.validate().is_err() {
            bump(&mut report, "hostsSkipped");
            continue;
        }
        store.data.hosts.push(host);
        bump(&mut report, "hostsAdded");
    }
    for (address, fingerprint) in contents.known_hosts {
        match store.data.known_hosts.get(&address) {
            None => {
                store.data.known_hosts.insert(address, fingerprint);
                bump(&mut report, "knownAdded");
            }
            Some(current) if *current == fingerprint => {}
            Some(_) if replace.contains(&address) => {
                store.data.known_hosts.insert(address, fingerprint);
                bump(&mut report, "knownReplaced");
            }
            Some(_) => bump(&mut report, "knownKept"),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integration::fixture::VaultGuard;

    fn sample(dir: &Path) -> (Store, String) {
        let mut store = Store::load(dir.to_path_buf()).unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let private = key.to_openssh(LineEnding::LF).unwrap().to_string();
        store.add_key("Laptop".into(), &private, "").unwrap();
        let key_id = store.data.keys[0].id.clone();
        let mut host: Host = serde_json::from_value(json!({
            "id": "web", "name": "Web", "host": "web.example.test", "port": 22,
            "username": "deploy", "group": "Prod", "auth": "key", "keyId": key_id,
            "proxy": {"kind": "socks5", "host": "proxy.test", "port": 1080,
                      "username": "alice", "password": "proxy-secret-pw"},
            "forwards": [{"id": "db", "kind": "local", "bindHost": "127.0.0.1",
                          "bindPort": 5433, "targetHost": "127.0.0.1", "targetPort": 5432}]
        }))
        .unwrap();
        host.seal_proxy_password(None).unwrap();
        store.data.hosts.push(host);
        store
            .data
            .known_hosts
            .insert("[web.example.test]:22".into(), "SHA256:original".into());
        store.save().unwrap();
        (store, private)
    }

    #[test]
    fn backup_round_trip_merge_and_conflicts() {
        let _vault = VaultGuard::new();
        let dir = tempfile::tempdir().unwrap();
        let (store, private) = sample(&dir.path().join("a"));
        let file = dir.path().join("vault.sshstudio-backup");
        let made = create(&store, &file, "correct horse").unwrap();
        assert_eq!(made, json!({"hosts": 1, "keys": 1, "knownHosts": 1}));
        let raw = std::fs::read_to_string(&file).unwrap();
        for secret in [
            private.as_str(),
            "proxy-secret-pw",
            "web.example.test",
            "deploy",
        ] {
            assert!(!raw.contains(secret), "backup leaks {secret}");
        }
        assert!(create(&store, &file, "short").is_err());

        // Wrong password and tampering are detected.
        assert!(open(&file, "wrong password").is_err());
        let mut envelope: Value = serde_json::from_str(&raw).unwrap();
        envelope["kdf"]["iterations"] = json!(1);
        let tampered = dir.path().join("tampered");
        std::fs::write(&tampered, envelope.to_string()).unwrap();
        assert!(open(&tampered, "correct horse").is_err());

        // A fresh machine: the same key already exists under another id, and a known host
        // has a different fingerprint.
        let mut other = Store::load(dir.path().join("b")).unwrap();
        other.add_key("Old copy".into(), &private, "").unwrap();
        let local_key = other.data.keys[0].id.clone();
        other
            .data
            .known_hosts
            .insert("[web.example.test]:22".into(), "SHA256:changed".into());
        let preview = inspect(&other, &file, "correct horse").unwrap();
        assert_eq!(preview["hosts"]["new"], 1);
        assert_eq!(preview["keys"]["new"], 0);
        assert_eq!(
            preview["knownHosts"]["conflicts"][0]["backup"],
            "SHA256:original"
        );
        let report = restore(&mut other, &file, "correct horse", &[]).unwrap();
        assert_eq!(report["hostsAdded"], 1);
        assert_eq!(report["keysSkipped"], 1);
        assert_eq!(report["knownKept"], 1);
        let host = &other.data.hosts[0];
        assert_eq!(host.key_id, local_key, "host points at the existing key");
        assert_eq!(host.forwards.len(), 1);
        assert_eq!(host.proxy.password().unwrap().unwrap(), "proxy-secret-pw");
        assert_eq!(
            other.data.known_hosts["[web.example.test]:22"],
            "SHA256:changed"
        );
        // Restoring again changes nothing; choosing "replace" for the conflict applies it.
        let again = restore(
            &mut other,
            &file,
            "correct horse",
            &["[web.example.test]:22".into()],
        )
        .unwrap();
        assert_eq!(again["hostsSkipped"], 1);
        assert_eq!(again["knownReplaced"], 1);
        assert_eq!(
            other.data.known_hosts["[web.example.test]:22"],
            "SHA256:original"
        );
        // Saved to disk, still without plaintext secrets.
        let disk = std::fs::read_to_string(dir.path().join("b/workspace.json")).unwrap();
        assert!(!disk.contains("proxy-secret-pw") && !disk.contains("PRIVATE KEY"));
    }

    #[test]
    fn exported_key_optionally_has_a_passphrase() {
        let _vault = VaultGuard::new();
        let dir = tempfile::tempdir().unwrap();
        let (store, private) = sample(&dir.path().join("a"));
        let id = store.data.keys[0].id.clone();
        let plain = dir.path().join("id_plain");
        export_key(&store, &id, &plain, "").unwrap();
        let text = std::fs::read_to_string(&plain).unwrap();
        assert_eq!(text, private);
        let protected = dir.path().join("id_protected");
        export_key(&store, &id, &protected, "export pass").unwrap();
        let text = std::fs::read_to_string(&protected).unwrap();
        assert!(decode_secret_key(&text, None).is_err());
        let decoded = decode_secret_key(&text, Some("export pass")).unwrap();
        assert_eq!(
            decoded
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            store.data.keys[0].fingerprint
        );
        assert!(export_key(&store, "missing", &plain, "").is_err());
    }
}
