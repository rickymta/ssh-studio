use crate::AppState;
use russh_sftp::client::SftpSession;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
pub(crate) fn safe_name(name: &str) -> anyhow::Result<()> {
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
pub(crate) fn remote_join(directory: &str, name: &str) -> String {
    format!("{}/{}", directory.trim_end_matches('/'), name)
}
pub(crate) async fn session(
    state: &AppState,
    id: &str,
) -> anyhow::Result<Arc<crate::ssh::Session>> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Server đã ngắt kết nối"))
}
/// True when an SFTP error means the channel itself is gone (not a server status reply).
fn channel_lost(error: &anyhow::Error) -> bool {
    use russh_sftp::client::error::Error as SftpError;
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<SftpError>(),
            Some(
                SftpError::IO(_)
                    | SftpError::Timeout
                    | SftpError::UnexpectedPacket
                    | SftpError::UnexpectedBehavior(_)
            )
        )
    })
}
/// Runs an SFTP operation; if the cached channel died, reopens it once and retries.
pub async fn remote<T, F, Fut>(state: &AppState, id: &str, op: F) -> anyhow::Result<T>
where
    F: Fn(Arc<SftpSession>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let session = session(state, id).await?;
    let sftp = session.files().await?;
    match op(sftp.clone()).await {
        Err(error) if channel_lost(&error) => {
            session.reset_files(&sftp).await;
            op(session.files().await?).await
        }
        other => other,
    }
}
fn entry_json(
    name: &str,
    metadata: &russh_sftp::protocol::FileAttributes,
    target_dir: bool,
) -> Value {
    json!({"name":name,"directory":metadata.is_dir(),"link":metadata.is_symlink(),"targetDirectory":target_dir,"size":metadata.size.unwrap_or(0),"modified":metadata.mtime.unwrap_or(0) as u64 * 1000,"mode":metadata.permissions.unwrap_or(0)})
}
pub async fn list(
    state: &AppState,
    session_id: Option<String>,
    directory: String,
) -> anyhow::Result<Value> {
    let mut entries = vec![];
    let (path, parent) = if let Some(id) = session_id {
        let directory = if directory.is_empty() {
            ".".to_string()
        } else {
            directory
        };
        let (path, listed) = remote(state, &id, |remote| {
            let directory = directory.clone();
            async move {
                let path = remote.canonicalize(directory).await?;
                let mut listed = vec![];
                for entry in remote.read_dir(&path).await? {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let metadata = entry.metadata();
                    // Symlinks: follow the link to know whether it can be opened as a folder.
                    let target_dir = metadata.is_symlink()
                        && remote
                            .metadata(remote_join(&path, &name))
                            .await
                            .map(|m| m.is_dir())
                            .unwrap_or(false);
                    listed.push(entry_json(&name, &metadata, target_dir));
                }
                Ok((path, listed))
            }
        })
        .await?;
        entries = listed;
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
                let target_dir = meta.is_symlink() && entry.path().is_dir();
                entries.push(json!({"name":entry.file_name().to_string_lossy(),"directory":meta.is_dir(),"link":meta.is_symlink(),"targetDirectory":target_dir,"size":meta.len(),"modified":meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_millis()).unwrap_or(0),"mode":0}));
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
        if let Some(new_name) = &new_name {
            safe_name(new_name)?;
        }
        let target = remote_join(&directory, &name);
        remote(state, &id, |remote| {
            let (target, action, directory, new_name) = (
                target.clone(),
                action.clone(),
                directory.clone(),
                new_name.clone(),
            );
            async move {
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
                        let dest = remote_join(&directory, &new_name);
                        anyhow::ensure!(!remote.try_exists(&dest).await?, "Tên đích đã tồn tại");
                        remote.rename(target, dest).await?;
                    }
                    _ => anyhow::bail!("Thao tác không hợp lệ"),
                }
                Ok(())
            }
        })
        .await?;
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
/// Publishes a finished temporary file as `dest` without ever replacing an existing file.
pub(crate) fn publish_no_clobber(temp: &Path, dest: &Path) -> std::io::Result<()> {
    publish_with(temp, dest, |from, to| std::fs::hard_link(from, to))
}
fn publish_with(
    temp: &Path,
    dest: &Path,
    link: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    // hard_link is an atomic no-clobber publication on the same local filesystem.
    match link(temp, dest) {
        Ok(()) => std::fs::remove_file(temp),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
        // FAT/exFAT, USB drives and many network shares have no hard links: fall back to a
        // checked rename (tiny race window, but never a silent overwrite of an existing file).
        Err(_) => {
            if std::fs::symlink_metadata(dest).is_ok() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "File đích đã tồn tại.",
                ));
            }
            std::fs::rename(temp, dest)
        }
    }
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
    #[test]
    fn publish_falls_back_when_hard_links_are_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let no_links = |_: &Path, _: &Path| -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "FAT has no hard links",
            ))
        };
        let temp = dir.path().join(".a.part");
        let dest = dir.path().join("a.txt");
        std::fs::write(&temp, b"new").unwrap();
        publish_with(&temp, &dest, no_links).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(!temp.exists());
        // Never replaces an existing file, with or without hard links.
        std::fs::write(&temp, b"newer").unwrap();
        assert!(publish_with(&temp, &dest, no_links).is_err());
        assert!(publish_no_clobber(&temp, &dest).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        let other = dir.path().join("b.txt");
        publish_no_clobber(&temp, &other).unwrap();
        assert_eq!(std::fs::read(&other).unwrap(), b"newer");
    }
}
