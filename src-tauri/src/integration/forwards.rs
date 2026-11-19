//! F5: local (-L), dynamic (-D) and remote (-R) forwards over the loopback fixture.
use super::fixture::*;
use crate::{
    forward::{self, Spec},
    ssh,
    store::Host,
};
use tokio::net::TcpStream;

fn spec(id: &str, kind: &str, bind_port: u16, target_port: u16) -> Spec {
    Spec {
        id: id.into(),
        kind: kind.into(),
        bind_host: "127.0.0.1".into(),
        bind_port,
        target_host: "127.0.0.1".into(),
        target_port,
    }
}
fn port_of(value: &serde_json::Value) -> u16 {
    value["boundPort"].as_u64().unwrap() as u16
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_forward_tunnels_and_stops() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    let (echo, echo_task) = echo_server().await;
    let started = forward::start(
        fx.sink.clone(),
        fx.state.clone(),
        "s".into(),
        spec("web", "local", 0, echo),
    )
    .await
    .unwrap();
    let port = port_of(&started);
    assert_ne!(port, 0);
    for round in 0..3 {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        echo_roundtrip(&mut client, format!("qua -L lần {round}").as_bytes()).await;
    }
    fx.wait(|n, v| n == "forward" && v["id"] == "s:web" && v["total"] == 3)
        .await;
    assert_eq!(forward::list(&fx.state).len(), 1);
    // The same forward cannot run twice.
    assert!(
        forward::start(
            fx.sink.clone(),
            fx.state.clone(),
            "s".into(),
            spec("web", "local", 0, echo)
        )
        .await
        .is_err()
    );
    // A busy local port is reported clearly.
    let busy = forward::start(
        fx.sink.clone(),
        fx.state.clone(),
        "s".into(),
        spec("dup", "local", port, echo),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(busy.contains("Không mở được cổng"), "{busy}");

    assert!(forward::stop(&fx.state, "s:web"));
    fx.wait(|n, v| n == "forward" && v["id"] == "s:web" && v["status"] == "stopped")
        .await;
    eventually(|| async { TcpStream::connect(("127.0.0.1", port)).await.is_err() }).await;
    echo_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dynamic_forward_is_a_socks5_proxy() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    let (echo, echo_task) = echo_server().await;
    let started = forward::start(
        fx.sink.clone(),
        fx.state.clone(),
        "s".into(),
        spec("socks", "dynamic", 0, 0),
    )
    .await
    .unwrap();
    let port = port_of(&started);
    for target in ["127.0.0.1", "localhost"] {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        crate::proxy::socks5(&mut client, None, target, echo)
            .await
            .unwrap();
        echo_roundtrip(&mut client, target.as_bytes()).await;
    }
    // The fixture server refuses other destinations: the SOCKS client gets a failure reply.
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let refused = crate::proxy::socks5(&mut client, None, "example.invalid", 80)
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("SOCKS5"), "{refused}");
    echo_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_forward_routes_server_port_to_local_target() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    let (echo, echo_task) = echo_server().await;
    let started = forward::start(
        fx.sink.clone(),
        fx.state.clone(),
        "s".into(),
        spec("rev", "remote", 0, echo),
    )
    .await
    .unwrap();
    // The fixture "server" listens on 127.0.0.1:<granted port>.
    let port = port_of(&started);
    assert_ne!(port, 0);
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    echo_roundtrip(&mut client, b"qua -R").await;
    drop(client);

    assert!(forward::stop(&fx.state, "s:rev"));
    eventually(|| async { TcpStream::connect(("127.0.0.1", port)).await.is_err() }).await;
    echo_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saved_forwards_start_on_connect_and_stop_on_disconnect() {
    let fx = Fixture::start().await;
    let (echo, echo_task) = echo_server().await;
    // A local port that is already taken: reported, the session still connects.
    let taken = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let taken_port = taken.local_addr().unwrap().port();
    let host = Host {
        forwards: vec![
            spec("auto", "local", 0, echo),
            spec("broken", "local", taken_port, echo),
        ],
        ..fx.host("h", USER, "password")
    };
    fx.answer(&[PASSWORD]);
    ssh::establish(fx.sink.clone(), fx.state.clone(), "s".into(), host)
        .await
        .unwrap();
    let running = fx
        .wait(|n, v| n == "forward" && v["id"] == "s:auto" && v["status"] == "running")
        .await;
    let error = fx
        .wait(|n, v| n == "forward" && v["id"] == "s:broken" && v["status"] == "error")
        .await;
    assert!(
        error["error"]
            .as_str()
            .unwrap()
            .contains(&format!("-L 127.0.0.1:{taken_port}"))
    );
    let port = port_of(&running);
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    echo_roundtrip(&mut client, b"auto").await;
    drop(client);

    let session = fx.state.sessions.lock().await.get("s").unwrap().clone();
    session.input.send(ssh::Input::Close).await.unwrap();
    fx.wait(|n, v| n == "forward" && v["id"] == "s:auto" && v["status"] == "stopped")
        .await;
    assert!(forward::list(&fx.state).is_empty());
    echo_task.abort();
}
