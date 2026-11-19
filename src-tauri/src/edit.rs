//! F2: editing remote text files, recursive delete and chmod.
//!
//! Saving never silently replaces a file that changed on the server since it was opened:
//! the size and mtime seen when reading are sent back, and a mismatch is reported as a
//! conflict that the user resolves (overwrite or reload). Content is written to a temporary
//! file next to the target and swapped in like an F1 overwrite, keeping the permissions.
use crate::{
    AppState,
    files::{remote, remote_join, safe_name},
    transfer::{not_found, replace_remote},
};
use russh_sftp::{client::SftpSession, protocol::FileAttributes};
use serde_json::{Value, json};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Largest file opened in the editor.
pub const MAX_TEXT: u64 = 5 * 1024 * 1024;
/// Largest tree deleted in one go.
const MAX_ITEMS: usize = 200_000;

fn split_remote(path: &str) -> anyhow::Result<(String, String)> {
    let (directory, name) = path
        .rsplit_once('/')
        .ok_or_else(|| anyhow::anyhow!("Đường dẫn remote phải là đường dẫn đầy đủ."))?;
    safe_name(name)?;
    Ok((
        if directory.is_empty() { "/" } else { directory }.to_string(),
        name.to_string(),
    ))
}

/// Text accepted by the editor: valid UTF-8 without NUL bytes.
pub fn decode_text(bytes: Vec<u8>) -> anyhow::Result<String> {
    anyhow::ensure!(
        !bytes.contains(&0),
        "File nhị phân, không mở được bằng trình sửa văn bản."
    );
    String::from_utf8(bytes).map_err(|_| {
        anyhow::anyhow!("File không phải UTF-8, không mở được bằng trình sửa văn bản.")
    })
}

fn version(attrs: &FileAttributes) -> Value {
    json!({"size": attrs.size.unwrap_or(0), "mtime": attrs.mtime.unwrap_or(0)})
}

pub async fn read_text(state: &AppState, session_id: &str, path: String) -> anyhow::Result<Value> {
    split_remote(&path)?;
    remote(state, session_id, |sftp| {
        let path = path.clone();
        async move {
            let attrs = sftp.metadata(&path).await?;
            anyhow::ensure!(!attrs.is_dir(), "Đây là thư mục, không phải file.");
            anyhow::ensure!(
                attrs.size.unwrap_or(0) <= MAX_TEXT,
                "File quá lớn để sửa trực tiếp (giới hạn 5 MB). Hãy tải về để sửa."
            );
            let mut bytes = vec![];
            sftp.open(&path)
                .await?
                .take(MAX_TEXT + 1)
                .read_to_end(&mut bytes)
                .await?;
            anyhow::ensure!(
                bytes.len() as u64 <= MAX_TEXT,
                "File quá lớn để sửa trực tiếp (giới hạn 5 MB)."
            );
            let content = decode_text(bytes)?;
            Ok(json!({
                "path": path,
                "content": content,
                "size": attrs.size.unwrap_or(0),
                "mtime": attrs.mtime.unwrap_or(0),
                "permissions": attrs.permissions,
            }))
        }
    })
    .await
}

/// Saves `content` to `path`. `expected` is the `(size, mtime)` read when the file was
/// opened (`None` for a new file). Returns `{conflict: true, exists, size, mtime}` instead of
/// writing when the server copy changed, unless `force`.
pub async fn write_text(
    state: &AppState,
    session_id: &str,
    path: String,
    content: String,
    expected: Option<(u64, u64)>,
    force: bool,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        content.len() as u64 <= MAX_TEXT,
        "Nội dung quá lớn (giới hạn 5 MB)."
    );
    let (directory, name) = split_remote(&path)?;
    remote(state, session_id, |sftp| {
        let (path, directory, name, content) = (
            path.clone(),
            directory.clone(),
            name.clone(),
            content.clone(),
        );
        async move {
            let current = match sftp.metadata(&path).await {
                Ok(attrs) => Some(attrs),
                Err(e) if not_found(&e) => None,
                Err(e) => return Err(e.into()),
            };
            if let Some(attrs) = &current {
                anyhow::ensure!(!attrs.is_dir(), "Đường dẫn là thư mục.");
            }
            let changed = match (&current, expected) {
                (Some(attrs), Some((size, mtime))) => {
                    attrs.size.unwrap_or(0) != size || attrs.mtime.unwrap_or(0) as u64 != mtime
                }
                (None, None) => false,
                // Deleted, or created by someone else, since the editor opened it.
                _ => true,
            };
            if changed && !force {
                let mut reply = current.as_ref().map(version).unwrap_or(json!({}));
                reply["conflict"] = json!(true);
                reply["exists"] = json!(current.is_some());
                return Ok(reply);
            }
            let temp = remote_join(
                &directory,
                &format!(
                    ".{name}.sshstudio-edit-{}.part",
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                ),
            );
            let written = save(&sftp, &temp, &path, content.as_bytes(), &current).await;
            if let Err(e) = written {
                let _ = sftp.remove_file(&temp).await;
                return Err(e);
            }
            let mut reply = version(&sftp.metadata(&path).await?);
            reply["conflict"] = json!(false);
            Ok(reply)
        }
    })
    .await
}

async fn save(
    sftp: &SftpSession,
    temp: &str,
    path: &str,
    bytes: &[u8],
    current: &Option<FileAttributes>,
) -> anyhow::Result<()> {
    let mut file = sftp.create(temp).await?;
    file.write_all(bytes).await?;
    file.shutdown().await?;
    if let Some(permissions) = current.as_ref().and_then(|a| a.permissions) {
        let attrs = FileAttributes {
            permissions: Some(permissions & 0o7777),
            ..FileAttributes::empty()
        };
        let _ = sftp.set_metadata(temp, attrs).await;
    }
    replace_remote(sftp, temp, path).await
}

