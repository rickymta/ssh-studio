use crate::AppState;
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Notify,
};
fn safe_name(name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !name.is_empty()
            && name != "."
            && name != ".."
            && !name
                .chars()
                .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control()),
        "Tên file không hợp lệ"
    );
    Ok(())
}
fn remote_join(directory: &str, name: &str) -> String {
    format!("{}/{}", directory.trim_end_matches('/'), name)
}
async fn sftp(state: &AppState, id: &str) -> anyhow::Result<Arc<SftpSession>> {
    let session = state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Server đã ngắt kết nối"))?;
    session.files().await
}
pub async fn list(
    state: &AppState,
    session_id: Option<String>,
    directory: String,
) -> anyhow::Result<Value> {
    let mut entries = vec![];
    let (path, parent) = if let Some(id) = session_id {
        let remote = sftp(state, &id).await?;
        let path = remote
            .canonicalize(if directory.is_empty() {
                "."
            } else {
                &directory
            })
            .await?;
        for entry in remote.read_dir(&path).await? {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let metadata = entry.metadata();
            entries.push(json!({"name":name,"directory":metadata.is_dir(),"link":metadata.is_symlink(),"size":metadata.size.unwrap_or(0),"modified":metadata.mtime.unwrap_or(0) as u64 * 1000,"mode":metadata.permissions.unwrap_or(0)}));
        }
        let parent = path
            .rsplit_once('/')
            .map(|(p, _)| if p.is_empty() { "/" } else { p })
            .unwrap_or("/")
            .to_string();
        (path, parent)
    } else {
        let dir = if directory.is_empty() {
            dirs::home_dir().unwrap_or_default()
        } else {
            PathBuf::from(directory)
        };
        let mut reader = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = reader.next_entry().await? {
            if let Ok(meta) = tokio::fs::symlink_metadata(entry.path()).await {
                entries.push(json!({"name":entry.file_name().to_string_lossy(),"directory":meta.is_dir(),"link":meta.is_symlink(),"size":meta.len(),"modified":meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_millis()).unwrap_or(0),"mode":0}));
            }
        }
        (
            dir.to_string_lossy().to_string(),
            dir.parent().unwrap_or(&dir).to_string_lossy().to_string(),
        )
    };
    entries.sort_by(|a, b| {
        b["directory"]
            .as_bool()
            .cmp(&a["directory"].as_bool())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(json!({"path":path,"parent":parent,"files":entries}))
}
pub async fn action(
    state: &AppState,
    session_id: Option<String>,
    directory: String,
    name: String,
    new_name: Option<String>,
    action: String,
    is_directory: bool,
) -> anyhow::Result<()> {
    safe_name(&name)?;
    if let Some(id) = session_id {
        let remote = sftp(state, &id).await?;
        let target = remote_join(&directory, &name);
        match action.as_str() {
            "mkdir" => remote.create_dir(target).await?,
            "delete" => {
                if is_directory {
                    remote.remove_dir(target).await?
                } else {
                    remote.remove_file(target).await?
                }
            }
            "rename" => {
                let new_name = new_name.ok_or_else(|| anyhow::anyhow!("Thiếu tên mới"))?;
                safe_name(&new_name)?;
                let dest = remote_join(&directory, &new_name);
                anyhow::ensure!(!remote.try_exists(&dest).await?, "Tên đích đã tồn tại");
                remote.rename(target, dest).await?;
            }
            _ => anyhow::bail!("Thao tác không hợp lệ"),
        }
    } else {
        let target = Path::new(&directory).join(&name);
        match action.as_str() {
            "mkdir" => tokio::fs::create_dir(target).await?,
            "delete" => {
                if is_directory {
                    tokio::fs::remove_dir(target).await?
                } else {
                    tokio::fs::remove_file(target).await?
                }
            }
            "rename" => {
                let new_name = new_name.ok_or_else(|| anyhow::anyhow!("Thiếu tên mới"))?;
                safe_name(&new_name)?;
                let dest = Path::new(&directory).join(new_name);
                anyhow::ensure!(!tokio::fs::try_exists(&dest).await?, "Tên đích đã tồn tại");
                tokio::fs::rename(target, dest).await?;
            }
            _ => anyhow::bail!("Thao tác không hợp lệ"),
        }
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub local_directory: String,
    pub remote_directory: String,
    pub name: String,
}
pub async fn start(
    app: crate::Events,
    state: Arc<AppState>,
    request: Transfer,
) -> anyhow::Result<()> {
    safe_name(&request.name)?;
    safe_name(&request.id)?;
    anyhow::ensure!(
        request.direction == "upload" || request.direction == "download",
        "Hướng truyền không hợp lệ"
    );
    anyhow::ensure!(
        state
            .sessions
            .lock()
            .await
            .contains_key(&request.session_id),
        "Server đã ngắt kết nối"
    );
    let cancel = Arc::new(Notify::new());
    {
        let mut transfers = state.transfers.lock().await;
        anyhow::ensure!(
            !transfers.contains_key(&request.id),
            "Transfer ID đã tồn tại"
        );
        transfers.insert(request.id.clone(), cancel.clone());
    }
    event(&app, &request, "queued", 0, 0, None);
    tokio::spawn(async move {
        let result = tokio::select! {
            _ = cancel.notified() => Err(anyhow::anyhow!("Đã hủy")),
            result = async {
                let _permit = state.slots.acquire().await?;
                copy(&app,&state,&request).await
            } => result
        };
        // A cancelled future drops both streams. Remove only this transfer's partial file.
        let temp = format!(".{}.sshstudio-{}.part", request.name, request.id);
        if request.direction == "upload" {
            if let Ok(remote) = sftp(&state, &request.session_id).await {
                let _ = remote
                    .remove_file(remote_join(&request.remote_directory, &temp))
                    .await;
            }
        } else {
            let _ = tokio::fs::remove_file(Path::new(&request.local_directory).join(temp)).await;
        }
        match result {
            Ok(total) => event(&app, &request, "completed", total, total, None),
            Err(e) => event(
                &app,
                &request,
                if e.to_string() == "Đã hủy" {
                    "cancelled"
                } else {
                    "failed"
                },
                0,
                0,
                Some(e.to_string()),
            ),
        }
        state.transfers.lock().await.remove(&request.id);
    });
    Ok(())
}
fn event(
    app: &crate::Events,
    req: &Transfer,
    status: &str,
    bytes: u64,
    total: u64,
    error: Option<String>,
) {
    let _ = app.emit("transfer",json!({"id":req.id,"sessionId":req.session_id,"name":req.name,"direction":req.direction,"status":status,"bytes":bytes,"total":total,"error":error}));
}
async fn copy(app: &crate::Events, state: &AppState, req: &Transfer) -> anyhow::Result<u64> {
    let remote = sftp(state, &req.session_id).await?;
    let local = Path::new(&req.local_directory).join(&req.name);
    let target = remote_join(&req.remote_directory, &req.name);
    let temp_name = format!(".{}.sshstudio-{}.part", req.name, req.id);
    let mut bytes = 0;
    let mut buffer = vec![0; 64 * 1024];
    let mut last = std::time::Instant::now();
    if req.direction == "upload" {
        anyhow::ensure!(
            !remote.try_exists(&target).await?,
            "File đích đã tồn tại. Đổi tên hoặc xóa file đích trước khi truyền."
        );
        let metadata = tokio::fs::metadata(&local).await?;
        anyhow::ensure!(
            metadata.is_file(),
            "Chỉ truyền file; hãy nén thư mục trước."
        );
        let total = metadata.len();
        event(app, req, "running", 0, total, None);
        let temp = remote_join(&req.remote_directory, &temp_name);
        let mut input = tokio::fs::File::open(local).await?;
        let mut output = remote
            .open_with_flags(
                &temp,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            )
            .await?;
        loop {
            let n = input.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            output.write_all(&buffer[..n]).await?;
            bytes += n as u64;
            if last.elapsed().as_millis() > 100 {
                event(app, req, "running", bytes, total, None);
                last = std::time::Instant::now();
            }
        }
        output.shutdown().await?;
        remote.rename(temp, target).await?;
    } else {
        anyhow::ensure!(
            !tokio::fs::try_exists(&local).await?,
            "File đích đã tồn tại. Đổi tên hoặc xóa file đích trước khi truyền."
        );
        let metadata = remote.metadata(&target).await?;
        anyhow::ensure!(
            metadata.is_regular(),
            "Chỉ truyền file; hãy nén thư mục trước."
        );
        let total = metadata.size.unwrap_or(0);
        event(app, req, "running", 0, total, None);
        let temp = Path::new(&req.local_directory).join(temp_name);
        let mut input = remote.open(target).await?;
        let mut output = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await?;
        loop {
            let n = input.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            output.write_all(&buffer[..n]).await?;
            bytes += n as u64;
            if last.elapsed().as_millis() > 100 {
                event(app, req, "running", bytes, total, None);
                last = std::time::Instant::now();
            }
        }
        output.sync_all().await?;
        drop(output);
        // hard_link is an atomic no-clobber publication on the same local filesystem.
        tokio::fs::hard_link(&temp, &local).await?;
        tokio::fs::remove_file(temp).await?;
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_cannot_escape_directory() {
        for name in ["..", "a/b", "a\\b", "x:y", ""] {
            assert!(safe_name(name).is_err());
        }
        assert!(safe_name("report 2026.txt").is_ok());
        assert_eq!(remote_join("/", "test"), "/test");
    }
}
