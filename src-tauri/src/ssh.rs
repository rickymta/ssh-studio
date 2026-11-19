use crate::{AppState, store::Host};
use base64::{Engine, engine::general_purpose::STANDARD};
use russh::{
    ChannelMsg, MethodKind, MethodSet,
    client::{self, AuthResult, KeyboardInteractiveAuthResponse},
    keys::{
        HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate,
        agent::{AgentIdentity, client::AgentClient},
    },
};
use russh_sftp::client::SftpSession;
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc, oneshot};

pub struct Handler {
    pub app: crate::Events,
    pub state: Arc<AppState>,
    pub address: String,
}
impl client::Handler for Handler {
    type Error = anyhow::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        if let Some(known) = self
            .state
            .store
            .lock()
            .await
            .data
            .known_hosts
            .get(&self.address)
        {
            anyhow::ensure!(
                *known == fingerprint,
                "Host key đã thay đổi. Kết nối bị chặn. Hãy xác minh fingerprint với quản trị viên trước khi quên host trong Known Hosts."
            );
            return Ok(true);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.state.verdicts.lock().await.insert(id.clone(), tx);
        let _ = self.app.emit(
            "host-verification",
            json!({"id":id,"address":self.address,"fingerprint":fingerprint}),
        );
        let accepted = tokio::time::timeout(Duration::from_secs(120), rx)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
        self.state.verdicts.lock().await.remove(&id);
        let _ = self
            .app
            .emit("host-verification-finished", json!({"id":id}));
        if accepted {
            let mut store = self.state.store.lock().await;
            if let Some(known) = store.data.known_hosts.get(&self.address) {
                anyhow::ensure!(
                    *known == fingerprint,
                    "Host key đã thay đổi trong lúc kết nối."
                );
                return Ok(true);
            }
            store
                .data
                .known_hosts
                .insert(self.address.clone(), fingerprint);
            if store.save().is_err() {
                store.data.known_hosts.remove(&self.address);
                return Ok(false);
            }
        }
        Ok(accepted)
    }
}
pub enum Input {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}
pub struct Session {
    /// `[host]:port` of the server (used to detect two writers on the same remote path).
    pub address: String,
    pub handle: Arc<client::Handle<Handler>>,
    /// Jump host connections carrying this session (closest to the target first).
    pub jumps: Vec<Arc<client::Handle<Handler>>>,
    pub input: mpsc::Sender<Input>,
    pub sftp: Mutex<Option<Arc<SftpSession>>>,
}
impl Session {
    pub async fn files(&self) -> anyhow::Result<Arc<SftpSession>> {
        let mut cache = self.sftp.lock().await;
        if let Some(sftp) = cache.as_ref() {
            return Ok(sftp.clone());
        }
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = Arc::new(SftpSession::new(channel.into_stream()).await?);
        *cache = Some(session.clone());
        Ok(session)
    }
    /// Drops the cached SFTP channel if it is still `stale`, so the next call reopens it.
    pub async fn reset_files(&self, stale: &Arc<SftpSession>) {
        let mut cache = self.sftp.lock().await;
        if cache.as_ref().is_some_and(|c| Arc::ptr_eq(c, stale)) {
            let _ = stale.close().await;
            *cache = None;
        }
    }
}
/// Sessions survive only as long as their transport: a session opened through jump hosts
/// keeps those connections and closes them with itself.
type Handle = client::Handle<Handler>;

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    })
}

/// Who is asking for credentials, for prompts shown to the user.
struct Ctx<'a> {
    app: &'a crate::Events,
    state: &'a Arc<AppState>,
    session_id: &'a str,
}

