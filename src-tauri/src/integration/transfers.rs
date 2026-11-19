//! F1: folders, conflict policies, resume, mtime, destination locking, cancel.
use super::fixture::*;
use crate::transfer::{Conflict, RESUME_OVERLAP, Transfer, partial_name};
use std::{sync::atomic::Ordering, time::UNIX_EPOCH};

fn mtime(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn set_mtime(path: &std::path::Path, secs: u64) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs))
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn folders_upload_and_download_recursively_with_mtime() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    let project = fx.local.path().join("project");
    std::fs::create_dir_all(project.join("src/deep/er")).unwrap();
    std::fs::create_dir_all(project.join("empty")).unwrap();
    std::fs::write(project.join("README.md"), b"# readme").unwrap();
    std::fs::write(project.join("src/main.rs"), vec![7u8; 300_000]).unwrap();
    std::fs::write(project.join("src/deep/er/leaf.txt"), b"leaf").unwrap();
    set_mtime(&project.join("src/main.rs"), 1_700_000_000);

    let result = fx
        .transfer(fx.request("up", "s", "upload", "project"))
        .await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(result["files"], 3);
    assert_eq!(result["total"], 300_000 + 8 + 4);
    assert_eq!(
        std::fs::read(fx.remote_path("/project/src/main.rs")).unwrap(),
        vec![7u8; 300_000]
    );
    assert_eq!(
        std::fs::read(fx.remote_path("/project/src/deep/er/leaf.txt")).unwrap(),
        b"leaf"
    );
    assert!(fx.remote_path("/project/empty").is_dir());
    assert_eq!(
        mtime(&fx.remote_path("/project/src/main.rs")),
        1_700_000_000
    );
    // No partial files are left behind.
    assert!(
        !walkdir_names(&fx.remote_path("/project"))
            .iter()
            .any(|n| n.ends_with(".part"))
    );

    // Download the tree back to a fresh local folder.
    let back = fx.local.path().join("back");
    std::fs::create_dir(&back).unwrap();
    let result = fx
        .transfer(Transfer {
            local_directory: back.to_string_lossy().into(),
            ..fx.request("down", "s", "download", "project")
        })
        .await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(
        std::fs::read(back.join("project/README.md")).unwrap(),
        b"# readme"
    );
    assert_eq!(
        std::fs::read(back.join("project/src/deep/er/leaf.txt")).unwrap(),
        b"leaf"
    );
    assert!(back.join("project/empty").is_dir());
    assert_eq!(mtime(&back.join("project/src/main.rs")), 1_700_000_000);
}

