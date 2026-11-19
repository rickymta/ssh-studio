//! SFTP v3 server handler backed by a real temporary directory.
//!
//! Virtual paths are POSIX (`/a/b`) and always normalized before they touch the disk, so the
//! handler can never escape its root. Symlinks and POSIX permission bits are kept in in-memory
//! overlays so the fixture behaves the same on Windows (no symlink privilege, no chmod).
use russh_sftp::protocol::{self as p, StatusCode};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};

/// Virtual symlinks: link path → target path (both virtual, normalized).
pub type Links = Arc<Mutex<HashMap<String, String>>>;
/// Permission overlay: virtual path → permission bits (without file type).
pub type Modes = Arc<Mutex<HashMap<String, u32>>>;

const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;

enum Open {
    File(std::fs::File),
    Dir(Option<Vec<p::File>>),
}

pub struct DiskSftp {
    root: PathBuf,
    links: Links,
    modes: Modes,
    handles: HashMap<String, Open>,
    next: u64,
}

impl DiskSftp {
    pub fn new(root: PathBuf, links: Links, modes: Modes) -> Self {
        Self {
            root,
            links,
            modes,
            handles: HashMap::new(),
            next: 0,
        }
    }
}

/// Normalizes a virtual path: relative paths start at `/`, `.`/`..` are collapsed.
pub fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = vec![];
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

fn parent(path: &str) -> String {
    match path.rsplit_once('/') {
        Some(("", _)) | None => "/".into(),
        Some((p, _)) => p.into(),
    }
}

