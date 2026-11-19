//! F3: compare a local and a remote folder tree, then synchronise one way.
//!
//! Comparison is by size + mtime (transfers keep mtime, see F1). Synchronising never deletes
//! anything unless the user explicitly lists entries to delete ("mirror"); files are copied
//! through the normal transfer queue with the overwrite policy.
use crate::{
    AppState,
    files::{remote, safe_name},
    transfer::{self, Conflict, Fs, Item, Meta, Transfer, join_rel, walk},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

/// mtimes closer than this are equal (FAT/exFAT keep 2-second timestamps).
pub const MTIME_TOLERANCE: u64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    LocalOnly,
    RemoteOnly,
    LocalNewer,
    RemoteNewer,
    /// Same mtime, different size.
    Changed,
    Same,
    /// A file on one side, a folder on the other: never synchronised.
    TypeMismatch,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Side {
    size: u64,
    mtime: u64,
}
impl From<Meta> for Side {
    fn from(meta: Meta) -> Self {
        Side {
            size: meta.size,
            mtime: meta.mtime,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Entry {
    pub path: String,
    pub folder: bool,
    pub state: State,
    pub local: Option<Side>,
    pub remote: Option<Side>,
}

pub fn classify(local: Option<Meta>, remote: Option<Meta>) -> State {
    match (local, remote) {
        (Some(_), None) => State::LocalOnly,
        (None, Some(_)) => State::RemoteOnly,
        (Some(l), Some(r)) if l.is_dir != r.is_dir => State::TypeMismatch,
        (Some(l), Some(_)) if l.is_dir => State::Same,
        (Some(l), Some(r)) => {
            if l.mtime > r.mtime + MTIME_TOLERANCE {
                State::LocalNewer
            } else if r.mtime > l.mtime + MTIME_TOLERANCE {
                State::RemoteNewer
            } else if l.size == r.size {
                State::Same
            } else {
                State::Changed
            }
        }
        (None, None) => State::Same,
    }
}

/// Pairs two walked trees by relative path, sorted by path.
pub fn compare(local: Vec<Item>, remote: Vec<Item>) -> Vec<Entry> {
    let mut paired: BTreeMap<String, (Option<Meta>, Option<Meta>)> = BTreeMap::new();
    for item in local {
        paired.entry(item.rel).or_default().0 = Some(item.meta);
    }
    for item in remote {
        paired.entry(item.rel).or_default().1 = Some(item.meta);
    }
    paired
        .into_iter()
        .map(|(path, (l, r))| Entry {
            folder: l.or(r).is_some_and(|m| m.is_dir),
            state: classify(l, r),
            local: l.map(Side::from),
            remote: r.map(Side::from),
            path,
        })
        .collect()
}

async fn ensure_dir(fs: &Fs, path: &str) -> anyhow::Result<()> {
    match fs.stat(path).await? {
        Some(meta) if meta.is_dir => Ok(()),
        Some(_) => anyhow::bail!("“{path}” ở đích là file, không phải thư mục."),
        None => fs.mkdir(path).await,
    }
}

pub async fn preview(
    state: &AppState,
    session_id: &str,
    local_directory: String,
    remote_directory: String,
) -> anyhow::Result<Value> {
    let local_fs = Fs::Local;
    anyhow::ensure!(
        local_fs
            .stat(&local_directory)
            .await?
            .is_some_and(|m| m.is_dir),
        "Thư mục local không tồn tại."
    );
    let (local, local_skipped) = walk(&local_fs, &local_directory).await?;
    let (remote, remote_skipped) = remote(state, session_id, |sftp| {
        let directory = remote_directory.clone();
        async move {
            let fs = Fs::Remote(sftp);
            anyhow::ensure!(
                fs.stat(&directory).await?.is_some_and(|m| m.is_dir),
                "Thư mục remote không tồn tại."
            );
            walk(&fs, &directory).await
        }
    })
    .await?;
    Ok(json!({
        "localDirectory": local_directory,
        "remoteDirectory": remote_directory,
        "entries": compare(local, remote),
        "skippedLinks": local_skipped + remote_skipped,
    }))
}

#[derive(Clone, Debug, Deserialize)]
pub struct SyncItem {
    pub path: String,
    pub folder: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRun {
    pub session_id: String,
    pub local_directory: String,
    pub remote_directory: String,
    pub direction: String,
    /// Entries to copy from the source side.
    pub items: Vec<SyncItem>,
    /// Destination-only entries to delete (mirror). Empty unless the user confirmed it.
    #[serde(default)]
    pub delete: Vec<String>,
}

fn check_rel(rel: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!rel.is_empty(), "Đường dẫn rỗng");
    rel.split('/').try_for_each(safe_name)
}
fn parent_and_name(rel: &str) -> (&str, &str) {
    rel.rsplit_once('/').unwrap_or(("", rel))
}

/// Deletes (mirror), creates folders, then queues one overwrite transfer per file.
/// Returns `{ids, folders, deleted}`; `ids` are the queued transfer ids.
pub async fn run(app: crate::Events, state: Arc<AppState>, run: SyncRun) -> anyhow::Result<Value> {
    let upload = match run.direction.as_str() {
        "upload" => true,
        "download" => false,
        _ => anyhow::bail!("Hướng đồng bộ không hợp lệ"),
    };
    for rel in run
        .items
        .iter()
        .map(|i| i.path.as_str())
        .chain(run.delete.iter().map(String::as_str))
    {
        check_rel(rel)?;
    }
    let session = crate::files::session(&state, &run.session_id).await?;
    let dest = if upload {
        Fs::Remote(session.files().await?)
    } else {
        Fs::Local
    };
    let dest_root = if upload {
        &run.remote_directory
    } else {
        &run.local_directory
    };

    // Mirror deletes: top-level entries only (a deleted folder takes its children along).
    let mut delete = run.delete.clone();
    delete.sort();
    let mut deleted = json!({"files": 0, "folders": 0});
    let mut removed: Vec<String> = vec![];
    for rel in delete {
        if removed.iter().any(|r| rel.starts_with(&format!("{r}/"))) {
            continue;
        }
        let (parent, name) = parent_and_name(&rel);
        let counted = crate::edit::delete_entries(
            &state,
            upload.then(|| run.session_id.clone()),
            join_rel(&dest, dest_root, parent),
            vec![name.to_string()],
            true,
        )
        .await?;
        for key in ["files", "folders"] {
            deleted[key] =
                json!(deleted[key].as_u64().unwrap_or(0) + counted[key].as_u64().unwrap_or(0));
        }
        removed.push(rel);
    }

    // Folders, parents first ("a" sorts before "a/b"); files' parents are created too.
    let mut folders: Vec<&str> = run
        .items
        .iter()
        .filter(|i| i.folder)
        .map(|i| i.path.as_str())
        .chain(
            run.items
                .iter()
                .filter(|i| !i.folder)
                .map(|i| parent_and_name(&i.path).0)
                .filter(|p| !p.is_empty()),
        )
        .collect();
    folders.sort();
    folders.dedup();
    let mut created = 0;
    for rel in &folders {
        let mut built = String::new();
        for part in rel.split('/') {
            built = if built.is_empty() {
                part.to_string()
            } else {
                format!("{built}/{part}")
            };
            let path = join_rel(&dest, dest_root, &built);
            if dest.stat(&path).await?.is_none() {
                created += 1;
            }
            ensure_dir(&dest, &path).await?;
        }
    }

    let mut ids = vec![];
    for item in run.items.iter().filter(|i| !i.folder) {
        let (parent, name) = parent_and_name(&item.path);
        let id = uuid::Uuid::new_v4().to_string();
        transfer::start(
            app.clone(),
            state.clone(),
            Transfer {
                id: id.clone(),
                session_id: run.session_id.clone(),
                direction: run.direction.clone(),
                local_directory: join_rel(&Fs::Local, &run.local_directory, parent),
                remote_directory: join_rel(
                    &Fs::Remote(session.files().await?),
                    &run.remote_directory,
                    parent,
                ),
                name: name.to_string(),
                conflict: Conflict::Overwrite,
                ..Default::default()
            },
        )
        .await?;
        ids.push(id);
    }
    Ok(json!({"ids": ids, "folders": created, "deleted": deleted}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file(size: u64, mtime: u64) -> Option<Meta> {
        Some(Meta {
            is_dir: false,
            size,
            mtime,
        })
    }
    #[test]
    fn classification_uses_size_and_mtime_with_tolerance() {
        assert_eq!(classify(file(1, 100), None), State::LocalOnly);
        assert_eq!(classify(None, file(1, 100)), State::RemoteOnly);
        assert_eq!(classify(file(5, 100), file(5, 101)), State::Same);
        assert_eq!(classify(file(5, 200), file(5, 100)), State::LocalNewer);
        assert_eq!(classify(file(5, 100), file(9, 200)), State::RemoteNewer);
        assert_eq!(classify(file(5, 100), file(6, 100)), State::Changed);
        let dir = Some(Meta {
            is_dir: true,
            size: 0,
            mtime: 0,
        });
        assert_eq!(classify(dir, file(1, 1)), State::TypeMismatch);
        assert_eq!(classify(dir, dir), State::Same);
    }
    #[test]
    fn relative_paths_cannot_escape() {
        assert!(check_rel("a/b/c.txt").is_ok());
        for bad in ["", "../x", "a//b", "a/../b", "a\\b", "/abs"] {
            assert!(check_rel(bad).is_err(), "{bad}");
        }
    }
}
