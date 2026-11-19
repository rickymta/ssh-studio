//! File and folder transfers between the local disk and an SFTP session (F1).
//!
//! Every file is written to a deterministic partial file next to its destination,
//! `.<name>.<size>-<mtime>.sshstudio.part`, and only published once complete. A failed or
//! interrupted transfer keeps its partial so a retry resumes from its length; a cancelled one
//! deletes it. Destinations are never replaced unless the request's conflict policy says so.
use crate::{
    AppState,
    files::{publish_no_clobber, remote_join, safe_name},
};
use russh_sftp::{
    client::{SftpSession, error::Error as SftpError},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io::SeekFrom,
    path::Path,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Notify,
};

/// What to do when the destination name already exists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Conflict {
    #[default]
    Fail,
    Overwrite,
    Skip,
    Rename,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub local_directory: String,
    pub remote_directory: String,
    pub name: String,
    #[serde(default)]
    pub conflict: Conflict,
    /// Destination name, when it differs from the source name (set by "Giữ cả hai" retries).
    #[serde(default)]
    pub target_name: Option<String>,
    /// Retry of an earlier attempt: merge into folders it created and skip finished files.
    #[serde(default)]
    pub resume: bool,
}

const CANCELLED: &str = "Đã hủy";
const MAX_ITEMS: usize = 200_000;
/// Bytes re-sent before the end of a partial file when resuming.
pub const RESUME_OVERLAP: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct Meta {
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub mtime: u64,
}

/// One side of a transfer: the local disk or a remote SFTP session.
#[derive(Clone)]
pub enum Fs {
    Local,
    Remote(Arc<SftpSession>),
}

fn not_found(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
}
fn local_meta(meta: &std::fs::Metadata) -> Meta {
    Meta {
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
    }
}
fn remote_meta(attrs: &FileAttributes) -> Meta {
    Meta {
        is_dir: attrs.is_dir(),
        size: if attrs.is_dir() {
            0
        } else {
            attrs.size.unwrap_or(0)
        },
        mtime: attrs.mtime.unwrap_or(0) as u64,
    }
}

#[allow(clippy::large_enum_variant)] // one short-lived writer per file
pub enum Writer {
    Local(tokio::fs::File),
    Remote(russh_sftp::client::fs::File),
}
impl Writer {
    async fn write_all(&mut self, data: &[u8]) -> anyhow::Result<()> {
        match self {
            Writer::Local(file) => file.write_all(data).await?,
            Writer::Remote(file) => file.write_all(data).await?,
        }
        Ok(())
    }
    async fn finish(self) -> anyhow::Result<()> {
        match self {
            Writer::Local(mut file) => {
                file.flush().await?;
                file.sync_all().await?;
            }
            Writer::Remote(mut file) => file.shutdown().await?,
        }
        Ok(())
    }
}