fn status(id: u32) -> p::Status {
    p::Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

fn io_status(error: std::io::Error) -> StatusCode {
    match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

impl DiskSftp {
    fn disk(&self, virtual_path: &str) -> PathBuf {
        let mut path = self.root.clone();
        for part in virtual_path.split('/').filter(|p| !p.is_empty()) {
            path.push(part);
        }
        path
    }

    /// Follows virtual symlinks on every component (max 16 hops).
    fn resolve(&self, path: &str) -> Result<String, StatusCode> {
        let links = self.links.lock().unwrap();
        let mut current = normalize(path);
        for _ in 0..16 {
            let mut built = String::new();
            let mut changed = false;
            let parts: Vec<String> = current
                .split('/')
                .filter(|p| !p.is_empty())
                .map(String::from)
                .collect();
            for (index, part) in parts.iter().enumerate() {
                built = format!("{built}/{part}");
                if let Some(target) = links.get(&built) {
                    let target = if target.starts_with('/') {
                        target.clone()
                    } else {
                        format!("{}/{}", parent(&built), target)
                    };
                    let rest = parts[index + 1..].join("/");
                    current = normalize(&format!("{target}/{rest}"));
                    changed = true;
                    break;
                }
            }
            if !changed {
                return Ok(current);
            }
        }
        Err(StatusCode::Failure)
    }

    /// Resolves every component except the last one (lstat semantics).
    fn resolve_parent(&self, path: &str) -> Result<String, StatusCode> {
        let path = normalize(path);
        if path == "/" {
            return Ok(path);
        }
        let (dir, name) = path.rsplit_once('/').unwrap();
        let dir = self.resolve(if dir.is_empty() { "/" } else { dir })?;
        Ok(normalize(&format!("{dir}/{name}")))
    }

    fn attrs_for(&self, virtual_path: &str, metadata: &std::fs::Metadata) -> p::FileAttributes {
        let kind = if metadata.is_dir() { S_IFDIR } else { S_IFREG };
        let default = if metadata.is_dir() { 0o755 } else { 0o644 };
        let mode = self
            .modes
            .lock()
            .unwrap()
            .get(virtual_path)
            .copied()
            .unwrap_or(default);
        let seconds = |time: std::io::Result<std::time::SystemTime>| {
            time.ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as u32)
        };
        p::FileAttributes {
            size: Some(metadata.len()),
            uid: Some(1000),
            gid: Some(1000),
            permissions: Some(kind | mode),
            atime: seconds(metadata.accessed()),
            mtime: seconds(metadata.modified()),
            ..Default::default()
        }
    }

    fn stat_path(&self, path: &str) -> Result<p::FileAttributes, StatusCode> {
        let path = self.resolve(path)?;
        let metadata = std::fs::metadata(self.disk(&path)).map_err(io_status)?;
        Ok(self.attrs_for(&path, &metadata))
    }

    fn lstat_path(&self, path: &str) -> Result<p::FileAttributes, StatusCode> {
        let path = self.resolve_parent(path)?;
        if let Some(target) = self.links.lock().unwrap().get(&path) {
            return Ok(p::FileAttributes {
                size: Some(target.len() as u64),
                permissions: Some(S_IFLNK | 0o777),
                mtime: Some(0),
                atime: Some(0),
                ..Default::default()
            });
        }
        let metadata = std::fs::metadata(self.disk(&path)).map_err(io_status)?;
        Ok(self.attrs_for(&path, &metadata))
    }

    fn handle(&mut self, open: Open) -> String {
        self.next += 1;
        let handle = format!("h{}", self.next);
        self.handles.insert(handle.clone(), open);
        handle
    }

    fn apply_attrs(&self, path: &str, attrs: &p::FileAttributes) -> Result<(), StatusCode> {
        let disk = self.disk(path);
        if let Some(permissions) = attrs.permissions {
            self.modes
                .lock()
                .unwrap()
                .insert(path.to_string(), permissions & 0o7777);
        }
        if attrs.size.is_some() || attrs.mtime.is_some() {
            if disk.is_dir() {
                return Ok(());
            }
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(&disk)
                .map_err(io_status)?;
            if let Some(size) = attrs.size {
                file.set_len(size).map_err(io_status)?;
            }
            if let Some(mtime) = attrs.mtime {
                file.set_modified(UNIX_EPOCH + Duration::from_secs(mtime as u64))
                    .map_err(io_status)?;
            }
        }
        Ok(())
    }
}

impl russh_sftp::server::Handler for DiskSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<p::Name, StatusCode> {
        Ok(p::Name {
            id,
            files: vec![p::File::dummy(normalize(&path))],
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<p::Attrs, StatusCode> {
        Ok(p::Attrs {
            id,
            attrs: self.stat_path(&path)?,
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<p::Attrs, StatusCode> {
        Ok(p::Attrs {
            id,
            attrs: self.lstat_path(&path)?,
        })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<p::Attrs, StatusCode> {
        match self.handles.get(&handle) {
            Some(Open::File(file)) => {
                let metadata = file.metadata().map_err(io_status)?;
                Ok(p::Attrs {
                    id,
                    attrs: self.attrs_for("", &metadata),
                })
            }
            _ => Err(StatusCode::Failure),
        }
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: p::FileAttributes,
    ) -> Result<p::Status, StatusCode> {
        let path = self.resolve(&path)?;
        if !self.disk(&path).exists() {
            return Err(StatusCode::NoSuchFile);
        }
        self.apply_attrs(&path, &attrs)?;
        Ok(status(id))
    }
    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: p::FileAttributes,
    ) -> Result<p::Status, StatusCode> {
        match self.handles.get(&handle) {
            Some(Open::File(file)) => {
                if let Some(size) = attrs.size {
                    file.set_len(size).map_err(io_status)?;
                }
                if let Some(mtime) = attrs.mtime {
                    file.set_modified(UNIX_EPOCH + Duration::from_secs(mtime as u64))
                        .map_err(io_status)?;
                }
                Ok(status(id))
            }
            _ => Err(StatusCode::Failure),
        }
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<p::Handle, StatusCode> {
        let path = self.resolve(&path)?;
        let disk = self.disk(&path);
        if !disk.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let mut files = vec![];
        for entry in std::fs::read_dir(&disk).map_err(io_status)? {
            let entry = entry.map_err(io_status)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let child = normalize(&format!("{path}/{name}"));
            files.push(p::File {
                filename: name,
                longname: String::new(),
                attrs: self.lstat_path(&child)?,
            });
        }
        let links: Vec<String> = self
            .links
            .lock()
            .unwrap()
            .keys()
            .filter(|link| parent(link) == path)
            .cloned()
            .collect();
        for link in links {
            files.push(p::File {
                filename: link.rsplit('/').next().unwrap().to_string(),
                longname: String::new(),
                attrs: self.lstat_path(&link)?,
            });
        }
        Ok(p::Handle {
            id,
            handle: self.handle(Open::Dir(Some(files))),
        })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<p::Name, StatusCode> {
        match self.handles.get_mut(&handle) {
            Some(Open::Dir(entries)) => match entries.take() {
                Some(files) => Ok(p::Name { id, files }),
                None => Err(StatusCode::Eof),
            },
            _ => Err(StatusCode::Failure),
        }
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: p::OpenFlags,
        attrs: p::FileAttributes,
    ) -> Result<p::Handle, StatusCode> {
        let path = self.resolve(&filename)?;
        let disk = self.disk(&path);
        if disk.is_dir() {
            return Err(StatusCode::Failure);
        }
        if !self.disk(&parent(&path)).is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let exists = disk.exists();
        if flags.contains(p::OpenFlags::CREATE) && flags.contains(p::OpenFlags::EXCLUDE) && exists {
            return Err(StatusCode::Failure);
        }
        if !exists && !flags.contains(p::OpenFlags::CREATE) {
            return Err(StatusCode::NoSuchFile);
        }
        let file = std::fs::OpenOptions::new()
            .read(flags.contains(p::OpenFlags::READ))
            .write(flags.contains(p::OpenFlags::WRITE) || flags.contains(p::OpenFlags::APPEND))
            .append(flags.contains(p::OpenFlags::APPEND))
            .create(flags.contains(p::OpenFlags::CREATE))
            .truncate(flags.contains(p::OpenFlags::TRUNCATE))
            .open(&disk)
            .map_err(io_status)?;
        if !exists {
            if let Some(permissions) = attrs.permissions {
                self.modes
                    .lock()
                    .unwrap()
                    .insert(path.clone(), permissions & 0o7777);
            }
        }
        Ok(p::Handle {
            id,
            handle: self.handle(Open::File(file)),
        })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<p::Status, StatusCode> {
        self.handles.remove(&handle);
        Ok(status(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<p::Data, StatusCode> {
        let Some(Open::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
        let mut data = vec![0; len.min(256 * 1024) as usize];
        let n = file.read(&mut data).map_err(io_status)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(n);
        Ok(p::Data { id, data })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<p::Status, StatusCode> {
        let Some(Open::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
        file.write_all(&data).map_err(io_status)?;
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, filename: String) -> Result<p::Status, StatusCode> {
        let path = self.resolve_parent(&filename)?;
        if self.links.lock().unwrap().remove(&path).is_some() {
            return Ok(status(id));
        }
        let disk = self.disk(&path);
        if disk.is_dir() {
            return Err(StatusCode::Failure);
        }
        std::fs::remove_file(disk).map_err(io_status)?;
        self.modes.lock().unwrap().remove(&path);
        Ok(status(id))
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: p::FileAttributes,
    ) -> Result<p::Status, StatusCode> {
        let path = self.resolve_parent(&path)?;
        let disk = self.disk(&path);
        if disk.exists() || self.links.lock().unwrap().contains_key(&path) {
            return Err(StatusCode::Failure);
        }
        std::fs::create_dir(disk).map_err(io_status)?;
        if let Some(permissions) = attrs.permissions {
            self.modes
                .lock()
                .unwrap()
                .insert(path, permissions & 0o7777);
        }
        Ok(status(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<p::Status, StatusCode> {
        let path = self.resolve_parent(&path)?;
        let disk = self.disk(&path);
        if !disk.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let has_links = self
            .links
            .lock()
            .unwrap()
            .keys()
            .any(|link| parent(link) == path);
        if has_links
            || std::fs::read_dir(&disk)
                .map_err(io_status)?
                .next()
                .is_some()
        {
            return Err(StatusCode::Failure);
        }
        std::fs::remove_dir(disk).map_err(io_status)?;
        Ok(status(id))
    }
    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<p::Status, StatusCode> {
        let old = self.resolve_parent(&oldpath)?;
        let new = self.resolve_parent(&newpath)?;
        let new_disk = self.disk(&new);
        // SFTP v3: rename never replaces an existing target.
        if new_disk.exists() || self.links.lock().unwrap().contains_key(&new) {
            return Err(StatusCode::Failure);
        }
        let mut links = self.links.lock().unwrap();
        if let Some(target) = links.remove(&old) {
            links.insert(new, target);
            return Ok(status(id));
        }
        drop(links);
        std::fs::rename(self.disk(&old), new_disk).map_err(io_status)?;
        let mut modes = self.modes.lock().unwrap();
        if let Some(mode) = modes.remove(&old) {
            modes.insert(new, mode);
        }
        Ok(status(id))
    }
    async fn readlink(&mut self, id: u32, path: String) -> Result<p::Name, StatusCode> {
        let path = self.resolve_parent(&path)?;
        let target = self
            .links
            .lock()
            .unwrap()
            .get(&path)
            .cloned()
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(p::Name {
            id,
            files: vec![p::File::dummy(target)],
        })
    }
    async fn symlink(
        &mut self,
        id: u32,
        linkpath: String,
        targetpath: String,
    ) -> Result<p::Status, StatusCode> {
        let link = self.resolve_parent(&linkpath)?;
        if self.disk(&link).exists() {
            return Err(StatusCode::Failure);
        }
        self.links.lock().unwrap().insert(link, targetpath);
        Ok(status(id))
    }
}

/// Maps a virtual path to its location inside a fixture root (test helper).
pub fn on_disk(root: &Path, virtual_path: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in normalize(virtual_path).split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::normalize;
    #[test]
    fn virtual_paths_cannot_escape_root() {
        assert_eq!(normalize("."), "/");
        assert_eq!(normalize("../../etc/passwd"), "/etc/passwd");
        assert_eq!(normalize("/a/./b/../c/"), "/a/c");
        assert_eq!(normalize("docs"), "/docs");
    }
}
