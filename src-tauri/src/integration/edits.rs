//! F2: remote text editing with conflict detection, recursive delete, chmod.
use super::fixture::*;
use crate::edit;
use std::time::{Duration, UNIX_EPOCH};

fn expected(value: &serde_json::Value) -> Option<(u64, u64)> {
    Some((value["size"].as_u64()?, value["mtime"].as_u64()?))
}
fn leftovers(fx: &Fixture) -> Vec<String> {
    std::fs::read_dir(fx.remote.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("sshstudio"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn edit_saves_keeps_permissions_and_detects_conflicts() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    std::fs::write(
        fx.remote_path("/app.conf"),
        "port = 80\r\nname = \"xin chào\"\r\n",
    )
    .unwrap();
    fx.modes.lock().unwrap().insert("/app.conf".into(), 0o640);

    let opened = edit::read_text(&fx.state, "s", "/app.conf".into())
        .await
        .unwrap();
    assert_eq!(
        opened["content"], "port = 80\r\nname = \"xin chào\"\r\n",
        "CRLF and UTF-8 are preserved"
    );
    assert_eq!(opened["permissions"].as_u64().unwrap() & 0o777, 0o640);

    let saved = edit::write_text(
        &fx.state,
        "s",
        "/app.conf".into(),
        "port = 8080\r\n".into(),
        expected(&opened),
        false,
    )
    .await
    .unwrap();
    assert_eq!(saved["conflict"], false, "{saved}");
    assert_eq!(
        std::fs::read_to_string(fx.remote_path("/app.conf")).unwrap(),
        "port = 8080\r\n"
    );
    assert_eq!(fx.modes.lock().unwrap()["/app.conf"], 0o640);
    assert!(leftovers(&fx).is_empty(), "{:?}", leftovers(&fx));

    // Someone else changes the file (same size, newer mtime): saving reports a conflict.
    std::fs::write(fx.remote_path("/app.conf"), "port = 9090\r\n").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(fx.remote_path("/app.conf"))
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(2_000_000_000))
        .unwrap();
    let conflict = edit::write_text(
        &fx.state,
        "s",
        "/app.conf".into(),
        "port = 1\r\n".into(),
        expected(&saved),
        false,
    )
    .await
    .unwrap();
    assert_eq!(conflict["conflict"], true);
    assert_eq!(conflict["exists"], true);
    assert_eq!(
        std::fs::read_to_string(fx.remote_path("/app.conf")).unwrap(),
        "port = 9090\r\n",
        "a conflict never writes"
    );
    // "Ghi đè" after the conflict.
    let forced = edit::write_text(
        &fx.state,
        "s",
        "/app.conf".into(),
        "port = 1\r\n".into(),
        expected(&saved),
        true,
    )
    .await
    .unwrap();
    assert_eq!(forced["conflict"], false);
    assert_eq!(
        std::fs::read_to_string(fx.remote_path("/app.conf")).unwrap(),
        "port = 1\r\n"
    );

    // Deleted on the server since it was opened.
    std::fs::remove_file(fx.remote_path("/app.conf")).unwrap();
    let gone = edit::write_text(
        &fx.state,
        "s",
        "/app.conf".into(),
        "x".into(),
        expected(&forced),
        false,
    )
    .await
    .unwrap();
    assert_eq!(gone["conflict"], true);
    assert_eq!(gone["exists"], false);
    assert!(!fx.remote_path("/app.conf").exists());
    assert!(leftovers(&fx).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editor_refuses_binary_large_and_folders() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    std::fs::write(fx.remote_path("/blob.bin"), [0x7f, b'E', b'L', b'F', 0, 1]).unwrap();
    std::fs::write(
        fx.remote_path("/huge.log"),
        vec![b'a'; edit::MAX_TEXT as usize + 1],
    )
    .unwrap();
    std::fs::write(fx.remote_path("/latin1.txt"), [b'c', 0xe0, b'f', b'e']).unwrap();
    std::fs::create_dir(fx.remote_path("/folder")).unwrap();
    for (path, message) in [
        ("/blob.bin", "nhị phân"),
        ("/huge.log", "quá lớn"),
        ("/latin1.txt", "UTF-8"),
        ("/folder", "thư mục"),
    ] {
        let error = edit::read_text(&fx.state, "s", path.into())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(message), "{path}: {error}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recursive_delete_counts_first_and_never_follows_links() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    std::fs::create_dir_all(fx.remote_path("/site/assets/img")).unwrap();
    std::fs::create_dir_all(fx.remote_path("/site/empty")).unwrap();
    std::fs::write(fx.remote_path("/site/index.html"), b"<h1>").unwrap();
    std::fs::write(fx.remote_path("/site/assets/img/logo.png"), b"png").unwrap();
    std::fs::create_dir(fx.remote_path("/shared")).unwrap();
    std::fs::write(fx.remote_path("/shared/keep.txt"), b"keep").unwrap();
    fx.links
        .lock()
        .unwrap()
        .insert("/site/shared-link".into(), "/shared".into());
    std::fs::write(fx.remote_path("/notes.txt"), b"n").unwrap();
    let names = vec!["site".to_string(), "notes.txt".to_string()];

    let counted = edit::delete_entries(
        &fx.state,
        Some("s".into()),
        "/".into(),
        names.clone(),
        false,
    )
    .await
    .unwrap();
    // index.html, logo.png, shared-link, notes.txt / site, assets, img, empty
    assert_eq!(counted, serde_json::json!({"files": 4, "folders": 4}));
    assert!(
        fx.remote_path("/site/index.html").exists(),
        "counting deletes nothing"
    );

    let deleted = edit::delete_entries(&fx.state, Some("s".into()), "/".into(), names, true)
        .await
        .unwrap();
    assert_eq!(deleted, counted);
    assert!(!fx.remote_path("/site").exists());
    assert!(!fx.remote_path("/notes.txt").exists());
    assert!(fx.links.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read(fx.remote_path("/shared/keep.txt")).unwrap(),
        b"keep",
        "the link target survives"
    );

    // Local side.
    let local = fx.local.path().join("build");
    std::fs::create_dir_all(local.join("out/deep")).unwrap();
    std::fs::write(local.join("out/deep/a.o"), b"o").unwrap();
    let deleted = edit::delete_entries(
        &fx.state,
        None,
        fx.local.path().to_string_lossy().into(),
        vec!["build".into()],
        true,
    )
    .await
    .unwrap();
    assert_eq!(deleted, serde_json::json!({"files": 1, "folders": 3}));
    assert!(!local.exists());

    // Unsafe names are rejected before anything is touched.
    assert!(
        edit::delete_entries(
            &fx.state,
            Some("s".into()),
            "/".into(),
            vec!["..".into()],
            true
        )
        .await
        .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chmod_sets_permission_bits() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    std::fs::write(fx.remote_path("/deploy.sh"), b"#!/bin/sh").unwrap();
    edit::chmod(&fx.state, "s", "/".into(), "deploy.sh".into(), 0o750)
        .await
        .unwrap();
    assert_eq!(fx.modes.lock().unwrap()["/deploy.sh"], 0o750);
    assert!(
        edit::chmod(&fx.state, "s", "/".into(), "deploy.sh".into(), 0o17777)
            .await
            .is_err()
    );
}
