//! Regression tests for B1–B11 (docs/ROADMAP.md).
use super::fixture::*;
use crate::{files, ssh};

async fn connect(fx: &Fixture, id: &str) -> std::sync::Arc<ssh::Session> {
    ssh::establish(
        fx.sink.clone(),
        fx.state.clone(),
        id.into(),
        fx.host("h", USER, "password"),
        PASSWORD.into(),
    )
    .await
    .unwrap();
    fx.state.sessions.lock().await.get(id).unwrap().clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_output_is_base64_and_input_is_raw_bytes() {
    let fx = Fixture::start().await;
    let session = connect(&fx, "t").await;
    // B5: arbitrary bytes (e.g. X10 mouse reports ≥ 0x80) pass through unchanged.
    let binary = vec![0x1b, b'[', b'M', 0x20, 0xff, 0xa0];
    session
        .input
        .send(ssh::Input::Data(binary.clone()))
        .await
        .unwrap();
    session
        .input
        .send(ssh::Input::Data("xin chào".as_bytes().to_vec()))
        .await
        .unwrap();
    eventually(|| async { fx.terminal_text("t").contains("xin chào") }).await;
    // B4: output is a compact base64 string, not a JSON array of numbers.
    let events = fx.events.lock().unwrap().clone();
    let mut bytes = vec![];
    for (name, value) in &events {
        if name == "terminal" {
            assert!(value["data"].is_string(), "{value}");
            bytes.extend(decode_terminal(&value["data"]));
        }
    }
    assert!(bytes.windows(binary.len()).any(|w| w == binary));
    session.input.send(ssh::Input::Close).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_reuses_the_same_session_id() {
    let fx = Fixture::start().await;
    let session = connect(&fx, "tab").await;
    session.input.send(ssh::Input::Close).await.unwrap();
    fx.wait(|n, v| n == "session" && v["id"] == "tab" && v["status"] == "closed")
        .await;
    fx.clear_events();
    // B1: the same id can connect again once the previous session ended.
    connect(&fx, "tab").await;
    fx.wait(|n, v| n == "session" && v["id"] == "tab" && v["status"] == "connected")
        .await;
    eventually(|| async { fx.terminal_text("tab").contains("fixture-ready") }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dead_sftp_channel_is_reopened_once() {
    let fx = Fixture::start().await;
    std::fs::write(fx.remote_path("/a.txt"), b"a").unwrap();
    let session = connect(&fx, "s").await;
    let listing = files::list(&fx.state, Some("s".into()), "/".into())
        .await
        .unwrap();
    assert_eq!(listing["files"][0]["name"], "a.txt");
    assert_eq!(fx.sftp_opened.load(std::sync::atomic::Ordering::SeqCst), 1);
    // B7: kill the cached SFTP channel; the next operation transparently reopens it.
    session.files().await.unwrap().close().await.unwrap();
    let listing = files::list(&fx.state, Some("s".into()), "/".into())
        .await
        .unwrap();
    assert_eq!(listing["files"][0]["name"], "a.txt");
    assert_eq!(fx.sftp_opened.load(std::sync::atomic::Ordering::SeqCst), 2);
    files::action(
        &fx.state,
        Some("s".into()),
        "/".into(),
        "made".into(),
        None,
        "mkdir".into(),
        false,
    )
    .await
    .unwrap();
    assert!(fx.remote_path("/made").is_dir());
    // Server-side errors (status replies) are not retried and are reported as-is.
    assert!(
        files::action(
            &fx.state,
            Some("s".into()),
            "/".into(),
            "missing".into(),
            None,
            "delete".into(),
            false,
        )
        .await
        .is_err()
    );
    assert_eq!(fx.sftp_opened.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn symlink_targets_are_reported_and_link_to_file_downloads() {
    let fx = Fixture::start().await;
    std::fs::create_dir(fx.remote_path("/dir")).unwrap();
    std::fs::write(fx.remote_path("/dir/data.txt"), b"linked data").unwrap();
    fx.links
        .lock()
        .unwrap()
        .insert("/to-dir".into(), "/dir".into());
    fx.links
        .lock()
        .unwrap()
        .insert("/to-file".into(), "/dir/data.txt".into());
    connect(&fx, "s").await;
    let listing = files::list(&fx.state, Some("s".into()), "/".into())
        .await
        .unwrap();
    let entry = |name: &str| {
        listing["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap()
            .clone()
    };
    // B9: only a link to a directory may be opened as a folder.
    assert_eq!(entry("to-dir")["link"], true);
    assert_eq!(entry("to-dir")["targetDirectory"], true);
    assert_eq!(entry("to-file")["link"], true);
    assert_eq!(entry("to-file")["targetDirectory"], false);
    // …and a link to a file can be transferred like a file.
    files::start(
        fx.sink.clone(),
        fx.state.clone(),
        files::Transfer {
            id: "link".into(),
            session_id: "s".into(),
            direction: "download".into(),
            local_directory: fx.local.path().to_string_lossy().into(),
            remote_directory: "/".into(),
            name: "to-file".into(),
        },
    )
    .await
    .unwrap();
    let result = fx.finished("link").await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(
        std::fs::read(fx.local.path().join("to-file")).unwrap(),
        b"linked data"
    );
}

mod ppk {
    //! B11: PuTTY keys (v2/v3, with and without passphrase) import directly.
    use super::Fixture;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use hmac::{Hmac, KeyInit, Mac};
    use russh::keys::ssh_key::{self, Cipher, encoding::Encode};
    use sha1::{Digest, Sha1};
    use sha2::Sha256;

    fn lines(bytes: &[u8]) -> (usize, String) {
        let text = STANDARD.encode(bytes);
        let chunks: Vec<String> = text
            .as_bytes()
            .chunks(64)
            .map(|c| String::from_utf8(c.to_vec()).unwrap())
            .collect();
        (chunks.len(), chunks.join("\n"))
    }
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn string(buf: &mut Vec<u8>, bytes: &[u8]) {
        bytes.encode(buf).unwrap();
    }

    /// Writes an Ed25519 key in PuTTY's .ppk format exactly as PuTTYgen does.
    pub fn ppk(key: &ssh_key::PrivateKey, version: u8, passphrase: &str) -> String {
        let comment = "test-only";
        let algorithm = "ssh-ed25519";
        let public = key.public_key().to_bytes().unwrap();
        let seed = key.key_data().ed25519().unwrap().private.to_bytes();
        // PuTTYgen writes the 32-byte Ed25519 seed as a plain length-prefixed string
        // (no mpint sign byte), cf. ssh-key's tests/examples/id_ed25519.ppk.
        let mut private = vec![];
        string(&mut private, &seed);
        let encryption = if passphrase.is_empty() {
            "none"
        } else {
            "aes256-cbc"
        };
        let mut kdf_header = String::new();
        let (cipher_key, iv, mac_key) = match (version, passphrase.is_empty()) {
            (2, true) => (
                None,
                None,
                Sha1::digest(b"putty-private-key-file-mac-key").to_vec(),
            ),
            (3, true) => (None, None, vec![]),
            (2, false) => {
                let mut key =
                    Sha1::digest([&[0, 0, 0, 0][..], passphrase.as_bytes()].concat()).to_vec();
                key.extend(Sha1::digest(
                    [&[0, 0, 0, 1][..], passphrase.as_bytes()].concat(),
                ));
                key.truncate(32);
                let mac = Sha1::digest(
                    [
                        &b"putty-private-key-file-mac-key"[..],
                        passphrase.as_bytes(),
                    ]
                    .concat(),
                )
                .to_vec();
                (Some(key), Some(vec![0u8; 16]), mac)
            }
            _ => {
                let salt = [7u8; 16];
                let (memory, passes) = (8192u32, 1u32);
                let mut out = [0u8; 80];
                argon2::Argon2::new(
                    argon2::Algorithm::Argon2id,
                    argon2::Version::V0x13,
                    argon2::Params::new(memory, passes, 1, Some(80)).unwrap(),
                )
                .hash_password_into(passphrase.as_bytes(), &salt, &mut out)
                .unwrap();
                kdf_header = format!(
                    "Key-Derivation: Argon2id\nArgon2-Memory: {memory}\nArgon2-Passes: {passes}\nArgon2-Parallelism: 1\nArgon2-Salt: {}\n",
                    hex(&salt)
                );
                (
                    Some(out[..32].to_vec()),
                    Some(out[32..48].to_vec()),
                    out[48..].to_vec(),
                )
            }
        };
        if cipher_key.is_some() {
            while private.len() % 16 != 0 {
                private.push(0);
            }
        }
        let mut mac_data = vec![];
        string(&mut mac_data, algorithm.as_bytes());
        string(&mut mac_data, encryption.as_bytes());
        string(&mut mac_data, comment.as_bytes());
        string(&mut mac_data, &public);
        string(&mut mac_data, &private);
        let mac = if version == 2 {
            let mut mac = <Hmac<Sha1> as KeyInit>::new_from_slice(&mac_key).unwrap();
            mac.update(&mac_data);
            mac.finalize().into_bytes().to_vec()
        } else {
            let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&mac_key).unwrap();
            mac.update(&mac_data);
            mac.finalize().into_bytes().to_vec()
        };
        if let (Some(key), Some(iv)) = (&cipher_key, &iv) {
            Cipher::Aes256Cbc.encrypt(key, iv, &mut private).unwrap();
        }
        let (public_count, public_lines) = lines(&public);
        let (private_count, private_lines) = lines(&private);
        format!(
            "PuTTY-User-Key-File-{version}: {algorithm}\nEncryption: {encryption}\nComment: {comment}\nPublic-Lines: {public_count}\n{public_lines}\n{kdf_header}Private-Lines: {private_count}\n{private_lines}\nPrivate-MAC: {}\n",
            hex(&mac)
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ppk_v2_and_v3_import_with_and_without_passphrase() {
        let fx = Fixture::start().await;
        for (index, (version, passphrase)) in
            [(2, ""), (2, "putty-pass"), (3, ""), (3, "putty-pass")]
                .into_iter()
                .enumerate()
        {
            let key =
                ssh_key::PrivateKey::random(&mut rand::rng(), ssh_key::Algorithm::Ed25519).unwrap();
            let text = ppk(&key, version, passphrase);
            if !passphrase.is_empty() {
                assert!(
                    russh::keys::decode_secret_key(&text, Some("wrong")).is_err(),
                    "v{version} accepted a wrong passphrase"
                );
            }
            let mut store = fx.state.store.lock().await;
            store
                .add_key(format!("PuTTY {index}"), &text, passphrase)
                .unwrap_or_else(|e| panic!("v{version} '{passphrase}': {e}"));
            let saved = store.data.keys.last().unwrap();
            assert_eq!(
                saved.fingerprint,
                key.public_key()
                    .fingerprint(russh::keys::HashAlg::Sha256)
                    .to_string()
            );
            // Stored re-encoded as OpenSSH inside the vault, never as the original file.
            let private = crate::store::unlock(&saved.secret).unwrap();
            assert!(private.contains("BEGIN OPENSSH PRIVATE KEY"));
        }
    }
}
