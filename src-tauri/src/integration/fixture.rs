#![allow(dead_code)] // Helpers are shared by test modules that use different subsets.
//! Loopback SSH server fixture: password, publickey, keyboard-interactive (OTP / MFA),
//! SFTP on a real temporary directory, direct-tcpip (jump host, -L, -D) and tcpip-forward (-R).
//! Only test credentials are used; nothing leaves 127.0.0.1.
use super::sftp_disk::{DiskSftp, Links, Modes, WriteLimit};
use crate::{AppState, Events, store::Host, store::Store};
use russh::{
    Channel, ChannelId, ChannelOpenFailure, MethodKind, MethodSet,
    server::{self, Auth, Msg, Server as _, Session},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::task::AbortHandle;

pub const USER: &str = "tester";
pub const PASSWORD: &str = "test-only";
pub const OTP: &str = "123456";
/// `mfa`: password, then keyboard-interactive OTP (partial success).
pub const MFA_USER: &str = "mfa";
/// `mfa-key`: publickey, then keyboard-interactive OTP (partial success).
pub const MFA_KEY_USER: &str = "mfa-key";
/// `kbd`: password method disabled, only keyboard-interactive with one hidden "Password:" prompt.
pub const KBD_USER: &str = "kbd";

pub type EventLog = Arc<StdMutex<Vec<(String, Value)>>>;
type Responder = Arc<StdMutex<Option<Box<dyn Fn(&str, &Value) + Send + Sync>>>>;
pub type Answers = Arc<StdMutex<std::collections::VecDeque<Vec<String>>>>;

#[derive(Clone)]
struct TestServer {
    root: PathBuf,
    links: Links,
    modes: Modes,
    allowed_key: russh::keys::PublicKey,
    sftp_opened: Arc<std::sync::atomic::AtomicUsize>,
    write_limit: WriteLimit,
}

struct TestSession {
    server: TestServer,
    user: String,
    first_factor: bool,
    channels: HashMap<ChannelId, Channel<Msg>>,
    forwards: HashMap<(String, u32), AbortHandle>,
}

impl Drop for TestSession {
    fn drop(&mut self) {
        for (_, task) in self.forwards.drain() {
            task.abort();
        }
    }
}

impl server::Server for TestServer {
    type Handler = TestSession;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> TestSession {
        TestSession {
            server: self.clone(),
            user: String::new(),
            first_factor: false,
            channels: HashMap::new(),
            forwards: HashMap::new(),
        }
    }
}

fn only(method: MethodKind) -> Option<MethodSet> {
    Some(MethodSet::from(&[method][..]))
}

impl server::Handler for TestSession {
    type Error = anyhow::Error;
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> anyhow::Result<Auth> {
        if *key.public_key != self.server.allowed_key {
            return Ok(Auth::reject());
        }
        Ok(match user {
            USER => Auth::Accept,
            MFA_KEY_USER => {
                self.user = user.into();
                self.first_factor = true;
                Auth::Reject {
                    proceed_with_methods: only(MethodKind::KeyboardInteractive),
                    partial_success: true,
                }
            }
            _ => Auth::reject(),
        })
    }
    async fn auth_password(&mut self, user: &str, password: &str) -> anyhow::Result<Auth> {
        Ok(match (user, password == PASSWORD) {
            (USER, true) => Auth::Accept,
            (MFA_USER, true) => {
                self.user = user.into();
                self.first_factor = true;
                Auth::Reject {
                    proceed_with_methods: only(MethodKind::KeyboardInteractive),
                    partial_success: true,
                }
            }
            (KBD_USER, _) => Auth::Reject {
                proceed_with_methods: only(MethodKind::KeyboardInteractive),
                partial_success: false,
            },
            _ => Auth::reject(),
        })
    }
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> anyhow::Result<Auth> {
        let answers: Option<Vec<String>> =
            response.map(|r| r.map(|b| String::from_utf8_lossy(&b).to_string()).collect());
        let second =
            (user == MFA_USER || user == MFA_KEY_USER) && self.first_factor && self.user == user;
        Ok(match (user, answers) {
            (KBD_USER, None) => Auth::Partial {
                name: "".into(),
                instructions: "".into(),
                prompts: vec![("Password: ".into(), false)].into(),
            },
            (KBD_USER, Some(a)) if a == [PASSWORD] => Auth::Accept,
            (_, None) if second => Auth::Partial {
                name: "Xác thực hai bước".into(),
                instructions: "Nhập mã trong ứng dụng OTP".into(),
                prompts: vec![("Mã OTP: ".into(), false)].into(),
            },
            (_, Some(a)) if second && a == [OTP] => Auth::Accept,
            _ => Auth::reject(),
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
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> anyhow::Result<()> {
        if host != "127.0.0.1" && host != "localhost" {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        match tokio::net::TcpStream::connect((host, port as u16)).await {
            Ok(mut socket) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                });
            }
            Err(_) => reply.reject(ChannelOpenFailure::ConnectFailed).await,
        }
        Ok(())
    }
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> anyhow::Result<bool> {
        let Ok(listener) = tokio::net::TcpListener::bind((address, *port as u16)).await else {
            return Ok(false);
        };
        let actual = listener.local_addr()?.port() as u32;
        *port = actual;
        let handle = session.handle();
        let bound = address.to_string();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, peer)) = listener.accept().await {
                let handle = handle.clone();
                let bound = bound.clone();
                tokio::spawn(async move {
                    if let Ok(channel) = handle
                        .channel_open_forwarded_tcpip(
                            bound,
                            actual,
                            peer.ip().to_string(),
                            peer.port() as u32,
                        )
                        .await
                    {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    }
                });
            }
        });
        self.forwards
            .insert((address.to_string(), actual), task.abort_handle());
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _: &mut Session,
    ) -> anyhow::Result<bool> {
        Ok(match self.forwards.remove(&(address.to_string(), port)) {
            Some(task) => {
                task.abort();
                true
            }
            None => false,
        })
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
    /// The shell echoes every byte back, so terminal round-trips are observable.
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
        match (name, self.channels.remove(&id)) {
            ("sftp", Some(channel)) => {
                session.channel_success(id)?;
                self.server
                    .sftp_opened
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let handler = DiskSftp::new(
                    self.server.root.clone(),
                    self.server.links.clone(),
                    self.server.modes.clone(),
                    self.server.write_limit.clone(),
                );
                tokio::spawn(async move {
                    russh_sftp::server::run(channel.into_stream(), handler).await;
                });
            }
            _ => session.channel_failure(id)?,
        }
        Ok(())
    }
}