impl Fs {
    pub fn is_remote(&self) -> bool {
        matches!(self, Fs::Remote(_))
    }
    pub fn join(&self, directory: &str, name: &str) -> String {
        match self {
            Fs::Local => Path::new(directory)
                .join(name)
                .to_string_lossy()
                .to_string(),
            Fs::Remote(_) => remote_join(directory, name),
        }
    }
    /// Follows symlinks. `None` when nothing exists at `path`.
    pub async fn stat(&self, path: &str) -> anyhow::Result<Option<Meta>> {
        match self {
            Fs::Local => match tokio::fs::metadata(path).await {
                Ok(meta) => Ok(Some(local_meta(&meta))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
            Fs::Remote(sftp) => match sftp.metadata(path).await {
                Ok(attrs) => Ok(Some(remote_meta(&attrs))),
                Err(e) if not_found(&e) => Ok(None),
                Err(e) => Err(e.into()),
            },
        }
    }
    /// Directory entries as `(name, metadata following links, is_symlink)`.
    pub async fn list(&self, directory: &str) -> anyhow::Result<Vec<(String, Meta, bool)>> {
        let mut out = vec![];
        match self {
            Fs::Local => {
                let mut reader = tokio::fs::read_dir(directory).await?;
                while let Some(entry) = reader.next_entry().await? {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let lmeta = tokio::fs::symlink_metadata(entry.path()).await?;
                    let link = lmeta.is_symlink();
                    let meta = if link {
                        match tokio::fs::metadata(entry.path()).await {
                            Ok(meta) => meta,
                            Err(_) => continue, // broken link
                        }
                    } else {
                        lmeta
                    };
                    out.push((name, local_meta(&meta), link));
                }
            }
            Fs::Remote(sftp) => {
                for entry in sftp.read_dir(directory).await? {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let attrs = entry.metadata();
                    let link = attrs.is_symlink();
                    let meta = if link {
                        match sftp.metadata(remote_join(directory, &name)).await {
                            Ok(attrs) => remote_meta(&attrs),
                            Err(_) => continue,
                        }
                    } else {
                        remote_meta(&attrs)
                    };
                    out.push((name, meta, link));
                }
            }
        }
        Ok(out)
    }
    pub async fn mkdir(&self, path: &str) -> anyhow::Result<()> {
        match self {
            Fs::Local => tokio::fs::create_dir(path).await?,
            Fs::Remote(sftp) => sftp.create_dir(path).await?,
        }
        Ok(())
    }
    pub async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        match self {
            Fs::Local => tokio::fs::remove_file(path).await?,
            Fs::Remote(sftp) => sftp.remove_file(path).await?,
        }
        Ok(())
    }
    pub async fn reader(
        &self,
        path: &str,
        offset: u64,
    ) -> anyhow::Result<Box<dyn AsyncRead + Send + Unpin>> {
        Ok(match self {
            Fs::Local => {
                let mut file = tokio::fs::File::open(path).await?;
                file.seek(SeekFrom::Start(offset)).await?;
                Box::new(file)
            }
            Fs::Remote(sftp) => {
                let mut file = sftp.open(path).await?;
                file.seek(SeekFrom::Start(offset)).await?;
                Box::new(file)
            }
        })
    }
    /// Opens (creating if needed) a partial file positioned at `offset`.
    pub async fn writer(&self, path: &str, offset: u64) -> anyhow::Result<Writer> {
        Ok(match self {
            Fs::Local => {
                let mut file = tokio::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(path)
                    .await?;
                file.set_len(offset).await?;
                file.seek(SeekFrom::Start(offset)).await?;
                Writer::Local(file)
            }
            Fs::Remote(sftp) => {
                let mut file = sftp
                    .open_with_flags(path, OpenFlags::WRITE | OpenFlags::CREATE)
                    .await?;
                file.seek(SeekFrom::Start(offset)).await?;
                Writer::Remote(file)
            }
        })
    }
    /// Publishes a complete temporary file. Without `overwrite` an existing destination is an
    /// error; with it the destination is replaced (remote: swap with rollback).
    pub async fn publish(&self, temp: &str, dest: &str, overwrite: bool) -> anyhow::Result<()> {
        match self {
            Fs::Local => {
                let (temp, dest) = (temp.to_string(), dest.to_string());
                tokio::task::spawn_blocking(move || {
                    if overwrite {
                        // MoveFileEx(REPLACE_EXISTING) on Windows, rename(2) elsewhere: atomic.
                        std::fs::rename(&temp, &dest)
                    } else {
                        publish_no_clobber(Path::new(&temp), Path::new(&dest))
                    }
                })
                .await??;
            }
            Fs::Remote(sftp) => {
                if overwrite {
                    replace_remote(sftp, temp, dest).await?;
                } else {
                    // SFTP v3 rename never replaces an existing file.
                    sftp.rename(temp, dest).await.map_err(|e| {
                        anyhow::anyhow!("Không publish được file (đích đã tồn tại?): {e}")
                    })?;
                }
            }
        }
        Ok(())
    }
    pub async fn permissions(&self, path: &str) -> Option<u32> {
        match self {
            Fs::Local => None,
            Fs::Remote(sftp) => sftp.metadata(path).await.ok()?.permissions,
        }
    }
    pub async fn set_permissions(&self, path: &str, permissions: u32) {
        if let Fs::Remote(sftp) = self {
            let attrs = FileAttributes {
                permissions: Some(permissions & 0o7777),
                ..FileAttributes::empty()
            };
            let _ = sftp.set_metadata(path, attrs).await;
        }
    }
    /// Best effort: some servers and file systems refuse to change timestamps.
    pub async fn set_mtime(&self, path: &str, mtime: u64) {
        match self {
            Fs::Local => {
                let path = path.to_string();
                let _ = tokio::task::spawn_blocking(move || {
                    std::fs::OpenOptions::new()
                        .write(true)
                        .open(path)?
                        .set_modified(UNIX_EPOCH + Duration::from_secs(mtime))
                })
                .await;
            }
            Fs::Remote(sftp) => {
                let attrs = FileAttributes {
                    atime: Some(mtime as u32),
                    mtime: Some(mtime as u32),
                    ..FileAttributes::empty()
                };
                let _ = sftp.set_metadata(path, attrs).await;
            }
        }
    }
}

/// SFTP v3 cannot rename over an existing file, so swap: target → old, temp → target,
/// then delete old. If the second step fails the original is moved back.
pub async fn replace_remote(sftp: &SftpSession, temp: &str, target: &str) -> anyhow::Result<()> {
    let (directory, name) = target.rsplit_once('/').unwrap_or(("", target));
    let old = format!(
        "{directory}/.{name}.sshstudio-old-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    match sftp.rename(target, &old).await {
        Ok(()) => {}
        Err(e) if not_found(&e) => {
            sftp.rename(temp, target).await?;
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    }
    if let Err(e) = sftp.rename(temp, target).await {
        let _ = sftp.rename(&old, target).await;
        return Err(e.into());
    }
    let _ = sftp.remove_file(&old).await;
    Ok(())
}

/// Partial file name derived from the source version, so a retry finds it again and a changed
/// source never resumes onto stale bytes.
pub fn partial_name(name: &str, meta: &Meta) -> String {
    format!(".{name}.{}-{}.sshstudio.part", meta.size, meta.mtime)
}

/// `report.txt` → `report (1).txt`, `photos` → `photos (1)` (first free name).
pub async fn unique_name(
    fs: &Fs,
    directory: &str,
    name: &str,
    is_dir: bool,
) -> anyhow::Result<String> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if fs.stat(&fs.join(directory, &candidate)).await?.is_none() {
            return Ok(candidate);
        }
    }
    anyhow::bail!("Không tìm được tên trống cho “{name}”")
}