fn walkdir_names(root: &std::path::Path) -> Vec<String> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            out.push(entry.file_name().to_string_lossy().to_string());
            if entry.path().is_dir() {
                stack.push(entry.path());
            }
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn conflict_policies_fail_skip_rename_overwrite() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    std::fs::write(fx.local.path().join("report.txt"), b"new version").unwrap();
    std::fs::write(fx.remote_path("/report.txt"), b"old").unwrap();
    fx.modes.lock().unwrap().insert("/report.txt".into(), 0o600);
    let base = fx.request("t", "s", "upload", "report.txt");

    let failed = fx.transfer(base.clone()).await;
    assert_eq!(failed["status"], "failed");
    assert!(failed["error"].as_str().unwrap().contains("đã tồn tại"));
    assert_eq!(
        std::fs::read(fx.remote_path("/report.txt")).unwrap(),
        b"old"
    );

    let skipped = fx
        .transfer(Transfer {
            conflict: Conflict::Skip,
            ..base.clone()
        })
        .await;
    assert_eq!(skipped["status"], "skipped");
    assert_eq!(
        std::fs::read(fx.remote_path("/report.txt")).unwrap(),
        b"old"
    );

    let renamed = fx
        .transfer(Transfer {
            conflict: Conflict::Rename,
            ..base.clone()
        })
        .await;
    assert_eq!(renamed["status"], "completed", "{renamed}");
    assert_eq!(renamed["targetName"], "report (1).txt");
    assert_eq!(
        std::fs::read(fx.remote_path("/report (1).txt")).unwrap(),
        b"new version"
    );
    let again = fx
        .transfer(Transfer {
            conflict: Conflict::Rename,
            ..base.clone()
        })
        .await;
    assert_eq!(again["targetName"], "report (2).txt");

    let replaced = fx
        .transfer(Transfer {
            conflict: Conflict::Overwrite,
            ..base.clone()
        })
        .await;
    assert_eq!(replaced["status"], "completed", "{replaced}");
    assert_eq!(
        std::fs::read(fx.remote_path("/report.txt")).unwrap(),
        b"new version"
    );
    // The swap keeps the original permissions and leaves no backup file behind.
    assert_eq!(fx.modes.lock().unwrap()["/report.txt"], 0o600);
    assert!(
        !walkdir_names(fx.remote.path())
            .iter()
            .any(|n| n.contains("sshstudio"))
    );

    // Local overwrite on download, and a folder never replaces a file.
    std::fs::write(fx.remote_path("/report.txt"), b"remote edit").unwrap();
    let down = fx
        .transfer(Transfer {
            conflict: Conflict::Overwrite,
            ..fx.request("d", "s", "download", "report.txt")
        })
        .await;
    assert_eq!(down["status"], "completed", "{down}");
    assert_eq!(
        std::fs::read(fx.local.path().join("report.txt")).unwrap(),
        b"remote edit"
    );
    std::fs::create_dir(fx.local.path().join("docs")).unwrap();
    std::fs::write(fx.remote_path("/docs"), b"a file named docs").unwrap();
    let mismatch = fx
        .transfer(Transfer {
            conflict: Conflict::Overwrite,
            ..fx.request("m", "s", "upload", "docs")
        })
        .await;
    assert_eq!(mismatch["status"], "failed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupted_upload_resumes_from_partial() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    let size = 5 * 1024 * 1024;
    let payload: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    let source = fx.local.path().join("big.bin");
    std::fs::write(&source, &payload).unwrap();
    let meta = crate::transfer::Meta {
        is_dir: false,
        size: size as u64,
        mtime: mtime(&source),
    };
    let partial = fx.remote_path(&format!("/{}", partial_name("big.bin", &meta)));

    // A failure half-way keeps the partial file and reports a resumable error.
    fx.write_limit.store(3 * 1024 * 1024, Ordering::SeqCst);
    let failed = fx
        .transfer(fx.request("big", "s", "upload", "big.bin"))
        .await;
    assert_eq!(failed["status"], "failed", "{failed}");
    assert_eq!(failed["resumable"], true);
    let kept = std::fs::metadata(&partial).unwrap().len();
    assert!(kept > 0 && kept <= 3 * 1024 * 1024, "{kept}");
    assert!(!fx.remote_path("/big.bin").exists());

    // Mark the kept bytes so we can prove the retry did not start from zero.
    let mut marked = std::fs::read(&partial).unwrap();
    marked.iter_mut().for_each(|b| *b = b'X');
    std::fs::write(&partial, &marked).unwrap();
    fx.write_limit.store(u64::MAX, Ordering::SeqCst);
    let resumed = fx
        .transfer(Transfer {
            resume: true,
            ..fx.request("big", "s", "upload", "big.bin")
        })
        .await;
    assert_eq!(resumed["status"], "completed", "{resumed}");
    let uploaded = std::fs::read(fx.remote_path("/big.bin")).unwrap();
    let reused = (kept - RESUME_OVERLAP) as usize;
    assert!(uploaded[..reused].iter().all(|b| *b == b'X'));
    assert_eq!(&uploaded[reused..], &payload[reused..]);
    assert!(!partial.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn folder_retry_skips_finished_files() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    let dir = fx.local.path().join("album");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("a.jpg"), vec![1u8; 1000]).unwrap();
    std::fs::write(dir.join("b.jpg"), vec![2u8; 2 * 1024 * 1024]).unwrap();
    fx.write_limit.store(1024 * 1024, Ordering::SeqCst);
    let failed = fx.transfer(fx.request("al", "s", "upload", "album")).await;
    assert_eq!(failed["status"], "failed");
    assert!(fx.remote_path("/album/a.jpg").exists());
    // Plain retry would hit the existing folder; "Tiếp tục" (resume) merges into it.
    fx.write_limit.store(u64::MAX, Ordering::SeqCst);
    let retry = fx
        .transfer(Transfer {
            resume: true,
            ..fx.request("al", "s", "upload", "album")
        })
        .await;
    assert_eq!(retry["status"], "completed", "{retry}");
    assert_eq!(retry["filesDone"], 2);
    assert_eq!(
        std::fs::read(fx.remote_path("/album/b.jpg")).unwrap(),
        vec![2u8; 2 * 1024 * 1024]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_writer_per_destination_and_cancel_while_queued() {
    let fx = Fixture::start().await;
    fx.connect("s").await;
    std::fs::write(fx.local.path().join("x.txt"), b"x").unwrap();
    // Another transfer already owns /x.txt.
    let key = format!("remote:{}:/x.txt", fx.address);
    fx.state.targets.lock().unwrap().insert(key.clone());
    let busy = fx.transfer(fx.request("x", "s", "upload", "x.txt")).await;
    assert_eq!(busy["status"], "failed");
    assert!(busy["error"].as_str().unwrap().contains("tác vụ khác"));
    fx.state.targets.lock().unwrap().remove(&key);

    // Both slots taken: the next transfer waits in the queue and can be cancelled there.
    let _a = fx.state.slots.clone().acquire_owned().await.unwrap();
    let _b = fx.state.slots.clone().acquire_owned().await.unwrap();
    crate::transfer::start(
        fx.sink.clone(),
        fx.state.clone(),
        fx.request("q", "s", "upload", "x.txt"),
    )
    .await
    .unwrap();
    fx.wait(|n, v| n == "transfer" && v["id"] == "q" && v["status"] == "queued")
        .await;
    fx.state
        .transfers
        .lock()
        .await
        .get("q")
        .unwrap()
        .notify_one();
    let result = fx.finished("q").await;
    assert_eq!(result["status"], "cancelled");
    assert!(!fx.remote_path("/x.txt").exists());
    assert!(fx.state.targets.lock().unwrap().is_empty());
}