/// Keyring entries are shared per test process; delete them when the last fixture ends.
static VAULT_USERS: StdMutex<usize> = StdMutex::new(0);
pub struct VaultGuard;
impl VaultGuard {
    pub fn new() -> Self {
        *VAULT_USERS.lock().unwrap() += 1;
        VaultGuard
    }
}
impl Drop for VaultGuard {
    fn drop(&mut self) {
        let mut users = VAULT_USERS.lock().unwrap();
        *users -= 1;
        if *users == 0
            && let Ok(entry) =
                keyring::Entry::new(crate::store::credential_service(), "vault-master-key")
        {
            let _ = entry.delete_credential();
        }
    }
}

pub struct Fixture {
    /// Local workspace directory (vault, local side of transfers).
    pub local: tempfile::TempDir,
    /// Root of the remote SFTP file system.
    pub remote: tempfile::TempDir,
    pub port: u16,
    pub address: String,
    pub state: Arc<AppState>,
    pub events: EventLog,
    pub sink: Events,
    pub links: Links,
    pub modes: Modes,
    pub user_key: russh::keys::PrivateKey,
    pub sftp_opened: Arc<std::sync::atomic::AtomicUsize>,
    pub write_limit: WriteLimit,
    /// Answers for the next authentication prompts, in order (an empty queue cancels).
    pub answers: Answers,
    responder: Responder,
    server_task: tokio::task::JoinHandle<()>,
    _vault: VaultGuard,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server_task.abort();
    }
}