impl Ctx<'_> {
    /// Shows a prompt (password, OTP, keyboard-interactive questions) and waits for the
    /// answers. Answers are never stored or logged; `None` means the user cancelled.
    async fn ask(
        &self,
        title: String,
        instructions: String,
        prompts: Vec<(String, bool)>,
    ) -> anyhow::Result<Vec<String>> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.state.prompts.lock().unwrap().insert(id.clone(), tx);
        let _ = self.app.emit(
            "auth-prompt",
            json!({
                "id": id,
                "sessionId": self.session_id,
                "title": title,
                "instructions": instructions,
                "prompts": prompts
                    .iter()
                    .map(|(label, echo)| json!({"label": label, "echo": echo}))
                    .collect::<Vec<_>>(),
            }),
        );
        let answer = tokio::time::timeout(Duration::from_secs(300), rx).await;
        self.state.prompts.lock().unwrap().remove(&id);
        let _ = self.app.emit("auth-prompt-finished", json!({"id": id}));
        let answers = answer
            .map_err(|_| anyhow::anyhow!("Hết thời gian chờ nhập thông tin xác thực."))?
            .ok()
            .flatten()
            .ok_or_else(|| anyhow::anyhow!("Đã hủy xác thực."))?;
        anyhow::ensure!(
            answers.len() == prompts.len(),
            "Số câu trả lời không khớp với câu hỏi."
        );
        Ok(answers)
    }
}

enum Outcome {
    Success,
    Failure { remaining: MethodSet, partial: bool },
}
impl From<AuthResult> for Outcome {
    fn from(result: AuthResult) -> Self {
        match result {
            AuthResult::Success => Outcome::Success,
            AuthResult::Failure {
                remaining_methods,
                partial_success,
            } => Outcome::Failure {
                remaining: remaining_methods,
                partial: partial_success,
            },
        }
    }
}

/// Keyboard-interactive rounds. `autofill` answers a single hidden prompt once (the password
/// the server just rejected over the `password` method).
async fn keyboard_interactive(
    ctx: &Ctx<'_>,
    handle: &mut Handle,
    host: &Host,
    mut autofill: Option<String>,
) -> anyhow::Result<Outcome> {
    let mut reply = handle
        .authenticate_keyboard_interactive_start(&host.username, None)
        .await?;
    for _ in 0..12 {
        reply = match reply {
            KeyboardInteractiveAuthResponse::Success => return Ok(Outcome::Success),
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                partial_success,
            } => {
                return Ok(Outcome::Failure {
                    remaining: remaining_methods,
                    partial: partial_success,
                });
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = if prompts.is_empty() {
                    vec![]
                } else if prompts.len() == 1 && !prompts[0].echo && autofill.is_some() {
                    vec![autofill.take().unwrap_or_default()]
                } else {
                    let title = if name.trim().is_empty() {
                        format!("Xác thực {}@{}", host.username, host.host)
                    } else {
                        name
                    };
                    ctx.ask(
                        title,
                        instructions,
                        prompts.into_iter().map(|p| (p.prompt, p.echo)).collect(),
                    )
                    .await?
                };
                handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?
            }
        };
    }
    anyhow::bail!("Server hỏi quá nhiều vòng xác thực.")
}

async fn key_auth(state: &AppState, handle: &mut Handle, host: &Host) -> anyhow::Result<Outcome> {
    let secret = state
        .store
        .lock()
        .await
        .data
        .keys
        .iter()
        .find(|k| k.id == host.key_id)
        .ok_or_else(|| anyhow::anyhow!("Không tìm thấy SSH key"))?
        .secret
        .clone();
    let private = crate::store::unlock(&secret)?;
    let key = russh::keys::decode_secret_key(&private, None)?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    Ok(handle
        .authenticate_publickey(
            &host.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await?
        .into())
}

type Agent = AgentClient<Box<dyn russh::keys::agent::client::AgentStream + Send + Unpin>>;

/// The system SSH agent: OpenSSH agent pipe then Pageant on Windows, `SSH_AUTH_SOCK` elsewhere.
async fn open_agent(state: &AppState) -> anyhow::Result<Agent> {
    let path = state.agent_path.lock().unwrap().clone();
    #[cfg(windows)]
    {
        let pipe = path.unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".to_string());
        match AgentClient::connect_named_pipe(&pipe).await {
            Ok(agent) => Ok(agent.dynamic()),
            Err(_) => AgentClient::connect_pageant()
                .await
                .map(|a| a.dynamic())
                .map_err(|_| {
                    anyhow::anyhow!(
                        "Không tìm thấy SSH agent. Bật dịch vụ OpenSSH Authentication Agent hoặc mở Pageant."
                    )
                }),
        }
    }
    #[cfg(unix)]
    {
        let agent = match path {
            Some(path) => AgentClient::connect_uds(path).await,
            None => AgentClient::connect_env().await,
        };
        agent.map(|a| a.dynamic()).map_err(|_| {
            anyhow::anyhow!(
                "Không tìm thấy SSH agent (SSH_AUTH_SOCK). Hãy chạy ssh-agent và ssh-add."
            )
        })
    }
}

async fn agent_auth(state: &AppState, handle: &mut Handle, host: &Host) -> anyhow::Result<Outcome> {
    let mut agent = open_agent(state).await?;
    let identities = agent.request_identities().await?;
    anyhow::ensure!(
        !identities.is_empty(),
        "SSH agent chưa có key nào. Hãy thêm key vào agent (ssh-add)."
    );
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let mut last = Outcome::Failure {
        remaining: MethodSet::empty(),
        partial: false,
    };
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let result: Outcome = handle
            .authenticate_publickey_with(&host.username, key, hash, &mut agent)
            .await
            .map_err(|e| anyhow::anyhow!("SSH agent không ký được: {e}"))?
            .into();
        match result {
            Outcome::Failure { partial: false, .. } => last = result,
            done => return Ok(done),
        }
    }
    Ok(last)
}