/// One file or folder of a (possibly recursive) transfer; `rel` is `/`-separated.
#[derive(Clone, Debug)]
pub struct Item {
    pub rel: String,
    pub meta: Meta,
}

/// Lists a folder tree, parents before children. Symlinked folders are not followed
/// (loops); symlinks to files are transferred as files.
pub async fn walk(fs: &Fs, root: &str) -> anyhow::Result<(Vec<Item>, usize)> {
    let mut items = vec![];
    let mut skipped = 0;
    let mut stack = vec![(root.to_string(), String::new())];
    while let Some((path, rel)) = stack.pop() {
        let mut entries = fs.list(&path).await?;
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, meta, link) in entries {
            if link && meta.is_dir {
                skipped += 1;
                continue;
            }
            safe_name(&name)
                .map_err(|_| anyhow::anyhow!("Tên không hợp lệ trên máy đích: “{name}”"))?;
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if meta.is_dir {
                stack.push((fs.join(&path, &name), child_rel.clone()));
            }
            items.push(Item {
                rel: child_rel,
                meta,
            });
            anyhow::ensure!(
                items.len() <= MAX_ITEMS,
                "Thư mục có quá nhiều mục (> {MAX_ITEMS})."
            );
        }
    }
    Ok((items, skipped))
}

pub fn join_rel(fs: &Fs, base: &str, rel: &str) -> String {
    rel.split('/')
        .filter(|p| !p.is_empty())
        .fold(base.to_string(), |path, part| fs.join(&path, part))
}

/// Shared progress of one transfer request.
struct Progress {
    app: crate::Events,
    req: Transfer,
    target_name: String,
    total: u64,
    done: u64,
    files: usize,
    files_done: usize,
    current: String,
    last: Instant,
    /// Partial file being written right now (deleted if the user cancels).
    partial: Arc<StdMutex<Option<(Fs, String)>>>,
}
impl Progress {
    fn emit(&mut self, status: &str, force: bool) {
        if force || self.last.elapsed() > Duration::from_millis(100) {
            event(
                &self.app,
                &self.req,
                status,
                json!({
                    "bytes": self.done,
                    "total": self.total,
                    "files": self.files,
                    "filesDone": self.files_done,
                    "current": self.current,
                    "targetName": self.target_name,
                }),
            );
            self.last = Instant::now();
        }
    }
}

fn event(app: &crate::Events, req: &Transfer, status: &str, extra: serde_json::Value) {
    let mut value = json!({
        "id": req.id,
        "sessionId": req.session_id,
        "name": req.name,
        "direction": req.direction,
        "localDirectory": req.local_directory,
        "remoteDirectory": req.remote_directory,
        "conflict": req.conflict,
        "status": status,
        "bytes": 0,
        "total": 0,
    });
    if let (Some(value), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            value.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit("transfer", value);
}

/// Removes the destination from the active set when the transfer ends (or is dropped).
struct TargetLock<'a> {
    state: &'a AppState,
    key: String,
}
impl<'a> TargetLock<'a> {
    fn acquire(state: &'a AppState, key: String) -> anyhow::Result<Self> {
        let mut targets = state.targets.lock().unwrap();
        anyhow::ensure!(
            targets.insert(key.clone()),
            "Đang có tác vụ khác ghi vào cùng đích này. Chờ tác vụ đó xong rồi thử lại."
        );
        Ok(Self { state, key })
    }
}
impl Drop for TargetLock<'_> {
    fn drop(&mut self) {
        self.state.targets.lock().unwrap().remove(&self.key);
    }
}

