//! F5: port forwarding over an SSH session: local (-L), remote (-R) and dynamic SOCKS5 (-D).
//!
//! Local and dynamic forwards listen on this machine (127.0.0.1 by default) and open a
//! `direct-tcpip` channel per connection. Remote forwards ask the server to listen
//! (`tcpip-forward`); its `forwarded-tcpip` channels are routed by port to a local target
//! through the per-connection [`Routes`] table that the SSH client handler consults.
use crate::{AppState, Events, ssh::Session};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Spec {
    pub id: String,
    /// `local` | `remote` | `dynamic`.
    pub kind: String,
    /// Listening address: on this machine for local/dynamic, on the server for remote.
    pub bind_host: String,
    /// 0 lets the OS (local/dynamic) or the server (remote) choose.
    pub bind_port: u16,
    /// Destination: seen from the server for local, from this machine for remote.
    pub target_host: String,
    pub target_port: u16,
}
impl Spec {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.id.is_empty() && self.id.len() <= 64 && !self.id.contains(':'),
            "Mã forward không hợp lệ."
        );
        anyhow::ensure!(
            ["local", "remote", "dynamic"].contains(&self.kind.as_str()),
            "Kiểu forward không hợp lệ."
        );
        anyhow::ensure!(
            !self.bind_host.trim().is_empty(),
            "Thiếu địa chỉ lắng nghe."
        );
        if self.kind != "dynamic" {
            anyhow::ensure!(
                !self.target_host.trim().is_empty() && self.target_port > 0,
                "Điền địa chỉ và cổng đích."
            );
        }
        Ok(())
    }
    fn describe(&self) -> String {
        match self.kind.as_str() {
            "local" => format!(
                "-L {}:{}:{}:{}",
                self.bind_host, self.bind_port, self.target_host, self.target_port
            ),
            "remote" => format!(
                "-R {}:{}:{}:{}",
                self.bind_host, self.bind_port, self.target_host, self.target_port
            ),
            _ => format!("-D {}:{}", self.bind_host, self.bind_port),
        }
    }
}

#[derive(Default)]
pub struct Stats {
    active: AtomicUsize,
    total: AtomicUsize,
}

/// One running forward, shared by its tasks.
struct Live {
    app: Events,
    id: String,
    session_id: String,
    spec: Spec,
    bound_port: u16,
    stats: Arc<Stats>,
}
impl Live {
    fn emit(&self, status: &str, error: Option<String>) {
        let _ = self.app.emit("forward", self.json(status, error));
    }
    fn json(&self, status: &str, error: Option<String>) -> Value {
        json!({
            "id": self.id,
            "sessionId": self.session_id,
            "spec": self.spec,
            "boundPort": self.bound_port,
            "status": status,
            "active": self.stats.active.load(Ordering::SeqCst),
            "total": self.stats.total.load(Ordering::SeqCst),
            "error": error,
        })
    }
    /// Counts one tunnelled connection while `work` runs (or until the forward stops).
    async fn connection<F>(self: Arc<Self>, mut stop: watch::Receiver<bool>, work: F)
    where
        F: std::future::Future<Output = anyhow::Result<()>>,
    {
        self.stats.active.fetch_add(1, Ordering::SeqCst);
        self.stats.total.fetch_add(1, Ordering::SeqCst);
        self.emit("running", None);
        let result = tokio::select! {
            result = work => result,
            _ = stop.wait_for(|stopped| *stopped) => Ok(()),
        };
        self.stats.active.fetch_sub(1, Ordering::SeqCst);
        // A failed connection is reported but does not stop the forward.
        self.emit("running", result.err().map(|e| e.to_string()));
    }
}

pub struct Running {
    live: Arc<Live>,
    stop: watch::Sender<bool>,
}

/// Remote forward routes of one SSH connection: server port → local target.
pub type Routes = Arc<StdMutex<HashMap<u32, Route>>>;
#[derive(Clone)]
pub struct Route {
    live: Arc<Live>,
    stop: watch::Receiver<bool>,
}

/// Called by the SSH client handler for each `forwarded-tcpip` channel of a remote forward.
pub fn serve_remote(route: Route, channel: russh::Channel<russh::client::Msg>) {
    let (host, port) = (
        route.live.spec.target_host.clone(),
        route.live.spec.target_port,
    );
    tokio::spawn(
        route
            .live
            .clone()
            .connection(route.stop.clone(), async move {
                let mut socket = TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!("Không kết nối được {host}:{port} trên máy này: {e}")
                    })?;
                let mut stream = channel.into_stream();
                tokio::io::copy_bidirectional(&mut socket, &mut stream).await?;
                Ok(())
            }),
    );
}