/// Authenticates with the host's method, then follows the server through partial success
/// (e.g. publickey or password, then an OTP over keyboard-interactive). A password rejected by
/// a server that only allows keyboard-interactive is retried there automatically.
async fn authenticate(ctx: &Ctx<'_>, handle: &mut Handle, host: &Host) -> anyhow::Result<()> {
    let mut method = host.auth.clone();
    let mut tried: Vec<String> = vec![];
    let mut autofill = None;
    for _ in 0..6 {
        tried.push(method.clone());
        let outcome = match method.as_str() {
            "key" => key_auth(ctx.state, handle, host).await?,
            "agent" => agent_auth(ctx.state, handle, host).await?,
            "interactive" => keyboard_interactive(ctx, handle, host, autofill.take()).await?,
            _ => {
                let password = ctx
                    .ask(
                        format!("Mật khẩu cho {}@{}", host.username, host.host),
                        String::new(),
                        vec![("Password".into(), false)],
                    )
                    .await?
                    .remove(0);
                let result: Outcome = handle
                    .authenticate_password(&host.username, password.clone())
                    .await?
                    .into();
                if let Outcome::Failure { partial: false, .. } = result {
                    autofill = Some(password);
                }
                result
            }
        };
        let (remaining, partial) = match outcome {
            Outcome::Success => return Ok(()),
            Outcome::Failure { remaining, partial } => (remaining, partial),
        };
        let allowed = |kind: MethodKind| remaining.contains(&kind);
        let fresh = |name: &str| !tried.iter().any(|t| t == name);
        let next = if partial {
            [
                ("interactive", MethodKind::KeyboardInteractive, true),
                ("password", MethodKind::Password, true),
                ("key", MethodKind::PublicKey, !host.key_id.is_empty()),
                ("agent", MethodKind::PublicKey, host.auth == "agent"),
            ]
            .into_iter()
            .find(|(name, kind, usable)| *usable && allowed(*kind) && fresh(name))
            .map(|(name, ..)| name)
        } else if method == "password"
            && allowed(MethodKind::KeyboardInteractive)
            && fresh("interactive")
        {
            Some("interactive")
        } else {
            None
        };
        match next {
            Some(name) => method = name.to_string(),
            None => anyhow::bail!(
                "Xác thực thất bại. Kiểm tra username, password, SSH key hoặc mã xác thực."
            ),
        }
    }
    anyhow::bail!("Xác thực thất bại: quá nhiều bước.")
}

type Connected = (Handle, Vec<Arc<Handle>>);
type Opening<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<Connected>> + Send + 'a>>;

