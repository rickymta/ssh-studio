//! F3: sync preview and one-way synchronisation (with and without mirror deletes).
use super::fixture::*;
use crate::sync::{self, SyncItem, SyncRun};
use serde_json::Value;
use std::time::{Duration, UNIX_EPOCH};

fn touch(path: &std::path::Path, secs: u64) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(secs))
        .unwrap();
}
fn state_of<'a>(preview: &'a Value, path: &str) -> &'a str {
    preview["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"] == path)
        .unwrap_or_else(|| panic!("{path} missing from {preview}"))["state"]
        .as_str()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn preview_classifies_and_upload_sync_converges() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    let local = fx.local.path().join("site");
    std::fs::create_dir_all(local.join("css")).unwrap();
    std::fs::create_dir_all(local.join("new/deep")).unwrap();
    std::fs::write(local.join("index.html"), b"<h1>v2</h1>").unwrap();
    std::fs::write(local.join("css/app.css"), b"body{}").unwrap();
    std::fs::write(local.join("new/deep/x.js"), b"x").unwrap();
    std::fs::write(local.join("same.txt"), b"same").unwrap();
    std::fs::write(local.join("older.txt"), b"old local").unwrap();
    std::fs::write(local.join("kind"), b"file here").unwrap();
    touch(&local.join("index.html"), 1_700_000_500);
    touch(&local.join("same.txt"), 1_700_000_000);
    touch(&local.join("older.txt"), 1_600_000_000);

    std::fs::create_dir_all(fx.remote_path("/site/css")).unwrap();
    std::fs::create_dir_all(fx.remote_path("/site/kind")).unwrap();
    std::fs::create_dir_all(fx.remote_path("/site/legacy")).unwrap();
    std::fs::write(fx.remote_path("/site/index.html"), b"<h1>v1</h1>").unwrap();
    std::fs::write(fx.remote_path("/site/same.txt"), b"same").unwrap();
    std::fs::write(fx.remote_path("/site/older.txt"), b"newer on server").unwrap();
    std::fs::write(fx.remote_path("/site/legacy/old.php"), b"<?php").unwrap();
    std::fs::write(fx.remote_path("/site/robots.txt"), b"x").unwrap();
    touch(&fx.remote_path("/site/index.html"), 1_700_000_000);
    touch(&fx.remote_path("/site/same.txt"), 1_700_000_001);
    touch(&fx.remote_path("/site/older.txt"), 1_700_000_000);

    let local_dir = local.to_string_lossy().to_string();
    let preview = sync::preview(&fx.state, "s", local_dir.clone(), "/site".into())
        .await
        .unwrap();
    assert_eq!(state_of(&preview, "index.html"), "localNewer");
    assert_eq!(state_of(&preview, "same.txt"), "same");
    assert_eq!(state_of(&preview, "older.txt"), "remoteNewer");
    assert_eq!(state_of(&preview, "css"), "same");
    assert_eq!(state_of(&preview, "css/app.css"), "localOnly");
    assert_eq!(state_of(&preview, "new"), "localOnly");
    assert_eq!(state_of(&preview, "new/deep/x.js"), "localOnly");
    assert_eq!(state_of(&preview, "legacy/old.php"), "remoteOnly");
    assert_eq!(state_of(&preview, "robots.txt"), "remoteOnly");
    assert_eq!(state_of(&preview, "kind"), "typeMismatch");

    // Default upload: local-only + local-newer; nothing deleted, remote-newer untouched.
    let item = |path: &str, folder| SyncItem {
        path: path.into(),
        folder,
    };
    let result = sync::run(
        fx.sink.clone(),
        fx.state.clone(),
        SyncRun {
            session_id: "s".into(),
            local_directory: local_dir.clone(),
            remote_directory: "/site".into(),
            direction: "upload".into(),
            items: vec![
                item("index.html", false),
                item("css/app.css", false),
                item("new", true),
                item("new/deep", true),
                item("new/deep/x.js", false),
            ],
            delete: vec![],
        },
    )
    .await
    .unwrap();
    assert_eq!(result["folders"], 2, "{result}");
    for id in result["ids"].as_array().unwrap() {
        let done = fx.finished(id.as_str().unwrap()).await;
        assert_eq!(done["status"], "completed", "{done}");
    }
    assert_eq!(
        std::fs::read(fx.remote_path("/site/index.html")).unwrap(),
        b"<h1>v2</h1>"
    );
    assert_eq!(
        std::fs::read(fx.remote_path("/site/new/deep/x.js")).unwrap(),
        b"x"
    );
    assert_eq!(
        std::fs::read(fx.remote_path("/site/older.txt")).unwrap(),
        b"newer on server"
    );
    assert!(fx.remote_path("/site/robots.txt").exists());

    // Mirror: remote-only entries are deleted (folder with its children).
    let result = sync::run(
        fx.sink.clone(),
        fx.state.clone(),
        SyncRun {
            session_id: "s".into(),
            local_directory: local_dir.clone(),
            remote_directory: "/site".into(),
            direction: "upload".into(),
            items: vec![],
            delete: vec![
                "legacy".into(),
                "legacy/old.php".into(),
                "robots.txt".into(),
            ],
        },
    )
    .await
    .unwrap();
    assert_eq!(result["deleted"]["files"], 2, "{result}");
    assert_eq!(result["deleted"]["folders"], 1);
    assert!(!fx.remote_path("/site/legacy").exists());
    assert!(!fx.remote_path("/site/robots.txt").exists());

    // mtimes were kept, so a new preview shows the synced files as identical.
    let after = sync::preview(&fx.state, "s", local_dir.clone(), "/site".into())
        .await
        .unwrap();
    for path in ["index.html", "css/app.css", "new/deep/x.js"] {
        assert_eq!(state_of(&after, path), "same", "{path}");
    }
    assert_eq!(state_of(&after, "older.txt"), "remoteNewer");

    // Download direction pulls the newer server copy back.
    let result = sync::run(
        fx.sink.clone(),
        fx.state.clone(),
        SyncRun {
            session_id: "s".into(),
            local_directory: local_dir,
            remote_directory: "/site".into(),
            direction: "download".into(),
            items: vec![item("older.txt", false)],
            delete: vec![],
        },
    )
    .await
    .unwrap();
    let id = result["ids"][0].as_str().unwrap();
    assert_eq!(fx.finished(id).await["status"], "completed");
    assert_eq!(
        std::fs::read(local.join("older.txt")).unwrap(),
        b"newer on server"
    );

    // Paths that try to leave the synced folder are rejected.
    let escape = sync::run(
        fx.sink.clone(),
        fx.state.clone(),
        SyncRun {
            session_id: "s".into(),
            local_directory: fx.local.path().to_string_lossy().into(),
            remote_directory: "/site".into(),
            direction: "upload".into(),
            items: vec![item("../escape.txt", false)],
            delete: vec![],
        },
    )
    .await;
    assert!(escape.is_err());
}
