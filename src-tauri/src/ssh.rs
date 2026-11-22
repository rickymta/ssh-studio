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
    /// Remote (-R) forwards of this connection, by server port.
    pub routes: crate::forward::Routes,
}
impl client::Handler for Handler {
    type Error = anyhow::Error;
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Unknown ports are refused (dropping `reply` rejects the channel).
        let route = self.routes.lock().unwrap().get(&connected_port).cloned();
        if let Some(route) = route {
            reply.accept().await;
            crate::forward::serve_remote(route, channel);
        }
        Ok(())
    }
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
    pub routes: crate::forward::Routes,
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

/// The default (modern algorithms only) configuration.
#[cfg(test)]
pub(crate) fn client_config() -> Arc<client::Config> {
    client_config_for(false)
}

/// Algorithms offered on top of russh's defaults when "Tương thích server cũ" is on, in the
/// order OpenSSH prefers them. Old network gear, NAS and CentOS 5/6-era servers often speak
/// only these.
const LEGACY_KEX: [russh::kex::Name; 6] = [
    russh::kex::ECDH_SHA2_NISTP256,
    russh::kex::ECDH_SHA2_NISTP384,
    russh::kex::ECDH_SHA2_NISTP521,
    russh::kex::DH_GEX_SHA1,
    russh::kex::DH_G14_SHA1,
    russh::kex::DH_G1_SHA1,
];
const LEGACY_CIPHERS: [russh::cipher::Name; 4] = [
    russh::cipher::AES_128_CBC,
    russh::cipher::AES_192_CBC,
    russh::cipher::AES_256_CBC,
    russh::cipher::TRIPLE_DES_CBC,
];
const LEGACY_MACS: [russh::mac::Name; 2] = [russh::mac::HMAC_SHA1_ETM, russh::mac::HMAC_SHA1];

/// russh's defaults, plus the legacy algorithms after them (modern ones still win whenever the
/// server has them). Kex extension markers (ext-info, strict kex) stay at the end of the list.
pub(crate) fn legacy_preferred() -> russh::Preferred {
    let base = russh::Preferred::DEFAULT;
    let (markers, kex): (Vec<_>, Vec<_>) = base.kex.iter().copied().partition(|name| {
        name.as_ref().starts_with("ext-info") || name.as_ref().starts_with("kex-strict")
    });
    let mut key = base.key.to_vec();
    key.push(russh::keys::Algorithm::Dsa);
    russh::Preferred {
        kex: kex.into_iter().chain(LEGACY_KEX).chain(markers).collect(),
        key: key.into(),
        cipher: base.cipher.iter().copied().chain(LEGACY_CIPHERS).collect(),
        mac: base.mac.iter().copied().chain(LEGACY_MACS).collect(),
        ..base
    }
}