/// Opens the transport to `host` (direct, through its proxy, or through its jump host chain)
/// and authenticates. `visited` holds the hosts already on the path (loop detection).
fn open<'a>(ctx: &'a Ctx<'a>, host: Host, mut visited: Vec<String>) -> Opening<'a> {
    Box::pin(async move {
        anyhow::ensure!(
            !visited.contains(&host.id),
            "Chuỗi jump host bị lặp vòng tại “{}”.",
            host.name
        );
        anyhow::ensure!(visited.len() < 8, "Chuỗi jump host quá dài.");
        visited.push(host.id.clone());
        let handler = Handler {
            app: ctx.app.clone(),
            state: ctx.state.clone(),
            address: format!("[{}]:{}", host.host, host.port),
        };
        let timeout = Duration::from_secs(140);
        let (mut handle, jumps) = if !host.jump_host_id.is_empty() {
            let jump = ctx
                .state
                .store
                .lock()
                .await
                .data
                .hosts
                .iter()
                .find(|h| h.id == host.jump_host_id)
                .cloned()
                .ok_or_else(|| {
                    anyhow::anyhow!("Jump host của “{}” không còn tồn tại.", host.name)
                })?;
            let jump_name = jump.name.clone();
            let (jump_handle, mut chain) = open(ctx, jump, visited).await?;
            let channel = jump_handle
                .channel_open_direct_tcpip(host.host.clone(), host.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    anyhow::anyhow!(
                        "Jump host “{jump_name}” không mở được kết nối tới {}:{}: {e}",
                        host.host,
                        host.port
                    )
                })?;
            let handle = tokio::time::timeout(
                timeout,
                client::connect_stream(client_config(), channel.into_stream(), handler),
            )
            .await??;
            chain.insert(0, Arc::new(jump_handle));
            (handle, chain)
        } else if host.proxy.enabled() {
            let stream =
                crate::proxy::connect(&host.proxy, host.proxy.password()?, &host.host, host.port)
                    .await?;
            let handle = tokio::time::timeout(
                timeout,
                client::connect_stream(client_config(), stream, handler),
            )
            .await??;
            (handle, vec![])
        } else {
            let handle = tokio::time::timeout(
                timeout,
                client::connect(client_config(), (host.host.as_str(), host.port), handler),
            )
            .await??;
            (handle, vec![])
        };
        authenticate(ctx, &mut handle, &host)
            .await
            .map_err(|e| anyhow::anyhow!("{}: {e}", host.name))?;
        Ok((handle, jumps))
    })
}

pub async fn establish(
    app: crate::Events,
    state: Arc<AppState>,
    id: String,
    host: Host,
) -> anyhow::Result<()> {
    let ctx = Ctx {
        app: &app,
        state: &state,
        session_id: &id,
    };
    let (handle, jumps) = open(&ctx, host.clone(), vec![]).await?;
    let mut channel = handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", 100, 30, 0, 0, &[])
        .await?;
    await_channel_success(&mut channel).await?;
    channel.request_shell(true).await?;
    await_channel_success(&mut channel).await?;
    let (tx, mut rx) = mpsc::channel(256);
    let session = Arc::new(Session {
        address: format!("[{}]:{}", host.host, host.port),
        handle: Arc::new(handle),
        jumps,
        input: tx,
        sftp: Mutex::new(None),
    });
    state
        .sessions
        .lock()
        .await
        .insert(id.clone(), session.clone());
    let _ = app.emit("session", json!({"id":id,"status":"connected"}));
    tokio::spawn(async move {
        loop {
            tokio::select! {
                input = rx.recv() => match input {
                    Some(Input::Data(data)) => { if channel.data(&data[..]).await.is_err() { break; } },
                    Some(Input::Resize(cols,rows)) => { let _ = channel.window_change(cols,rows,0,0).await; },
                    _ => { let _ = channel.close().await; break; }
                },
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => { let _ = app.emit("terminal",json!({"id":id,"data":STANDARD.encode(&data[..])})); },
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "Session closed", "en")
            .await;
        for jump in session.jumps.iter() {
            let _ = jump
                .disconnect(russh::Disconnect::ByApplication, "Session closed", "en")
                .await;
        }
        state.sessions.lock().await.remove(&id);
        let _ = app.emit("session", json!({"id":id,"status":"closed"}));
    });
    Ok(())
}

pub type Sessions = Mutex<HashMap<String, Arc<Session>>>;

async fn await_channel_success(channel: &mut russh::Channel<client::Msg>) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) | Some(ChannelMsg::Close) | None => {
                    anyhow::bail!("Server từ chối mở terminal / PTY.")
                }
                _ => {}
            }
        }
    })
    .await?
}
