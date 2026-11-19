use crate::{AppState, store::Host};
use russh::{
    ChannelMsg, client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
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
    Data(String),
    Resize(u32, u32),
    Close,
}
pub struct Session {
    pub handle: Arc<client::Handle<Handler>>,
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
}
pub async fn establish(
    app: crate::Events,
    state: Arc<AppState>,
    id: String,
    host: Host,
    password: String,
) -> anyhow::Result<()> {
    let config = client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    };
    let handler = Handler {
        app: app.clone(),
        state: state.clone(),
        address: format!("[{}]:{}", host.host, host.port),
    };
    let mut handle = tokio::time::timeout(
        Duration::from_secs(140),
        client::connect(Arc::new(config), (host.host.as_str(), host.port), handler),
    )
    .await??;
    let authenticated = if host.auth == "key" {
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
        handle
            .authenticate_publickey(
                &host.username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await?
            .success()
    } else {
        handle
            .authenticate_password(&host.username, password)
            .await?
            .success()
    };
    anyhow::ensure!(
        authenticated,
        "Xác thực thất bại. Kiểm tra username, password hoặc SSH key."
    );
    let mut channel = handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", 100, 30, 0, 0, &[])
        .await?;
    await_channel_success(&mut channel).await?;
    channel.request_shell(true).await?;
    await_channel_success(&mut channel).await?;
    let (tx, mut rx) = mpsc::channel(256);
    let session = Arc::new(Session {
        handle: Arc::new(handle),
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
                    Some(Input::Data(data)) => { if channel.data(data.as_bytes()).await.is_err() { break; } },
                    Some(Input::Resize(cols,rows)) => { let _ = channel.window_change(cols,rows,0,0).await; },
                    _ => { let _ = channel.close().await; break; }
                },
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => { let _ = app.emit("terminal",json!({"id":id,"data":data.to_vec()})); },
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "Session closed", "en")
            .await;
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
