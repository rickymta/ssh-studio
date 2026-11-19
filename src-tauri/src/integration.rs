//! Real loopback SSH/SFTP integration; no external server or credentials required.
use super::*;
use russh::{
    Channel, ChannelId,
    server::{self, Msg, Server as _, Session},
};
use russh_sftp::protocol::{self as p, StatusCode};
use std::time::Duration;
type Memory = Arc<std::sync::Mutex<HashMap<String, Vec<u8>>>>;
#[derive(Clone)]
struct TestServer {
    files: Memory,
    allowed_key: russh::keys::PublicKey,
}
struct TestSession {
    files: Memory,
    allowed_key: russh::keys::PublicKey,
    channels: HashMap<ChannelId, Channel<Msg>>,
}
impl server::Server for TestServer {
    type Handler = TestSession;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> TestSession {
        TestSession {
            files: self.files.clone(),
            allowed_key: self.allowed_key.clone(),
            channels: HashMap::new(),
        }
    }
}
impl server::Handler for TestSession {
    type Error = anyhow::Error;
    async fn auth_publickey(&mut self, user: &str, key: server::VerifiedPublicKey<'_>) -> anyhow::Result<server::Auth> {
        Ok(if user == "tester" && *key.public_key == self.allowed_key {server::Auth::Accept} else {server::Auth::reject()})
    }
    async fn auth_password(&mut self, user: &str, password: &str) -> anyhow::Result<server::Auth> {
        Ok(if user == "tester" && password == "test-only" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> anyhow::Result<()> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        id: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> anyhow::Result<()> {
        session.channel_success(id)?;
        Ok(())
    }
    async fn shell_request(&mut self, id: ChannelId, session: &mut Session) -> anyhow::Result<()> {
        session.channel_success(id)?;
        session.data(id, b"fixture-ready\r\n".to_vec())?;
        Ok(())
    }
    async fn data(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> anyhow::Result<()> {
        if self.channels.contains_key(&id) {
            session.data(id, data.to_vec())?;
        }
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> anyhow::Result<()> {
        if name == "sftp" {
            session.channel_success(id)?;
            let channel = self.channels.remove(&id).unwrap();
            let handler = MemorySftp {
                files: self.files.clone(),
                listed: false,
            };
            tokio::spawn(async move {
                russh_sftp::server::run(channel.into_stream(), handler).await;
            });
        } else {
            session.channel_failure(id)?;
        }
        Ok(())
    }
}
struct MemorySftp {
    files: Memory,
    listed: bool,
}
fn success(id: u32) -> p::Status {
    p::Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
fn attrs(len: usize) -> p::FileAttributes {
    p::FileAttributes {
        size: Some(len as u64),
        permissions: Some(0o100644),
        ..Default::default()
    }
}
impl russh_sftp::server::Handler for MemorySftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, _: String) -> Result<p::Name, StatusCode> {
        Ok(p::Name {
            id,
            files: vec![p::File {
                filename: "/".into(),
                longname: String::new(),
                attrs: Default::default(),
            }],
        })
    }
    async fn opendir(&mut self, id: u32, _: String) -> Result<p::Handle, StatusCode> {
        self.listed = false;
        Ok(p::Handle {
            id,
            handle: "/".into(),
        })
    }
    async fn readdir(&mut self, id: u32, _: String) -> Result<p::Name, StatusCode> {
        if self.listed {
            return Err(StatusCode::Eof);
        }
        self.listed = true;
        Ok(p::Name {
            id,
            files: self
                .files
                .lock()
                .unwrap()
                .iter()
                .map(|(name, data)| p::File {
                    filename: name.trim_start_matches('/').into(),
                    longname: String::new(),
                    attrs: attrs(data.len()),
                })
                .collect(),
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<p::Attrs, StatusCode> {
        self.files
            .lock()
            .unwrap()
            .get(&path)
            .map(|data| p::Attrs {
                id,
                attrs: attrs(data.len()),
            })
            .ok_or(StatusCode::NoSuchFile)
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<p::Attrs, StatusCode> {
        self.stat(id, path).await
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: p::OpenFlags,
        _: p::FileAttributes,
    ) -> Result<p::Handle, StatusCode> {
        let mut files = self.files.lock().unwrap();
        if flags.contains(p::OpenFlags::EXCLUDE) && files.contains_key(&filename) {
            return Err(StatusCode::Failure);
        }
        if flags.contains(p::OpenFlags::CREATE) {
            files.entry(filename.clone()).or_default();
        }
        if !files.contains_key(&filename) {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(p::Handle {
            id,
            handle: filename,
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<p::Status, StatusCode> {
        Ok(success(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<p::Data, StatusCode> {
        let files = self.files.lock().unwrap();
        let data = files.get(&handle).ok_or(StatusCode::NoSuchFile)?;
        if offset as usize >= data.len() {
            return Err(StatusCode::Eof);
        }
        Ok(p::Data {
            id,
            data: data[offset as usize..(offset as usize + len as usize).min(data.len())].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        bytes: Vec<u8>,
    ) -> Result<p::Status, StatusCode> {
        let mut files = self.files.lock().unwrap();
        let data = files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        data.resize(data.len().max(offset as usize + bytes.len()), 0);
        data[offset as usize..offset as usize + bytes.len()].copy_from_slice(&bytes);
        Ok(success(id))
    }
    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<p::Status, StatusCode> {
        let mut files = self.files.lock().unwrap();
        if files.contains_key(&new) {
            return Err(StatusCode::Failure);
        }
        let data = files.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        files.insert(new, data);
        Ok(success(id))
    }
    async fn remove(&mut self, id: u32, name: String) -> Result<p::Status, StatusCode> {
        self.files
            .lock()
            .unwrap()
            .remove(&name)
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(success(id))
    }
}
async fn wait_for(
    events: &Arc<std::sync::Mutex<Vec<(String, Value)>>>,
    predicate: impl Fn(&str, &Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some((_, value)) = events
                .lock()
                .unwrap()
                .iter()
                .find(|(name, value)| predicate(name, value))
            {
                return value.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("expected event before timeout")
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simultaneous_sessions_sftp_roundtrip_and_host_key_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::load(dir.path().to_path_buf()).unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let address = format!("[127.0.0.1]:{port}");
    store.data.known_hosts.insert(
        address.clone(),
        key.public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string(),
    );
    let files: Memory = Default::default();
    files
        .lock()
        .unwrap()
        .insert("/hello.txt".into(), b"hello SFTP".to_vec());
    let user_key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    store.add_key("Test-only key".into(), &user_key.to_openssh(russh::keys::ssh_key::LineEnding::LF).unwrap(), "").unwrap();
    let key_id = store.data.keys[0].id.clone();
    assert!(!std::fs::read_to_string(dir.path().join("workspace.json")).unwrap().contains("BEGIN OPENSSH PRIVATE KEY"));
    let mut server = TestServer { files: files.clone(), allowed_key: user_key.public_key().clone() };
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(1),
        ..Default::default()
    });
    let server_task = tokio::spawn(async move {
        server.run_on_socket(config, &listener).await.unwrap();
    });
    let state = Arc::new(AppState {
        store: Mutex::new(store),
        sessions: Mutex::new(HashMap::new()),
        verdicts: Mutex::new(HashMap::new()),
        transfers: Mutex::new(HashMap::new()),
        slots: Arc::new(Semaphore::new(2)),
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = events.clone();
    let sink = Events(Arc::new(move |name, value| {
        captured.lock().unwrap().push((name.into(), value))
    }));
    let host = Host {
        id: "fixture".into(),
        name: "Loopback".into(),
        host: "127.0.0.1".into(),
        port,
        username: "tester".into(),
        group: "Test".into(),
        auth: "password".into(),
        key_id: String::new(),
    };
    let (a, b) = tokio::join!(
        ssh::establish(
            sink.clone(),
            state.clone(),
            "one".into(),
            host.clone(),
            "test-only".into()
        ),
        ssh::establish(
            sink.clone(),
            state.clone(),
            "two".into(),
            host.clone(),
            "test-only".into()
        )
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(state.sessions.lock().await.len(), 2);
    let one = state.sessions.lock().await.get("one").unwrap().clone();
    one.input
        .send(ssh::Input::Data("isolated-session-one".into()))
        .await
        .unwrap();
    wait_for(&events, |name, value| {
        name == "terminal"
            && value["id"] == "one"
            && value["data"]
                .as_array()
                .map(|bytes| {
                    String::from_utf8_lossy(
                        &bytes
                            .iter()
                            .map(|v| v.as_u64().unwrap() as u8)
                            .collect::<Vec<_>>(),
                    )
                    .contains("isolated-session-one")
                })
                .unwrap_or(false)
    })
    .await;
    let listing = files::list(&state, Some("one".into()), "/".into())
        .await
        .unwrap();
    assert_eq!(listing["files"][0]["name"], "hello.txt");
    let payload = vec![91u8; 250_000];
    tokio::fs::write(dir.path().join("upload.bin"), &payload)
        .await
        .unwrap();
    let request = files::Transfer {
        id: "upload".into(),
        session_id: "one".into(),
        direction: "upload".into(),
        local_directory: dir.path().to_string_lossy().into(),
        remote_directory: "/".into(),
        name: "upload.bin".into(),
    };
    files::start(sink.clone(), state.clone(), request.clone())
        .await
        .unwrap();
    let result = wait_for(&events, |n, v| {
        n == "transfer"
            && v["id"] == "upload"
            && (v["status"] == "completed" || v["status"] == "failed")
    })
    .await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(files.lock().unwrap()["/upload.bin"], payload);
    let download = dir.path().join("download");
    tokio::fs::create_dir(&download).await.unwrap();
    files::start(
        sink.clone(),
        state.clone(),
        files::Transfer {
            id: "download".into(),
            direction: "download".into(),
            local_directory: download.to_string_lossy().into(),
            session_id: "two".into(),
            ..request.clone()
        },
    )
    .await
    .unwrap();
    let result = wait_for(&events, |n, v| {
        n == "transfer"
            && v["id"] == "download"
            && (v["status"] == "completed" || v["status"] == "failed")
    })
    .await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(
        tokio::fs::read(download.join("upload.bin")).await.unwrap(),
        payload
    );
    files::start(
        sink.clone(),
        state.clone(),
        files::Transfer {
            id: "duplicate".into(),
            ..request.clone()
        },
    )
    .await
    .unwrap();
    let result = wait_for(&events, |n, v| {
        n == "transfer" && v["id"] == "duplicate" && v["status"] == "failed"
    })
    .await;
    assert!(result["error"].as_str().unwrap().contains("tồn tại"));
    ssh::establish(sink.clone(), state.clone(), "key-session".into(), Host { auth: "key".into(), key_id, ..host.clone() }, String::new()).await.unwrap();
    state.sessions.lock().await.get("key-session").unwrap().input.send(ssh::Input::Close).await.unwrap();
    let _ = keyring::Entry::new(store::credential_service(), "vault-master-key").unwrap().delete_credential();
    assert!(
        ssh::establish(
            sink.clone(),
            state.clone(),
            "bad-password".into(),
            host.clone(),
            "wrong".into()
        )
        .await
        .is_err()
    );
    state
        .store
        .lock()
        .await
        .data
        .known_hosts
        .insert(address, "SHA256:changed".into());
    assert!(
        ssh::establish(
            sink.clone(),
            state.clone(),
            "bad-host".into(),
            host,
            "test-only".into()
        )
        .await
        .is_err()
    );
    one.input.send(ssh::Input::Close).await.unwrap();
    wait_for(&events, |n, v| {
        n == "session" && v["id"] == "one" && v["status"] == "closed"
    })
    .await;
    assert!(state.sessions.lock().await.contains_key("two"));
    state
        .sessions
        .lock()
        .await
        .get("two")
        .unwrap()
        .input
        .send(ssh::Input::Close)
        .await
        .unwrap();
    server_task.abort();
}
