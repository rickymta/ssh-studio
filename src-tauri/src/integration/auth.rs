//! F4: unified auth prompts, keyboard-interactive / MFA, SSH agent, jump host, proxies.
use super::fixture::*;
use crate::{files, ssh, store::Host};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn prompts(fx: &Fixture) -> Vec<Value> {
    fx.events
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "auth-prompt")
        .map(|(_, v)| v.clone())
        .collect()
}
fn all_events(fx: &Fixture) -> String {
    fx.events
        .lock()
        .unwrap()
        .iter()
        .map(|(n, v)| format!("{n} {v}\n"))
        .collect()
}
async fn open(fx: &Fixture, id: &str, host: Host) -> anyhow::Result<()> {
    ssh::establish(fx.sink.clone(), fx.state.clone(), id.into(), host).await
}
async fn save(fx: &Fixture, mut host: Host) -> Host {
    host.validate().unwrap();
    host.seal_proxy_password(None).unwrap();
    let mut store = fx.state.store.lock().await;
    store.data.hosts.retain(|h| h.id != host.id);
    store.data.hosts.push(host.clone());
    store.save().unwrap();
    host
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn password_prompt_cancel_and_no_secrets_in_events() {
    let fx = Fixture::start().await;
    fx.answer(&[PASSWORD]);
    open(&fx, "a", fx.host("h", USER, "password"))
        .await
        .unwrap();
    let asked = prompts(&fx);
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["sessionId"], "a");
    assert_eq!(asked[0]["prompts"][0]["label"], "Password");
    assert_eq!(asked[0]["prompts"][0]["echo"], false);
    assert!(
        fx.state.prompts.lock().unwrap().is_empty(),
        "answered prompts are forgotten"
    );

    // Empty answer queue = the user pressed Hủy.
    let cancelled = open(&fx, "b", fx.host("h", USER, "password"))
        .await
        .unwrap_err()
        .to_string();
    assert!(cancelled.contains("Đã hủy"), "{cancelled}");
    assert!(!all_events(&fx).contains(PASSWORD));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mfa_password_then_otp_and_publickey_then_otp() {
    let fx = Fixture::start().await;
    fx.answer(&[PASSWORD, OTP]);
    open(&fx, "pw", fx.host("h", MFA_USER, "password"))
        .await
        .unwrap();
    let asked = prompts(&fx);
    assert_eq!(asked.len(), 2, "{asked:?}");
    assert_eq!(asked[1]["title"], "Xác thực hai bước");
    assert_eq!(asked[1]["instructions"], "Nhập mã trong ứng dụng OTP");
    assert_eq!(asked[1]["prompts"][0]["label"], "Mã OTP: ");

    // Wrong OTP fails cleanly.
    fx.clear_events();
    fx.answer(&[PASSWORD, "000000"]);
    assert!(
        open(&fx, "bad", fx.host("h", MFA_USER, "password"))
            .await
            .is_err()
    );

    // Key first, then OTP (partial success after publickey).
    fx.clear_events();
    let key_id = fx.import_user_key().await;
    fx.answer(&[OTP]);
    open(
        &fx,
        "key",
        Host {
            key_id,
            ..fx.host("h", MFA_KEY_USER, "key")
        },
    )
    .await
    .unwrap();
    assert_eq!(prompts(&fx).len(), 1);
    let events = all_events(&fx);
    assert!(!events.contains(OTP) && !events.contains(PASSWORD));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keyboard_interactive_only_server() {
    let fx = Fixture::start().await;
    // Saved as "password": the rejected password is reused for the single hidden prompt.
    fx.answer(&[PASSWORD]);
    open(&fx, "auto", fx.host("h", KBD_USER, "password"))
        .await
        .unwrap();
    assert_eq!(prompts(&fx).len(), 1);

    // Saved as "interactive": the server's own question is shown.
    fx.clear_events();
    fx.answer(&[PASSWORD]);
    open(&fx, "ki", fx.host("h", KBD_USER, "interactive"))
        .await
        .unwrap();
    let asked = prompts(&fx);
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["prompts"][0]["label"], "Password: ");
    assert!(
        asked[0]["title"]
            .as_str()
            .unwrap()
            .contains("kbd@127.0.0.1")
    );
}

/// Runs russh's agent server on a fresh named pipe (Windows) or Unix socket holding `key`.
async fn start_agent(fx: &Fixture) -> tokio::task::JoinHandle<()> {
    #[cfg(windows)]
    let (path, task) = {
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = format!(r"\\.\pipe\sshstudio-test-agent-{}", uuid::Uuid::new_v4());
        let first = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)
            .unwrap();
        let pipe = name.clone();
        let listener = futures::stream::unfold(first, move |server| {
            let pipe = pipe.clone();
            async move {
                server.connect().await.ok()?;
                let next = ServerOptions::new().create(&pipe).ok()?;
                Some((Ok(server), next))
            }
        });
        let task = tokio::spawn(async move {
            let _ = russh::keys::agent::server::serve(Box::pin(listener), ()).await;
        });
        (name, task)
    };
    #[cfg(unix)]
    let (path, task) = {
        let path = fx.local.path().join("agent.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let incoming = futures::stream::unfold(listener, |l| async move {
            let stream = l.accept().await.map(|(s, _)| s);
            Some((stream, l))
        });
        let task = tokio::spawn(async move {
            let _ = russh::keys::agent::server::serve(Box::pin(incoming), ()).await;
        });
        (path.to_string_lossy().to_string(), task)
    };
    #[cfg(windows)]
    let mut client = russh::keys::agent::client::AgentClient::connect_named_pipe(&path)
        .await
        .unwrap();
    #[cfg(unix)]
    let mut client = russh::keys::agent::client::AgentClient::connect_uds(&path)
        .await
        .unwrap();
    client.add_identity(&fx.user_key, &[]).await.unwrap();
    *fx.state.agent_path.lock().unwrap() = Some(path);
    task
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ssh_agent_signs_without_the_key_leaving_the_agent() {
    let fx = Fixture::start().await;
    let agent = start_agent(&fx).await;
    open(&fx, "ag", fx.host("h", USER, "agent")).await.unwrap();
    assert!(prompts(&fx).is_empty(), "no secret is asked for");
    assert!(fx.state.store.lock().await.data.keys.is_empty());
    let listing = files::list(&fx.state, Some("ag".into()), "/".into())
        .await
        .unwrap();
    assert!(listing["files"].is_array());

    // Agent + OTP (publickey partial success, then keyboard-interactive).
    fx.answer(&[OTP]);
    open(&fx, "ag-mfa", fx.host("h", MFA_KEY_USER, "agent"))
        .await
        .unwrap();
    agent.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn jump_host_chain_and_loop_detection() {
    let fx = Fixture::start().await;
    let key_id = fx.import_user_key().await;
    let jump = save(&fx, fx.host("jump", USER, "password")).await;
    // The target is the same loopback server, reached through the jump host's direct-tcpip.
    let target = save(
        &fx,
        Host {
            key_id,
            jump_host_id: jump.id.clone(),
            ..fx.host("target", USER, "key")
        },
    )
    .await;
    fx.answer(&[PASSWORD]);
    open(&fx, "via", target.clone()).await.unwrap();
    let asked = prompts(&fx);
    assert_eq!(asked.len(), 1, "only the jump host asks for a password");
    let session = fx.state.sessions.lock().await.get("via").unwrap().clone();
    assert_eq!(session.jumps.len(), 1);
    std::fs::write(fx.remote_path("/through-jump.txt"), b"ok").unwrap();
    let listing = files::list(&fx.state, Some("via".into()), "/".into())
        .await
        .unwrap();
    assert_eq!(listing["files"][0]["name"], "through-jump.txt");

    // Closing the session also closes the jump connection.
    session.input.send(ssh::Input::Close).await.unwrap();
    fx.wait(|n, v| n == "session" && v["id"] == "via" && v["status"] == "closed")
        .await;
    eventually(|| async { session.jumps[0].is_closed() }).await;

    // jump → target → jump is refused before any prompt.
    save(
        &fx,
        Host {
            jump_host_id: target.id.clone(),
            ..jump.clone()
        },
    )
    .await;
    fx.clear_events();
    let error = open(&fx, "loop", target).await.unwrap_err().to_string();
    assert!(error.contains("lặp"), "{error}");
}

/// What a test proxy saw: (username, password) of the client, target "host:port".
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

async fn socks5_proxy(user: &'static str, pass: &'static str, seen: Seen) -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut head = [0u8; 2];
                client.read_exact(&mut head).await.ok()?;
                let mut methods = vec![0u8; head[1] as usize];
                client.read_exact(&mut methods).await.ok()?;
                if !methods.contains(&2) {
                    client.write_all(&[5, 0xff]).await.ok()?;
                    return None;
                }
                client.write_all(&[5, 2]).await.ok()?;
                let mut ver_len = [0u8; 2];
                client.read_exact(&mut ver_len).await.ok()?;
                let mut u = vec![0u8; ver_len[1] as usize];
                client.read_exact(&mut u).await.ok()?;
                let mut plen = [0u8; 1];
                client.read_exact(&mut plen).await.ok()?;
                let mut p = vec![0u8; plen[0] as usize];
                client.read_exact(&mut p).await.ok()?;
                let (u, p) = (String::from_utf8(u).ok()?, String::from_utf8(p).ok()?);
                if u != user || p != pass {
                    client.write_all(&[1, 1]).await.ok()?;
                    return None;
                }
                client.write_all(&[1, 0]).await.ok()?;
                let mut req = [0u8; 4];
                client.read_exact(&mut req).await.ok()?;
                let host = match req[3] {
                    1 => {
                        let mut ip = [0u8; 4];
                        client.read_exact(&mut ip).await.ok()?;
                        std::net::Ipv4Addr::from(ip).to_string()
                    }
                    3 => {
                        let mut len = [0u8; 1];
                        client.read_exact(&mut len).await.ok()?;
                        let mut name = vec![0u8; len[0] as usize];
                        client.read_exact(&mut name).await.ok()?;
                        String::from_utf8(name).ok()?
                    }
                    _ => return None,
                };
                let mut port = [0u8; 2];
                client.read_exact(&mut port).await.ok()?;
                let port = u16::from_be_bytes(port);
                seen.lock().unwrap().push((u, p, format!("{host}:{port}")));
                let mut upstream = tokio::net::TcpStream::connect((host.as_str(), port))
                    .await
                    .ok()?;
                client
                    .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                    .await
                    .ok()?;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                Some(())
            });
        }
    });
    port
}