/// Everything under `root` without following symlinks: (files and links, folders with
/// parents before children).
async fn remote_tree(sftp: &SftpSession, root: &str) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let attrs = sftp.symlink_metadata(root).await?;
    if attrs.is_symlink() || !attrs.is_dir() {
        return Ok((vec![root.to_string()], vec![]));
    }
    let (mut files, mut folders) = (vec![], vec![root.to_string()]);
    let mut next = 0;
    while next < folders.len() {
        let folder = folders[next].clone();
        next += 1;
        for entry in sftp.read_dir(&folder).await? {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let path = remote_join(&folder, &name);
            if meta.is_dir() && !meta.is_symlink() {
                folders.push(path);
            } else {
                files.push(path);
            }
            anyhow::ensure!(
                files.len() + folders.len() <= MAX_ITEMS,
                "Thư mục có quá nhiều mục (> {MAX_ITEMS})."
            );
        }
    }
    Ok((files, folders))
}

fn local_tree(root: &Path) -> anyhow::Result<(Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    let meta = std::fs::symlink_metadata(root)?;
    if !meta.is_dir() {
        return Ok((vec![root.to_path_buf()], vec![]));
    }
    let (mut files, mut folders) = (vec![], vec![root.to_path_buf()]);
    let mut next = 0;
    while next < folders.len() {
        let folder = folders[next].clone();
        next += 1;
        for entry in std::fs::read_dir(&folder)? {
            let entry = entry?;
            // file_type() does not follow symlinks (or junctions on Windows).
            if entry.file_type()?.is_dir() {
                folders.push(entry.path());
            } else {
                files.push(entry.path());
            }
            anyhow::ensure!(
                files.len() + folders.len() <= MAX_ITEMS,
                "Thư mục có quá nhiều mục (> {MAX_ITEMS})."
            );
        }
    }
    Ok((files, folders))
}

fn remove_local_link_or_file(path: &Path) -> std::io::Result<()> {
    std::fs::remove_file(path).or_else(|error| {
        // Directory symlinks and junctions on Windows are removed with RemoveDirectory.
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            std::fs::remove_dir(path)
        } else {
            Err(error)
        }
    })
}

/// Counts (`delete == false`) or deletes the named entries of `directory`, recursively.
/// Symlinks are removed, never followed. Returns `{files, folders}`.
pub async fn delete_entries(
    state: &AppState,
    session_id: Option<String>,
    directory: String,
    names: Vec<String>,
    delete: bool,
) -> anyhow::Result<Value> {
    anyhow::ensure!(!names.is_empty(), "Chưa chọn mục nào.");
    for name in &names {
        safe_name(name)?;
    }
    let (files, folders) = if let Some(id) = session_id {
        remote(state, &id, |sftp| {
            let (directory, names) = (directory.clone(), names.clone());
            async move {
                let (mut files, mut folders) = (0, 0);
                for name in names {
                    let (f, d) = remote_tree(&sftp, &remote_join(&directory, &name)).await?;
                    files += f.len();
                    folders += d.len();
                    if delete {
                        for file in f {
                            sftp.remove_file(&file).await?;
                        }
                        for folder in d.iter().rev() {
                            sftp.remove_dir(folder).await?;
                        }
                    }
                }
                Ok((files, folders))
            }
        })
        .await?
    } else {
        tokio::task::spawn_blocking(move || -> anyhow::Result<(usize, usize)> {
            let (mut files, mut folders) = (0, 0);
            for name in names {
                let (f, d) = local_tree(&Path::new(&directory).join(&name))?;
                files += f.len();
                folders += d.len();
                if delete {
                    for file in f {
                        remove_local_link_or_file(&file)?;
                    }
                    for folder in d.iter().rev() {
                        std::fs::remove_dir(folder)?;
                    }
                }
            }
            Ok((files, folders))
        })
        .await??
    };
    Ok(json!({"files": files, "folders": folders}))
}

/// Sets POSIX permission bits on a remote entry.
pub async fn chmod(
    state: &AppState,
    session_id: &str,
    directory: String,
    name: String,
    mode: u32,
) -> anyhow::Result<()> {
    safe_name(&name)?;
    anyhow::ensure!(mode <= 0o7777, "Quyền không hợp lệ.");
    let path = remote_join(&directory, &name);
    remote(state, session_id, |sftp| {
        let path = path.clone();
        async move {
            let attrs = FileAttributes {
                permissions: Some(mode),
                ..FileAttributes::empty()
            };
            sftp.set_metadata(&path, attrs).await?;
            Ok(())
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editor_accepts_only_utf8_text() {
        assert_eq!(decode_text("xin chào\r\n".into()).unwrap(), "xin chào\r\n");
        assert!(decode_text(vec![0x41, 0, 0x42]).is_err());
        assert!(decode_text(vec![0xff, 0xfe, 0x41]).is_err());
    }
    #[test]
    fn local_tree_does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("a/b")).unwrap();
        std::fs::write(tree.join("a/b/c.txt"), b"c").unwrap();
        std::fs::write(tree.join("root.txt"), b"r").unwrap();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, tree.join("link")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, tree.join("link")).is_ok();
        let (files, folders) = local_tree(&tree).unwrap();
        assert_eq!(folders.len(), 3);
        assert_eq!(files.len(), 2 + linked as usize);
        for file in files {
            remove_local_link_or_file(&file).unwrap();
        }
        for folder in folders.iter().rev() {
            std::fs::remove_dir(folder).unwrap();
        }
        assert!(!tree.exists());
        assert!(outside.join("keep.txt").exists());
    }
}