/// Starts an SSH server on 127.0.0.1 and returns its port and task.
pub async fn serve(
    root: PathBuf,
    links: Links,
    modes: Modes,
    host_key: russh::keys::PrivateKey,
    allowed_key: russh::keys::PublicKey,
    sftp_opened: Arc<std::sync::atomic::AtomicUsize>,
    write_limit: WriteLimit,
) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = TestServer {
        root,
        links,
        modes,
        allowed_key,
        sftp_opened,
        write_limit,
    };
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::from_millis(1)),
        ..Default::default()
    });
    let task = tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    (port, task)
}

impl Fixture {
    pub async fn start() -> Self {
        let vault = VaultGuard::new();
        let local = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let host_key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let user_key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let links: Links = Default::default();
        let modes: Modes = Default::default();
        let sftp_opened = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let write_limit: WriteLimit = Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX));
        let (port, server_task) = serve(
            remote.path().to_path_buf(),
            links.clone(),
            modes.clone(),
            host_key.clone(),
            user_key.public_key().clone(),
            sftp_opened.clone(),
            write_limit.clone(),
        )
        .await;
        let address = format!("[127.0.0.1]:{port}");
        let mut store = Store::load(local.path().join("vault")).unwrap();
        store.data.known_hosts.insert(
            address.clone(),
            host_key
                .public_key()
                .fingerprint(russh::keys::HashAlg::Sha256)
                .to_string(),
        );
        let state = Arc::new(AppState::new(store));
        let events: EventLog = Default::default();
        let responder: Responder = Default::default();
        let captured = events.clone();
        let respond = responder.clone();
        let answers: Answers = Default::default();
        let queued = answers.clone();
        let prompted = state.clone();
        let sink = Events(Arc::new(move |name, value| {
            if name == "auth-prompt" {
                let answer = queued.lock().unwrap().pop_front();
                let id = value["id"].as_str().unwrap_or_default();
                if let Some(tx) = prompted.prompts.lock().unwrap().remove(id) {
                    let _ = tx.send(answer);
                }
            }
            if let Some(callback) = respond.lock().unwrap().as_ref() {
                callback(name, &value);
            }
            captured.lock().unwrap().push((name.into(), value));
        }));
        Fixture {
            local,
            remote,
            port,
            address,
            state,
            events,
            sink,
            links,
            modes,
            user_key,
            sftp_opened,
            write_limit,
            answers,
            responder,
            server_task,
            _vault: vault,
        }
    }

    /// Saved host pointing at the fixture (not yet stored).
    pub fn host(&self, id: &str, username: &str, auth: &str) -> Host {
        Host {
            id: id.into(),
            name: format!("Loopback {id}"),
            host: "127.0.0.1".into(),
            port: self.port,
            username: username.into(),
            group: "Test".into(),
            auth: auth.into(),
            key_id: String::new(),
            jump_host_id: String::new(),
            proxy: Default::default(),
            forwards: vec![],
        }
    }

    /// Imports the fixture user key into the vault and returns its id.
    pub async fn import_user_key(&self) -> String {
        let mut store = self.state.store.lock().await;
        store
            .add_key(
                "Test-only key".into(),
                &self
                    .user_key
                    .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                    .unwrap(),
                "",
            )
            .unwrap();
        store.data.keys.last().unwrap().id.clone()
    }

    /// Queues one single-field answer per string for the next prompts.
    pub fn answer(&self, answers: &[&str]) {
        self.answers
            .lock()
            .unwrap()
            .extend(answers.iter().map(|a| vec![a.to_string()]));
    }

    /// Calls `callback` synchronously for every emitted event (used to answer prompts).
    pub fn on_event(&self, callback: impl Fn(&str, &Value) + Send + Sync + 'static) {
        *self.responder.lock().unwrap() = Some(Box::new(callback));
    }

    pub fn remote_path(&self, virtual_path: &str) -> PathBuf {
        super::sftp_disk::on_disk(self.remote.path(), virtual_path)
    }

    pub async fn wait(&self, predicate: impl Fn(&str, &Value) -> bool) -> Value {
        wait_for(&self.events, predicate).await
    }

    /// Waits for a transfer to reach a terminal state.
    pub async fn finished(&self, id: &str) -> Value {
        self.wait(|n, v| {
            n == "transfer"
                && v["id"] == id
                && ["completed", "failed", "cancelled", "skipped"]
                    .contains(&v["status"].as_str().unwrap_or(""))
        })
        .await
    }

    /// A transfer request between the fixture's local dir and remote `/`.
    pub fn request(
        &self,
        id: &str,
        session: &str,
        direction: &str,
        name: &str,
    ) -> crate::transfer::Transfer {
        crate::transfer::Transfer {
            id: id.into(),
            session_id: session.into(),
            direction: direction.into(),
            local_directory: self.local.path().to_string_lossy().into(),
            remote_directory: "/".into(),
            name: name.into(),
            ..Default::default()
        }
    }

    /// Starts a transfer and waits for its final event.
    pub async fn transfer(&self, request: crate::transfer::Transfer) -> Value {
        let id = request.id.clone();
        crate::transfer::start(self.sink.clone(), self.state.clone(), request)
            .await
            .unwrap();
        let result = self.finished(&id).await;
        // Later attempts reuse the id: forget this attempt's events.
        self.events
            .lock()
            .unwrap()
            .retain(|(name, value)| !(name == "transfer" && value["id"] == id.as_str()));
        result
    }

    /// Opens a password session on the fixture.
    pub async fn connect(&self, id: &str) -> Arc<crate::ssh::Session> {
        self.answer(&[PASSWORD]);
        crate::ssh::establish(
            self.sink.clone(),
            self.state.clone(),
            id.into(),
            self.host("h", USER, "password"),
        )
        .await
        .unwrap();
        self.state.sessions.lock().await.get(id).unwrap().clone()
    }

    pub fn clear_events(&self) {
        self.events.lock().unwrap().clear();
    }

    /// Everything the terminal of `id` has printed so far.
    pub fn terminal_text(&self, id: &str) -> String {
        let events = self.events.lock().unwrap();
        let mut bytes = vec![];
        for (name, value) in events.iter() {
            if name == "terminal" && value["id"] == id {
                bytes.extend(decode_terminal(&value["data"]));
            }
        }
        String::from_utf8_lossy(&bytes).to_string()
    }
}

pub fn decode_terminal(data: &Value) -> Vec<u8> {
    match data {
        Value::Array(items) => items.iter().map(|v| v.as_u64().unwrap() as u8).collect(),
        Value::String(text) => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .unwrap()
        }
        _ => vec![],
    }
}

pub async fn wait_for(events: &EventLog, predicate: impl Fn(&str, &Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
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

/// Polls an async condition until it holds (20 s limit).
pub async fn eventually<F, Fut>(mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    tokio::time::timeout(Duration::from_secs(20), async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("condition not reached before timeout");
}

/// Plain TCP echo server on 127.0.0.1, used as the target of forwards and tunnels.
pub async fn echo_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    (port, task)
}

/// Sends `payload` through a TCP stream and expects the same bytes back.
pub async fn echo_roundtrip(
    stream: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin),
    payload: &[u8],
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream.write_all(payload).await.unwrap();
    stream.flush().await.unwrap();
    let mut received = vec![0; payload.len()];
    tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut received))
        .await
        .expect("echo timed out")
        .unwrap();
    assert_eq!(received, payload);
}