pub async fn start(
    app: crate::Events,
    state: Arc<AppState>,
    request: Transfer,
) -> anyhow::Result<()> {
    safe_name(&request.name)?;
    safe_name(&request.id)?;
    if let Some(target) = &request.target_name {
        safe_name(target)?;
    }
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
    event(&app, &request, "queued", json!({}));
    tokio::spawn(async move {
        let partial: Arc<StdMutex<Option<(Fs, String)>>> = Default::default();
        let result = tokio::select! {
            _ = cancel.notified() => Err(anyhow::anyhow!(CANCELLED)),
            result = async {
                let _permit = state.slots.acquire().await?;
                execute(&app, &state, &request, partial.clone()).await
            } => result
        };
        let cancelled = matches!(&result, Err(e) if e.to_string() == CANCELLED);
        let in_progress = partial.lock().unwrap().take();
        if cancelled {
            // Only a user cancel discards the partial; errors keep it for "Tiếp tục".
            if let Some((fs, path)) = in_progress {
                let _ = fs.remove_file(&path).await;
            }
        }
        match result {
            Ok(Some(done)) => event(&app, &request, "completed", done),
            Ok(None) => event(&app, &request, "skipped", json!({})),
            Err(e) => event(
                &app,
                &request,
                if cancelled { "cancelled" } else { "failed" },
                json!({"error": e.to_string(), "resumable": !cancelled}),
            ),
        }
        state.transfers.lock().await.remove(&request.id);
    });
    Ok(())
}

/// Runs a transfer. `Ok(None)` means skipped because of the conflict policy.
async fn execute(
    app: &crate::Events,
    state: &AppState,
    req: &Transfer,
    partial: Arc<StdMutex<Option<(Fs, String)>>>,
) -> anyhow::Result<Option<serde_json::Value>> {
    let session = crate::files::session(state, &req.session_id).await?;
    let remote = Fs::Remote(session.files().await?);
    let (source, source_dir, dest, dest_dir) = if req.direction == "upload" {
        (
            Fs::Local,
            &req.local_directory,
            remote,
            &req.remote_directory,
        )
    } else {
        (
            remote,
            &req.remote_directory,
            Fs::Local,
            &req.local_directory,
        )
    };
    let source_path = source.join(source_dir, &req.name);
    let root = source
        .stat(&source_path)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Không tìm thấy “{}” ở nguồn.", req.name))?;

    // Top-level conflict policy.
    let mut target_name = req.target_name.clone().unwrap_or_else(|| req.name.clone());
    let existing = dest.stat(&dest.join(dest_dir, &target_name)).await?;
    let mut overwrite = false;
    if let Some(existing) = existing {
        let identical = !root.is_dir
            && !existing.is_dir
            && existing.size == root.size
            && existing.mtime == root.mtime;
        if req.resume && (root.is_dir && existing.is_dir || identical) {
            overwrite = root.is_dir; // merge into the folder this transfer created
        } else {
            match req.conflict {
                Conflict::Fail => anyhow::bail!(
                    "“{target_name}” đã tồn tại ở đích. Chọn ghi đè, giữ cả hai hoặc bỏ qua."
                ),
                Conflict::Skip => return Ok(None),
                Conflict::Rename => {
                    target_name = unique_name(&dest, dest_dir, &target_name, root.is_dir).await?
                }
                Conflict::Overwrite => {
                    anyhow::ensure!(
                        existing.is_dir == root.is_dir,
                        "Không thể ghi đè {} bằng {}.",
                        if existing.is_dir {
                            "thư mục"
                        } else {
                            "file"
                        },
                        if root.is_dir { "thư mục" } else { "file" }
                    );
                    overwrite = true;
                }
            }
        }
    }
    let dest_path = dest.join(dest_dir, &target_name);
    let lock_key = if dest.is_remote() {
        format!("remote:{}:{}", session.address, dest_path)
    } else {
        format!("local:{}", dest_path.to_lowercase())
    };
    let _lock = TargetLock::acquire(state, lock_key)?;

    let (items, _skipped_links) = if root.is_dir {
        walk(&source, &source_path).await?
    } else {
        (vec![], 0)
    };
    let mut progress = Progress {
        app: app.clone(),
        req: req.clone(),
        target_name: target_name.clone(),
        total: if root.is_dir {
            items.iter().map(|i| i.meta.size).sum()
        } else {
            root.size
        },
        done: 0,
        files: if root.is_dir {
            items.iter().filter(|i| !i.meta.is_dir).count()
        } else {
            1
        },
        files_done: 0,
        current: String::new(),
        last: Instant::now(),
        partial,
    };
    progress.emit("running", true);

    if !root.is_dir {
        progress.current = req.name.clone();
        copy_file(
            &source,
            &source_path,
            &root,
            &dest,
            dest_dir,
            &target_name,
            overwrite,
            req.resume,
            &mut progress,
        )
        .await?;
    } else {
        if dest.stat(&dest_path).await?.is_none() {
            dest.mkdir(&dest_path).await?;
        }
        for item in &items {
            let from = join_rel(&source, &source_path, &item.rel);
            if item.meta.is_dir {
                let to = join_rel(&dest, &dest_path, &item.rel);
                match dest.stat(&to).await? {
                    None => dest.mkdir(&to).await?,
                    Some(meta) if meta.is_dir => {}
                    Some(_) => anyhow::bail!("“{}” ở đích là file, không phải thư mục.", item.rel),
                }
                continue;
            }
            let (parent_rel, name) = item.rel.rsplit_once('/').unwrap_or(("", &item.rel));
            let parent = join_rel(&dest, &dest_path, parent_rel);
            progress.current = item.rel.clone();
            copy_file(
                &source,
                &from,
                &item.meta,
                &dest,
                &parent,
                name,
                overwrite,
                req.resume || overwrite,
                &mut progress,
            )
            .await?;
        }
    }
    progress.current.clear();
    progress.done = progress.total;
    Ok(Some(json!({
        "bytes": progress.total,
        "total": progress.total,
        "files": progress.files,
        "filesDone": progress.files_done,
        "targetName": target_name,
    })))
}