pub async fn start(
    app: Events,
    state: Arc<AppState>,
    session_id: String,
    spec: Spec,
) -> anyhow::Result<Value> {
    spec.validate()?;
    let session = crate::files::session(&state, &session_id).await?;
    let id = format!("{session_id}:{}", spec.id);
    anyhow::ensure!(
        !state.forwards.lock().unwrap().contains_key(&id),
        "Forward này đang chạy."
    );
    let (stop_tx, stop_rx) = watch::channel(false);
    let stats = Arc::new(Stats::default());
    let live = |bound_port| {
        Arc::new(Live {
            app: app.clone(),
            id: id.clone(),
            session_id: session_id.clone(),
            spec: spec.clone(),
            bound_port,
            stats: stats.clone(),
        })
    };
    let live = if spec.kind == "remote" {
        let granted = session
            .handle
            .tcpip_forward(spec.bind_host.clone(), spec.bind_port as u32)
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "Server từ chối mở cổng {}:{} ({e}). Kiểm tra AllowTcpForwarding / GatewayPorts.",
                    spec.bind_host,
                    spec.bind_port
                )
            })?;
        let port = if spec.bind_port == 0 {
            granted
        } else {
            spec.bind_port as u32
        };
        let live = live(port as u16);
        session.routes.lock().unwrap().insert(
            port,
            Route {
                live: live.clone(),
                stop: stop_rx.clone(),
            },
        );
        let (session, mut stop, bind) = (session.clone(), stop_rx.clone(), spec.bind_host.clone());
        tokio::spawn(async move {
            let _ = stop.wait_for(|stopped| *stopped).await;
            session.routes.lock().unwrap().remove(&port);
            let _ = session.handle.cancel_tcpip_forward(bind, port).await;
        });
        live
    } else {
        let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port))
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "Không mở được cổng {}:{} trên máy này: {e}",
                    spec.bind_host,
                    spec.bind_port
                )
            })?;
        let live = live(listener.local_addr()?.port());
        tokio::spawn(accept(
            listener,
            live.clone(),
            session.clone(),
            stop_rx.clone(),
        ));
        live
    };
    let reply = live.json("running", None);
    state.forwards.lock().unwrap().insert(
        id,
        Running {
            live: live.clone(),
            stop: stop_tx,
        },
    );
    live.emit("running", None);
    Ok(reply)
}

async fn accept(
    listener: TcpListener,
    live: Arc<Live>,
    session: Arc<Session>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        let (socket, peer) = tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => return,
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(_) => continue,
            },
        };
        let session = session.clone();
        let spec = live.spec.clone();
        let work = async move {
            if spec.kind == "dynamic" {
                socks5_tunnel(socket, &session, peer).await
            } else {
                let channel = session
                    .handle
                    .channel_open_direct_tcpip(
                        spec.target_host.clone(),
                        spec.target_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "Server không mở được kết nối tới {}:{}: {e}",
                            spec.target_host,
                            spec.target_port
                        )
                    })?;
                let mut socket = socket;
                let mut stream = channel.into_stream();
                tokio::io::copy_bidirectional(&mut socket, &mut stream).await?;
                Ok(())
            }
        };
        tokio::spawn(live.clone().connection(stop.clone(), work));
    }
}

/// Minimal SOCKS5 server (no authentication, CONNECT only) for dynamic forwards. It listens on
/// 127.0.0.1 unless the user chose another address.
async fn socks5_tunnel(
    mut socket: TcpStream,
    session: &Session,
    peer: std::net::SocketAddr,
) -> anyhow::Result<()> {
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await?;
    anyhow::ensure!(head[0] == 5, "Ứng dụng không dùng SOCKS5.");
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 0xff]).await?;
        anyhow::bail!("Ứng dụng yêu cầu SOCKS5 có đăng nhập (không hỗ trợ).");
    }
    socket.write_all(&[5, 0]).await?;
    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await?;
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            socket.read_exact(&mut ip).await?;
            IpAddr::from(ip).to_string()
        }
        4 => {
            let mut ip = [0u8; 16];
            socket.read_exact(&mut ip).await?;
            IpAddr::from(ip).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            socket.read_exact(&mut name).await?;
            String::from_utf8(name)?
        }
        _ => {
            socket.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            anyhow::bail!("Kiểu địa chỉ SOCKS5 không hỗ trợ.");
        }
    };
    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);
    if request[1] != 1 {
        socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        anyhow::bail!("Chỉ hỗ trợ lệnh SOCKS5 CONNECT.");
    }
    let channel = match session
        .handle
        .channel_open_direct_tcpip(
            host.clone(),
            port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
    {
        Ok(channel) => channel,
        Err(e) => {
            socket.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            anyhow::bail!("Server không mở được kết nối tới {host}:{port}: {e}");
        }
    };
    socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream).await?;
    Ok(())
}

/// Stops a forward: closes its listener (or cancels the server listener) and its connections.
pub fn stop(state: &AppState, id: &str) -> bool {
    let Some(running) = state.forwards.lock().unwrap().remove(id) else {
        return false;
    };
    let _ = running.stop.send(true);
    running.live.emit("stopped", None);
    true
}

/// Stops every forward of a session (it disconnected).
pub fn stop_session(state: &AppState, session_id: &str) {
    let ids: Vec<String> = state
        .forwards
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, r)| r.live.session_id == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        stop(state, &id);
    }
}

pub fn list(state: &AppState) -> Vec<Value> {
    state
        .forwards
        .lock()
        .unwrap()
        .values()
        .map(|r| r.live.json("running", None))
        .collect()
}

/// Starts the forwards saved with the host; failures are reported as `forward` events.
pub async fn autostart(app: Events, state: Arc<AppState>, session_id: String, specs: Vec<Spec>) {
    for spec in specs {
        if let Err(error) =
            start(app.clone(), state.clone(), session_id.clone(), spec.clone()).await
        {
            let _ = app.emit(
                "forward",
                json!({
                    "id": format!("{session_id}:{}", spec.id),
                    "sessionId": session_id,
                    "spec": spec,
                    "status": "error",
                    "error": format!("{}: {error}", spec.describe()),
                    "active": 0,
                    "total": 0,
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn specs_are_validated() {
        let ok = Spec {
            id: "a".into(),
            kind: "local".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 8080,
            target_host: "db".into(),
            target_port: 5432,
        };
        ok.validate().unwrap();
        assert_eq!(ok.describe(), "-L 127.0.0.1:8080:db:5432");
        assert!(
            Spec {
                target_port: 0,
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            Spec {
                kind: "x".into(),
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        Spec {
            kind: "dynamic".into(),
            target_host: String::new(),
            target_port: 0,
            ..ok.clone()
        }
        .validate()
        .unwrap();
        assert!(
            Spec {
                id: "s:1".into(),
                ..ok
            }
            .validate()
            .is_err()
        );
    }
}
