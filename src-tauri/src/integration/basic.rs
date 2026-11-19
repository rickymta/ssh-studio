use super::fixture::*;
use crate::{files, ssh};
use russh::{client, keys::PublicKeyOrCertificate};
use std::{sync::Arc, time::Duration};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simultaneous_sessions_sftp_roundtrip_and_host_key_rejection() {
    let fx = Fixture::start().await;
    std::fs::write(fx.remote_path("/hello.txt"), b"hello SFTP").unwrap();
    let key_id = fx.import_user_key().await;
    assert!(
        !std::fs::read_to_string(fx.local.path().join("vault").join("workspace.json"))
            .unwrap()
            .contains("BEGIN OPENSSH PRIVATE KEY")
    );
    let host = fx.host("fixture", USER, "password");
    let (a, b) = tokio::join!(
        ssh::establish(
            fx.sink.clone(),
            fx.state.clone(),
            "one".into(),
            host.clone(),
            PASSWORD.into()
        ),
        ssh::establish(
            fx.sink.clone(),
            fx.state.clone(),
            "two".into(),
            host.clone(),
            PASSWORD.into()
        )
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(fx.state.sessions.lock().await.len(), 2);
    let one = fx.state.sessions.lock().await.get("one").unwrap().clone();
    one.input
        .send(ssh::Input::Data("isolated-session-one".into()))
        .await
        .unwrap();
    eventually(|| async { fx.terminal_text("one").contains("isolated-session-one") }).await;
    assert!(!fx.terminal_text("two").contains("isolated-session-one"));

    let listing = files::list(&fx.state, Some("one".into()), "/".into())
        .await
        .unwrap();
    assert_eq!(listing["files"][0]["name"], "hello.txt");

    let payload = vec![91u8; 250_000];
    std::fs::write(fx.local.path().join("upload.bin"), &payload).unwrap();
    let request = crate::transfer::Transfer {
        id: "upload".into(),
        session_id: "one".into(),
        direction: "upload".into(),
        local_directory: fx.local.path().to_string_lossy().into(),
        remote_directory: "/".into(),
        name: "upload.bin".into(),
        ..Default::default()
    };
    crate::transfer::start(fx.sink.clone(), fx.state.clone(), request.clone())
        .await
        .unwrap();
    let result = fx.finished("upload").await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(
        std::fs::read(fx.remote_path("/upload.bin")).unwrap(),
        payload
    );

    let download = fx.local.path().join("download");
    std::fs::create_dir(&download).unwrap();
    crate::transfer::start(
        fx.sink.clone(),
        fx.state.clone(),
        crate::transfer::Transfer {
            id: "download".into(),
            direction: "download".into(),
            local_directory: download.to_string_lossy().into(),
            session_id: "two".into(),
            ..request.clone()
        },
    )
    .await
    .unwrap();
    let result = fx.finished("download").await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(std::fs::read(download.join("upload.bin")).unwrap(), payload);

    crate::transfer::start(
        fx.sink.clone(),
        fx.state.clone(),
        crate::transfer::Transfer {
            id: "duplicate".into(),
            ..request.clone()
        },
    )
    .await
    .unwrap();
    let result = fx.finished("duplicate").await;
    assert_eq!(result["status"], "failed");
    assert!(result["error"].as_str().unwrap().contains("tồn tại"));

    ssh::establish(
        fx.sink.clone(),
        fx.state.clone(),
        "key-session".into(),
        crate::store::Host {
            auth: "key".into(),
            key_id,
            ..host.clone()
        },
        String::new(),
    )
    .await
    .unwrap();
    fx.state
        .sessions
        .lock()
        .await
        .get("key-session")
        .unwrap()
        .input
        .send(ssh::Input::Close)
        .await
        .unwrap();
    assert!(
        ssh::establish(
            fx.sink.clone(),
            fx.state.clone(),
            "bad-password".into(),
            host.clone(),
            "wrong".into()
        )
        .await
        .is_err()
    );
    fx.state
        .store
        .lock()
        .await
        .data
        .known_hosts
        .insert(fx.address.clone(), "SHA256:changed".into());
    assert!(
        ssh::establish(
            fx.sink.clone(),
            fx.state.clone(),
            "bad-host".into(),
            host,
            PASSWORD.into()
        )
        .await
        .is_err()
    );
    one.input.send(ssh::Input::Close).await.unwrap();
    fx.wait(|n, v| n == "session" && v["id"] == "one" && v["status"] == "closed")
        .await;
    assert!(fx.state.sessions.lock().await.contains_key("two"));
    fx.state
        .sessions
        .lock()
        .await
        .get("two")
        .unwrap()
        .input
        .send(ssh::Input::Close)
        .await
        .unwrap();
}

/// Minimal client used to check the fixture itself, independent of the app code.
struct TrustAll;
impl client::Handler for TrustAll {
    type Error = anyhow::Error;
    async fn check_server_key(&mut self, _: &PublicKeyOrCertificate) -> anyhow::Result<bool> {
        Ok(true)
    }
}

async fn raw_client(port: u16) -> client::Handle<TrustAll> {
    client::connect(
        Arc::new(client::Config::default()),
        ("127.0.0.1", port),
        TrustAll,
    )
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixture_keyboard_interactive_and_partial_success() {
    use client::KeyboardInteractiveAuthResponse as K;
    let fx = Fixture::start().await;
    // kbd: password is refused, keyboard-interactive asks for it.
    let mut handle = raw_client(fx.port).await;
    let refused = handle
        .authenticate_password(KBD_USER, PASSWORD)
        .await
        .unwrap();
    assert!(
        matches!(refused, russh::client::AuthResult::Failure { partial_success: false, ref remaining_methods } if remaining_methods.contains(&russh::MethodKind::KeyboardInteractive))
    );
    let K::InfoRequest { prompts, .. } = handle
        .authenticate_keyboard_interactive_start(KBD_USER, None)
        .await
        .unwrap()
    else {
        panic!("expected prompt")
    };
    assert_eq!(prompts.len(), 1);
    assert!(!prompts[0].echo);
    assert!(matches!(
        handle
            .authenticate_keyboard_interactive_respond(vec![PASSWORD.into()])
            .await
            .unwrap(),
        K::Success
    ));

    // mfa: password gives partial success, then an OTP prompt.
    let mut handle = raw_client(fx.port).await;
    let first = handle
        .authenticate_password(MFA_USER, PASSWORD)
        .await
        .unwrap();
    assert!(matches!(
        first,
        russh::client::AuthResult::Failure {
            partial_success: true,
            ..
        }
    ));
    let K::InfoRequest { prompts, .. } = handle
        .authenticate_keyboard_interactive_start(MFA_USER, None)
        .await
        .unwrap()
    else {
        panic!("expected OTP prompt")
    };
    assert!(prompts[0].prompt.contains("OTP"));
    assert!(matches!(
        handle
            .authenticate_keyboard_interactive_respond(vec!["000000".into()])
            .await
            .unwrap(),
        K::Failure { .. }
    ));

    // An OTP without the first factor is never accepted.
    let mut handle = raw_client(fx.port).await;
    match handle
        .authenticate_keyboard_interactive_start(MFA_USER, None)
        .await
        .unwrap()
    {
        K::Failure { .. } => {}
        K::InfoRequest { .. } => {
            assert!(!matches!(
                handle
                    .authenticate_keyboard_interactive_respond(vec![OTP.into()])
                    .await
                    .unwrap(),
                K::Success
            ))
        }
        K::Success => panic!("OTP alone must not authenticate"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixture_direct_tcpip_and_tcpip_forward() {
    let fx = Fixture::start().await;
    let (echo_port, echo_task) = echo_server().await;
    let mut handle = raw_client(fx.port).await;
    assert!(
        handle
            .authenticate_password(USER, PASSWORD)
            .await
            .unwrap()
            .success()
    );
    // direct-tcpip (-L / jump host): the server dials the echo server for us.
    let channel = handle
        .channel_open_direct_tcpip("127.0.0.1", echo_port as u32, "127.0.0.1", 0)
        .await
        .unwrap();
    let mut stream = channel.into_stream();
    echo_roundtrip(&mut stream, b"through direct-tcpip").await;
    // Non-loopback targets are refused by the fixture.
    assert!(
        handle
            .channel_open_direct_tcpip("192.0.2.1", 22, "127.0.0.1", 0)
            .await
            .is_err()
    );
    // tcpip-forward (-R): the server binds a port and reports it.
    let port = handle.tcpip_forward("127.0.0.1", 0).await.unwrap();
    assert!(port > 0);
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port as u16))
            .await
            .is_ok()
    );
    handle
        .cancel_tcpip_forward("127.0.0.1", port)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port as u16))
            .await
            .is_err()
    );
    echo_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixture_sftp_uses_real_directory_tree() {
    let fx = Fixture::start().await;
    ssh::establish(
        fx.sink.clone(),
        fx.state.clone(),
        "s".into(),
        fx.host("h", USER, "password"),
        PASSWORD.into(),
    )
    .await
    .unwrap();
    let session = fx.state.sessions.lock().await.get("s").unwrap().clone();
    let sftp = session.files().await.unwrap();
    sftp.create_dir("/a").await.unwrap();
    sftp.create_dir("/a/b").await.unwrap();
    let mut file = sftp.create("/a/b/c.txt").await.unwrap();
    use tokio::io::AsyncWriteExt;
    file.write_all(b"nested").await.unwrap();
    file.shutdown().await.unwrap();
    assert_eq!(
        std::fs::read(fx.remote_path("/a/b/c.txt")).unwrap(),
        b"nested"
    );
    // mtime and permissions round-trip through setstat/stat.
    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
    attrs.mtime = Some(1_600_000_000);
    attrs.atime = Some(1_600_000_000);
    sftp.set_metadata("/a/b/c.txt", attrs).await.unwrap();
    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
    attrs.permissions = Some(0o600);
    sftp.set_metadata("/a/b/c.txt", attrs).await.unwrap();
    let meta = sftp.metadata("/a/b/c.txt").await.unwrap();
    assert_eq!(meta.mtime, Some(1_600_000_000));
    assert_eq!(meta.permissions.unwrap() & 0o777, 0o600);
    // rmdir refuses non-empty directories, rename never overwrites.
    assert!(sftp.remove_dir("/a").await.is_err());
    std::fs::write(fx.remote_path("/a/other.txt"), b"x").unwrap();
    assert!(sftp.rename("/a/other.txt", "/a/b/c.txt").await.is_err());
    // Virtual symlinks: lstat reports the link, stat follows it.
    fx.links
        .lock()
        .unwrap()
        .insert("/link-to-file".into(), "/a/b/c.txt".into());
    fx.links
        .lock()
        .unwrap()
        .insert("/link-to-dir".into(), "/a".into());
    assert!(
        sftp.symlink_metadata("/link-to-file")
            .await
            .unwrap()
            .is_symlink()
    );
    assert!(sftp.metadata("/link-to-file").await.unwrap().is_regular());
    assert!(sftp.metadata("/link-to-dir").await.unwrap().is_dir());
    assert_eq!(sftp.read("/link-to-dir/b/c.txt").await.unwrap(), b"nested");
    // Offsets: reading from the middle of a file.
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = sftp.open("/a/b/c.txt").await.unwrap();
    file.seek(std::io::SeekFrom::Start(3)).await.unwrap();
    let mut rest = String::new();
    file.read_to_string(&mut rest).await.unwrap();
    assert_eq!(rest, "ted");
    session.input.send(ssh::Input::Close).await.unwrap();
}