async fn http_proxy(user: &'static str, pass: &'static str, seen: Seen) -> u16 {
    use base64::Engine;
    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"))
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let (seen, expected) = (seen.clone(), expected.clone());
            tokio::spawn(async move {
                let mut head = vec![];
                while !head.ends_with(b"\r\n\r\n") {
                    let mut b = [0u8; 1];
                    client.read_exact(&mut b).await.ok()?;
                    head.push(b[0]);
                }
                let head = String::from_utf8(head).ok()?;
                let target = head.split_whitespace().nth(1)?.to_string();
                let authorized = head
                    .lines()
                    .any(|l| l.eq_ignore_ascii_case(&format!("Proxy-Authorization: {expected}")));
                if !authorized {
                    client
                        .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                        .await
                        .ok()?;
                    return None;
                }
                seen.lock()
                    .unwrap()
                    .push((user.into(), pass.into(), target.clone()));
                let mut upstream = tokio::net::TcpStream::connect(target).await.ok()?;
                client
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .await
                    .ok()?;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                Some(())
            });
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn socks5_and_http_proxies_with_vault_password() {
    let fx = Fixture::start().await;
    let seen: Seen = Default::default();
    let socks = socks5_proxy("alice", "proxy-pass-1", seen.clone()).await;
    let http = http_proxy("bob", "proxy-pass-2", seen.clone()).await;
    let key_id = fx.import_user_key().await;
    let via = |id: &str, kind: &str, port: u16, user: &str, pass: &str| {
        let mut host = Host {
            key_id: key_id.clone(),
            ..fx.host(id, USER, "key")
        };
        host.proxy = crate::store::Proxy {
            kind: kind.into(),
            host: "127.0.0.1".into(),
            port,
            username: user.into(),
            password: Some(pass.into()),
            ..Default::default()
        };
        host
    };
    let socks_host = save(&fx, via("s5", "socks5", socks, "alice", "proxy-pass-1")).await;
    let http_host = save(&fx, via("http", "http", http, "bob", "proxy-pass-2")).await;
    open(&fx, "s5", socks_host).await.unwrap();
    open(&fx, "http", http_host).await.unwrap();
    let seen_now = seen.lock().unwrap().clone();
    assert_eq!(seen_now.len(), 2);
    assert_eq!(seen_now[0].2, format!("127.0.0.1:{}", fx.port));
    assert_eq!(seen_now[1].1, "proxy-pass-2");
    let listing = files::list(&fx.state, Some("http".into()), "/".into())
        .await
        .unwrap();
    assert!(listing["files"].is_array());

    // The proxy password is only in the vault: not on disk, in the snapshot or in events.
    let disk = std::fs::read_to_string(fx.local.path().join("vault/workspace.json")).unwrap();
    let snapshot = fx.state.store.lock().await.snapshot().to_string();
    for secret in ["proxy-pass-1", "proxy-pass-2"] {
        assert!(!disk.contains(secret));
        assert!(!snapshot.contains(secret));
        assert!(!all_events(&fx).contains(secret));
    }

    // Wrong proxy password: clear error, nothing is retried with other credentials.
    let wrong = save(&fx, via("bad", "socks5", socks, "alice", "nope")).await;
    let error = open(&fx, "bad", wrong).await.unwrap_err().to_string();
    assert!(error.contains("từ chối"), "{error}");
    let wrong = save(&fx, via("bad2", "http", http, "bob", "nope")).await;
    let error = open(&fx, "bad2", wrong).await.unwrap_err().to_string();
    assert!(error.contains("407"), "{error}");
}