/// Copies one file through its partial file, resuming when a matching partial exists.
#[allow(clippy::too_many_arguments)]
async fn copy_file(
    source: &Fs,
    from: &str,
    meta: &Meta,
    dest: &Fs,
    dest_dir: &str,
    name: &str,
    overwrite: bool,
    skip_identical: bool,
    progress: &mut Progress,
) -> anyhow::Result<()> {
    let target = dest.join(dest_dir, name);
    if let Some(existing) = dest.stat(&target).await? {
        anyhow::ensure!(!existing.is_dir, "“{name}” ở đích là thư mục.");
        if skip_identical && existing.size == meta.size && existing.mtime == meta.mtime {
            progress.done += meta.size;
            progress.files_done += 1;
            progress.emit("running", false);
            return Ok(());
        }
        anyhow::ensure!(
            overwrite,
            "File đích “{name}” đã tồn tại. Đổi tên hoặc xóa file đích trước khi truyền."
        );
    }
    let temp = dest.join(dest_dir, &partial_name(name, meta));
    let mut offset = match dest.stat(&temp).await? {
        // Pipelined SFTP writes may leave a hole just before the end of an interrupted
        // partial, so rewrite the last stretch instead of trusting every byte.
        Some(p) if !p.is_dir => p.size.saturating_sub(RESUME_OVERLAP),
        _ => 0,
    };
    if offset > meta.size {
        dest.remove_file(&temp).await?;
        offset = 0;
    }
    *progress.partial.lock().unwrap() = Some((dest.clone(), temp.clone()));
    let mut input = source.reader(from, offset).await?;
    let mut output = dest.writer(&temp, offset).await?;
    progress.done += offset;
    let mut buffer = vec![0; 128 * 1024];
    loop {
        let n = input.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        output.write_all(&buffer[..n]).await?;
        progress.done += n as u64;
        progress.emit("running", false);
    }
    output.finish().await?;
    drop(input);
    let written = dest.stat(&temp).await?.map(|m| m.size).unwrap_or(0);
    anyhow::ensure!(
        written == meta.size,
        "Kích thước file “{name}” không khớp sau khi truyền ({written}/{}). Nguồn có thể đã thay đổi.",
        meta.size
    );
    let permissions = if overwrite {
        dest.permissions(&target).await
    } else {
        None
    };
    dest.publish(&temp, &target, overwrite).await?;
    *progress.partial.lock().unwrap() = None;
    if let Some(permissions) = permissions {
        dest.set_permissions(&target, permissions).await;
    }
    dest.set_mtime(&target, meta.mtime).await;
    progress.files_done += 1;
    progress.emit("running", false);
    Ok(())
}