pub(crate) fn client_config_for(legacy: bool) -> Arc<client::Config> {
    Arc::new(client::Config {
        preferred: if legacy {
            legacy_preferred()
        } else {
            russh::Preferred::DEFAULT
        },
        // Interactive traffic is many tiny packets: without TCP_NODELAY, Nagle holds each
        // keystroke until the previous one is acknowledged, so typing echoes late (OpenSSH
        // sets it for interactive sessions too).
        nodelay: true,
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

/// The user's reply to an auth prompt. `remember` is the "Lưu mật khẩu" checkbox, offered
/// only for login passwords.
pub struct Answer {
    pub values: Vec<String>,
    pub remember: bool,
}

/// A hidden keyboard-interactive question that asks for the login password (not an OTP).
fn asks_password(label: &str) -> bool {
    let label = label.to_lowercase();
    label.contains("password") || label.contains("mật khẩu")
}

/// Remembered-password bookkeeping for one authentication.
struct Remember {
    /// Password remembered for this host, not tried yet.
    saved: Option<String>,
    /// The remembered password was sent (if a prompt follows, the server rejected it).
    saved_tried: bool,
    /// Last password typed at a prompt, with the state of its "remember" checkbox.
    typed: Option<(String, bool)>,
}

impl Remember {
    fn new(host: &Host) -> Self {
        Self {
            // A vault error just means asking again.
            saved: host.saved_password().unwrap_or_default(),
            saved_tried: false,
            typed: None,
        }
    }
    fn take_saved(&mut self) -> Option<String> {
        let saved = self.saved.take();
        self.saved_tried |= saved.is_some();
        saved
    }
    /// Asks for the login password; the checkbox starts ticked when one was remembered.
    async fn ask(&mut self, ctx: &Ctx<'_>, title: String, note: String) -> anyhow::Result<String> {
        let answer = ctx
            .ask(
                title,
                note,
                vec![("Password".into(), false)],
                Some(self.saved_tried),
            )
            .await?;
        let password = answer.values.into_iter().next().unwrap_or_default();
        self.typed = Some((password.clone(), answer.remember));
        Ok(password)
    }
    /// After a successful login: seal the typed password if the user asked to, or drop a
    /// remembered one the server rejected. Only the stored host with the same login changes.
    async fn finish(self, ctx: &Ctx<'_>, host: &Host) {
        let secret = match (&self.typed, self.saved_tried) {
            (Some((password, true)), _) => match crate::store::seal(password.as_bytes()) {
                Ok(secret) => secret,
                Err(e) => {
                    eprintln!("Không lưu được mật khẩu vào vault: {e}");
                    return;
                }
            },
            (Some((_, false)), true) => String::new(),
            _ => return,
        };
        let saved = !secret.is_empty();
        let mut store = ctx.state.store.lock().await;
        let same = |h: &&mut Host| {
            h.id == host.id
                && h.host == host.host
                && h.port == host.port
                && h.username == host.username
                && crate::store::remembers_password(&h.auth)
        };
        let Some(stored) = store.data.hosts.iter_mut().find(same) else {
            return;
        };
        let before = std::mem::replace(&mut stored.password_secret, secret);
        if let Err(e) = store.save() {
            if let Some(stored) = store.data.hosts.iter_mut().find(same) {
                stored.password_secret = before;
            }
            eprintln!("Không lưu được workspace: {e}");
            return;
        }
        drop(store);
        let _ = ctx
            .app
            .emit("host-password", json!({"hostId": host.id, "saved": saved}));
    }
}

impl Ctx<'_> {
    /// Shows a prompt (password, OTP, keyboard-interactive questions) and waits for the
    /// answers. `remember` offers the "remember password" checkbox (its initial state);
    /// answers are never logged or put in events, and only stored when the user ticks it.
    /// A cancelled prompt is an error.
    async fn ask(
        &self,
        title: String,
        instructions: String,
        prompts: Vec<(String, bool)>,
        remember: Option<bool>,
    ) -> anyhow::Result<Answer> {
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
                "remember": remember,
            }),
        );
        let answer = tokio::time::timeout(Duration::from_secs(300), rx).await;
        self.state.prompts.lock().unwrap().remove(&id);
        let _ = self.app.emit("auth-prompt-finished", json!({"id": id}));
        let mut answer = answer
            .map_err(|_| anyhow::anyhow!("Hết thời gian chờ nhập thông tin xác thực."))?
            .ok()
            .flatten()
            .ok_or_else(|| anyhow::anyhow!("Đã hủy xác thực."))?;
        anyhow::ensure!(
            answer.values.len() == prompts.len(),
            "Số câu trả lời không khớp với câu hỏi."
        );
        answer.remember &= remember.is_some();
        Ok(answer)
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
/// the server just rejected over the `password` method); a remembered password answers the
/// server's own password question. OTP and other questions are always asked.
async fn keyboard_interactive(
    ctx: &Ctx<'_>,
    handle: &mut Handle,
    host: &Host,
    mut autofill: Option<String>,
    remember: &mut Remember,
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
                let title = if name.trim().is_empty() {
                    format!("Xác thực {}@{}", host.username, host.host)
                } else {
                    name
                };
                let password = prompts.len() == 1 && !prompts[0].echo;
                let answers = if prompts.is_empty() {
                    vec![]
                } else if password && autofill.is_some() {
                    vec![autofill.take().unwrap_or_default()]
                } else if password && asks_password(&prompts[0].prompt) {
                    match remember.take_saved() {
                        Some(saved) => vec![saved],
                        None => {
                            let answer = ctx
                                .ask(
                                    title,
                                    instructions,
                                    vec![(prompts[0].prompt.clone(), false)],
                                    Some(remember.saved_tried),
                                )
                                .await?;
                            remember.typed = Some((answer.values[0].clone(), answer.remember));
                            answer.values
                        }
                    }
                } else {
                    ctx.ask(
                        title,
                        instructions,
                        prompts.into_iter().map(|p| (p.prompt, p.echo)).collect(),
                        None,
                    )
                    .await?
                    .values
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
    let mut remember = Remember::new(host);
    let title = format!("Mật khẩu cho {}@{}", host.username, host.host);
    for _ in 0..6 {
        tried.push(method.clone());
        let outcome = match method.as_str() {
            "key" => key_auth(ctx.state, handle, host).await?,
            "agent" => agent_auth(ctx.state, handle, host).await?,
            "interactive" => {
                keyboard_interactive(ctx, handle, host, autofill.take(), &mut remember).await?
            }
            _ => {
                let saved = remember.take_saved();
                let from_saved = saved.is_some();
                let mut password = match saved {
                    Some(saved) => saved,
                    None => remember.ask(ctx, title.clone(), String::new()).await?,
                };
                let mut result: Outcome = handle
                    .authenticate_password(&host.username, password.clone())
                    .await?
                    .into();
                // The remembered password no longer works: ask once, like a first login.
                if let Outcome::Failure {
                    partial: false,
                    remaining,
                } = &result
                    && from_saved
                    && remaining.contains(&MethodKind::Password)
                {
                    password = remember
                        .ask(
                            ctx,
                            title.clone(),
                            "Server từ chối mật khẩu đã lưu. Nhập lại mật khẩu.".into(),
                        )
                        .await?;
                    result = handle
                        .authenticate_password(&host.username, password.clone())
                        .await?
                        .into();
                }
                if let Outcome::Failure { partial: false, .. } = result {
                    autofill = Some(password);
                }
                result
            }
        };
        let (remaining, partial) = match outcome {
            Outcome::Success => {
                remember.finish(ctx, host).await;
                return Ok(());
            }
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
            None => {
                let names: Vec<&str> = remaining.iter().map(<&str>::from).collect();
                anyhow::bail!("{}", auth_failure(&host.username, &tried, &names))
            }
        }
    }
    anyhow::bail!("Xác thực thất bại: quá nhiều bước.")
}

/// "No common algorithm" in plain words: which kind is missing, what the server offers, and
/// whether "Tương thích server cũ" would help.
pub(crate) fn no_common_algorithm(
    kind: &russh::AlgorithmKind,
    theirs: &[String],
    legacy: bool,
) -> String {
    use russh::AlgorithmKind as K;
    let what = match kind {
        K::Kex => "trao đổi khóa (key exchange)",
        K::Key => "host key",
        K::Cipher => "mã hóa (cipher)",
        K::Mac => "MAC",
        K::Compression => "nén",
    };
    let offered = theirs
        .iter()
        .filter(|n| !n.starts_with("ext-info") && !n.starts_with("kex-strict"))
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if legacy {
        format!(
            "Không có thuật toán {what} chung với server, kể cả ở chế độ tương thích server cũ. Server chỉ hỗ trợ: {offered}."
        )
    } else {
        format!(
            "Server chỉ hỗ trợ thuật toán {what} cũ ({offered}). Bật “Tương thích server cũ” trong cấu hình server rồi kết nối lại."
        )
    }
}

fn explain_connect_error(e: anyhow::Error, host: &Host) -> anyhow::Error {
    match e.downcast_ref::<russh::Error>() {
        Some(russh::Error::NoCommonAlgo { kind, theirs, .. }) => anyhow::anyhow!(
            "{}",
            no_common_algorithm(kind, theirs, host.legacy_algorithms)
        ),
        _ => e,
    }
}

/// Why authentication ended without success: what was tried, what the server still accepts,
/// and the likely fix. `remaining` are the server's method names (publickey, password…).
pub(crate) fn auth_failure(username: &str, tried: &[String], remaining: &[&str]) -> String {
    let label = |m: &str| match m {
        "key" => "SSH key",
        "agent" => "SSH agent",
        "interactive" => "keyboard-interactive",
        _ => "mật khẩu",
    };
    let mut labels: Vec<&str> = vec![];
    for t in tried {
        if !labels.contains(&label(t)) {
            labels.push(label(t));
        }
    }
    let used_key = tried.iter().any(|t| t == "key" || t == "agent");
    let used_secret = tried.iter().any(|t| t == "password" || t == "interactive");
    let accepts = |m: &str| remaining.contains(&m);
    let hint = if remaining.is_empty() {
        "Server không cho thử thêm phương thức nào (có thể tài khoản bị khóa hoặc đã thử sai quá nhiều lần).".to_string()
    } else if accepts("publickey")
        && !used_key
        && !accepts("password")
        && !accepts("keyboard-interactive")
    {
        "Server chỉ nhận SSH key. Chọn “SSH Key” (nhập key vào trang SSH Keys) hoặc “Agent” nếu key nằm trong ssh-agent / Pageant. Lệnh ssh trong terminal tự thử các key trong ~/.ssh nên vẫn vào được.".to_string()
    } else if used_key
        && (accepts("password") || accepts("keyboard-interactive"))
        && !accepts("publickey")
    {
        "Server không nhận key này. Chọn “Mật khẩu” (hoặc “MFA / OTP”), hoặc thêm public key vào ~/.ssh/authorized_keys của user.".to_string()
    } else if used_key {
        format!(
            "Server từ chối key: kiểm tra public key đã có trong ~/.ssh/authorized_keys của “{username}” chưa."
        )
    } else if used_secret && accepts("publickey") {
        format!(
            "Kiểm tra lại username “{username}” và mật khẩu. Server cũng nhận SSH key: nếu lệnh ssh vào được mà không hỏi mật khẩu thì nó đang dùng key, hãy chọn “SSH Key” hoặc “Agent”."
        )
    } else {
        format!("Kiểm tra lại username “{username}” và mật khẩu.")
    };
    let server = if remaining.is_empty() {
        String::new()
    } else {
        format!(" Server chấp nhận: {}.", remaining.join(", "))
    };
    format!(
        "Xác thực thất bại (đã thử: {}).{server} {hint}",
        labels.join(", ")
    )
}

type Connected = (Handle, Vec<Arc<Handle>>, crate::forward::Routes);
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
        let routes = crate::forward::Routes::default();
        let handler = Handler {
            app: ctx.app.clone(),
            state: ctx.state.clone(),
            address: format!("[{}]:{}", host.host, host.port),
            routes: routes.clone(),
        };
        let timeout = Duration::from_secs(140);
        let config = client_config_for(host.legacy_algorithms);
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
            let (jump_handle, mut chain, _) = open(ctx, jump, visited).await?;
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
                client::connect_stream(config.clone(), channel.into_stream(), handler),
            )
            .await?
            .map_err(|e| explain_connect_error(e, &host))?;
            chain.insert(0, Arc::new(jump_handle));
            (handle, chain)
        } else if host.proxy.enabled() {
            let stream =
                crate::proxy::connect(&host.proxy, host.proxy.password()?, &host.host, host.port)
                    .await?;
            let handle = tokio::time::timeout(
                timeout,
                client::connect_stream(config.clone(), stream, handler),
            )
            .await?
            .map_err(|e| explain_connect_error(e, &host))?;
            (handle, vec![])
        } else {
            let handle = tokio::time::timeout(
                timeout,
                client::connect(config.clone(), (host.host.as_str(), host.port), handler),
            )
            .await?
            .map_err(|e| explain_connect_error(e, &host))?;
            (handle, vec![])
        };
        authenticate(ctx, &mut handle, &host)
            .await
            .map_err(|e| anyhow::anyhow!("{}: {e}", host.name))?;
        Ok((handle, jumps, routes))
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
    let (handle, jumps, routes) = open(&ctx, host.clone(), vec![]).await?;
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
        routes,
        input: tx,
        sftp: Mutex::new(None),
    });
    state
        .sessions
        .lock()
        .await
        .insert(id.clone(), session.clone());
    let _ = app.emit("session", json!({"id":id,"status":"connected"}));
    if !host.forwards.is_empty() {
        tokio::spawn(crate::forward::autostart(
            app.clone(),
            state.clone(),
            id.clone(),
            host.forwards.clone(),
        ));
    }
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
        crate::forward::stop_session(&state, &id);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_algorithms_come_after_the_modern_ones() {
        let modern = russh::Preferred::DEFAULT;
        let legacy = legacy_preferred();
        let kex: Vec<&str> = legacy.kex.iter().map(|n| n.as_ref()).collect();
        // Modern first (still chosen when the server has them), extension markers last.
        assert_eq!(kex[0], modern.kex[0].as_ref());
        let g14 = kex
            .iter()
            .position(|n| *n == "diffie-hellman-group14-sha1")
            .unwrap();
        let curve = kex.iter().position(|n| *n == "curve25519-sha256").unwrap();
        assert!(curve < g14);
        assert!(kex.last().unwrap().starts_with("kex-strict"));
        assert!(
            kex.iter()
                .rev()
                .take(4)
                .all(|n| n.starts_with("ext-info") || n.starts_with("kex-strict"))
        );
        assert!(legacy.cipher.contains(&russh::cipher::AES_128_CBC));
        assert!(legacy.cipher.contains(&russh::cipher::TRIPLE_DES_CBC));
        assert!(legacy.mac.contains(&russh::mac::HMAC_SHA1));
        assert!(legacy.key.contains(&russh::keys::Algorithm::Dsa));
        // The default stays strict.
        assert!(!modern.kex.contains(&russh::kex::DH_G14_SHA1));
        assert!(
            !client_config()
                .preferred
                .mac
                .contains(&russh::mac::HMAC_SHA1)
        );
        assert!(
            client_config_for(true)
                .preferred
                .mac
                .contains(&russh::mac::HMAC_SHA1)
        );
    }

    #[test]
    fn missing_algorithms_are_explained() {
        let theirs = vec![
            "diffie-hellman-group14-sha1".to_string(),
            "ext-info-s".to_string(),
        ];
        let off = no_common_algorithm(&russh::AlgorithmKind::Kex, &theirs, false);
        assert!(off.contains("Tương thích server cũ"), "{off}");
        assert!(off.contains("diffie-hellman-group14-sha1"));
        assert!(!off.contains("ext-info"));
        let on = no_common_algorithm(&russh::AlgorithmKind::Mac, &theirs, true);
        assert!(on.contains("kể cả ở chế độ tương thích"), "{on}");
    }

    #[test]
    fn auth_failure_points_at_the_likely_fix() {
        let tried = |m: &[&str]| m.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let only_key = auth_failure("root", &tried(&["password"]), &["publickey"]);
        assert!(only_key.contains("Server chỉ nhận SSH key"), "{only_key}");
        let wrong = auth_failure("root", &tried(&["password", "interactive"]), &["password"]);
        assert!(
            wrong.contains("đã thử: mật khẩu, keyboard-interactive"),
            "{wrong}"
        );
        assert!(wrong.contains("username “root”"), "{wrong}");
        let key_refused = auth_failure("deploy", &tried(&["key"]), &["password"]);
        assert!(
            key_refused.contains("Server không nhận key này"),
            "{key_refused}"
        );
        let locked = auth_failure("root", &tried(&["password"]), &[]);
        assert!(locked.contains("không cho thử thêm"), "{locked}");
    }
}
