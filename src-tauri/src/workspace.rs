//! Workspaces: named groups of servers (for example one per client or per project). Every host
//! belongs to exactly one workspace; the sidebar shows the servers of the active one.
//!
//! Inside a workspace, folders (at most `MAX_DEPTH` levels) group related servers. A server
//! whose `folder_id` is empty, or names a folder that no longer exists, sits at the root.
use crate::store::Data;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Accent colours offered in the workspace form (the first one is the default).
pub const COLORS: [&str; 8] = [
    "mint", "blue", "violet", "pink", "orange", "yellow", "red", "slate",
];
/// Id of the workspace created for servers saved before workspaces existed.
pub const DEFAULT_ID: &str = "personal";
/// Folder levels in a workspace (a folder at the root is level 1).
pub const MAX_DEPTH: usize = 3;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub folders: Vec<Folder>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// Parent folder ('' for the workspace root).
    #[serde(default)]
    pub parent: String,
    /// Shown folded in the sidebar tree and the server list.
    #[serde(default)]
    pub collapsed: bool,
}

/// Workspace names: 1–60 characters after trimming, unique ignoring case.
fn clean_name(data: &Data, id: &str, name: &str) -> anyhow::Result<String> {
    let name = name.trim();
    anyhow::ensure!(
        !name.is_empty() && name.chars().count() <= 60,
        "Tên workspace phải có từ 1 đến 60 ký tự."
    );
    anyhow::ensure!(
        !data
            .workspaces
            .iter()
            .any(|w| w.id != id && w.name.to_lowercase() == name.to_lowercase()),
        "Đã có workspace tên “{name}”."
    );
    Ok(name.to_string())
}

// ---- folder tree helpers ----------------------------------------------------------------

/// 1 for a folder at the root, 2 for one inside it…; 0 for the root itself.
fn depth_of(folders: &[Folder], id: &str) -> usize {
    let mut depth = 0;
    let mut current = folders.iter().find(|f| f.id == id);
    while let Some(folder) = current {
        depth += 1;
        if depth > folders.len() {
            break;
        }
        current = folders.iter().find(|f| f.id == folder.parent);
    }
    depth
}

/// Levels in the subtree under `id`, the folder itself included (1 for a leaf).
fn height_of(folders: &[Folder], id: &str) -> usize {
    1 + folders
        .iter()
        .filter(|f| f.parent == id && f.id != id)
        .map(|f| height_of(folders, &f.id))
        .max()
        .unwrap_or(0)
}

/// `id` and every folder under it.
fn subtree(folders: &[Folder], id: &str) -> HashSet<String> {
    let mut out = HashSet::from([id.to_string()]);
    loop {
        let before = out.len();
        for folder in folders {
            if out.contains(&folder.parent) {
                out.insert(folder.id.clone());
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

/// Folder names: 1–60 characters after trimming.
fn clean_folder_name(name: &str) -> anyhow::Result<String> {
    let name = name.trim();
    anyhow::ensure!(
        !name.is_empty() && name.chars().count() <= 60,
        "Tên thư mục phải có từ 1 đến 60 ký tự."
    );
    Ok(name.to_string())
}

/// No two folders with the same name (ignoring case) side by side.
fn ensure_unique(folders: &[Folder], id: &str, parent: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !folders
            .iter()
            .any(|f| f.id != id && f.parent == parent && f.name.to_lowercase() == name.to_lowercase()),
        "Đã có thư mục “{name}” ở đây."
    );
    Ok(())
}

/// Repairs what an older or hand-edited file may hold: duplicate ids are dropped, folders
/// whose parent is gone (or that form a cycle) go to the root and folders past `MAX_DEPTH`
/// move up to the deepest allowed level.
fn sanitize_folders(folders: &mut Vec<Folder>) {
    let mut seen = HashSet::new();
    folders.retain(|f| !f.id.is_empty() && seen.insert(f.id.clone()));
    let ids: HashSet<String> = folders.iter().map(|f| f.id.clone()).collect();
    for folder in folders.iter_mut() {
        if folder.parent == folder.id || (!folder.parent.is_empty() && !ids.contains(&folder.parent))
        {
            folder.parent.clear();
        }
        if folder.name.trim().is_empty() {
            folder.name = "Thư mục".into();
        }
        folder.name = folder.name.trim().chars().take(60).collect();
    }
    // A folder whose ancestry never reaches the root is part of a cycle.
    let parents: HashMap<String, String> = folders
        .iter()
        .map(|f| (f.id.clone(), f.parent.clone()))
        .collect();
    for folder in folders.iter_mut() {
        let mut current = folder.parent.clone();
        for steps in 0.. {
            if current.is_empty() {
                break;
            }
            if steps > parents.len() {
                folder.parent.clear();
                break;
            }
            current = parents.get(&current).cloned().unwrap_or_default();
        }
    }
    // Too deep: hang it under its ancestor at MAX_DEPTH - 1.
    for index in 0..folders.len() {
        let mut chain = vec![folders[index].id.clone()];
        let mut current = folders[index].parent.clone();
        while !current.is_empty() && chain.len() <= folders.len() {
            chain.insert(0, current.clone());
            current = folders
                .iter()
                .find(|f| f.id == current)
                .map(|f| f.parent.clone())
                .unwrap_or_default();
        }
        if chain.len() > MAX_DEPTH {
            folders[index].parent = chain[MAX_DEPTH - 2].clone();
        }
    }
}

fn find_workspace<'a>(data: &'a mut Data, id: &str) -> anyhow::Result<&'a mut Workspace> {
    data.workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| anyhow::anyhow!("Workspace không tồn tại."))
}

/// Whether `folder` is '' (the root) or a folder of workspace `workspace`.
pub fn has_folder(data: &Data, workspace: &str, folder: &str) -> bool {
    folder.is_empty()
        || data
            .workspaces
            .iter()
            .any(|w| w.id == workspace && w.folders.iter().any(|f| f.id == folder))
}

/// Repairs the workspace list after loading or restoring: at least one workspace, known
/// colours, valid folder trees, every host in an existing workspace and folder, and a valid
/// active workspace.
pub fn normalize(data: &mut Data) {
    if data.workspaces.is_empty() {
        data.workspaces.push(Workspace {
            id: DEFAULT_ID.into(),
            name: "Cá nhân".into(),
            color: COLORS[0].into(),
            folders: vec![],
        });
    }
    let mut seen = HashSet::new();
    data.workspaces
        .retain(|w| !w.id.is_empty() && seen.insert(w.id.clone()));
    for workspace in &mut data.workspaces {
        if !COLORS.contains(&workspace.color.as_str()) {
            workspace.color = COLORS[0].into();
        }
        if workspace.name.trim().is_empty() {
            workspace.name = "Workspace".into();
        }
        sanitize_folders(&mut workspace.folders);
    }
    if !data
        .workspaces
        .iter()
        .any(|w| w.id == data.active_workspace)
    {
        data.active_workspace = data.workspaces[0].id.clone();
    }
    let fallback = data.workspaces[0].id.clone();
    let folders: HashSet<(String, String)> = data
        .workspaces
        .iter()
        .flat_map(|w| w.folders.iter().map(|f| (w.id.clone(), f.id.clone())))
        .collect();
    for host in &mut data.hosts {
        if !data.workspaces.iter().any(|w| w.id == host.workspace_id) {
            host.workspace_id = fallback.clone();
        }
        if !folders.contains(&(host.workspace_id.clone(), host.folder_id.clone())) {
            host.folder_id.clear();
        }
    }
}

/// Creates (empty id) or renames / recolours a workspace. A new workspace becomes active.
/// Editing keeps the folders already there (the workspace form does not send them).
pub fn save(data: &mut Data, mut workspace: Workspace) -> anyhow::Result<()> {
    workspace.name = clean_name(data, &workspace.id, &workspace.name)?;
    if !COLORS.contains(&workspace.color.as_str()) {
        workspace.color = COLORS[0].into();
    }
    match data.workspaces.iter_mut().find(|w| w.id == workspace.id) {
        Some(existing) if !workspace.id.is_empty() => {
            existing.name = workspace.name;
            existing.color = workspace.color;
        }
        _ => {
            workspace.id = uuid::Uuid::new_v4().to_string();
            sanitize_folders(&mut workspace.folders);
            data.active_workspace = workspace.id.clone();
            data.workspaces.push(workspace);
        }
    }
    Ok(())
}

/// Deletes a workspace and moves its servers into the root of `move_to`. The last workspace
/// stays.
pub fn delete(data: &mut Data, id: &str, move_to: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        data.workspaces.iter().any(|w| w.id == id),
        "Workspace không tồn tại."
    );
    anyhow::ensure!(
        data.workspaces.len() > 1,
        "Cần giữ lại ít nhất một workspace."
    );
    anyhow::ensure!(
        move_to != id && data.workspaces.iter().any(|w| w.id == move_to),
        "Chọn workspace nhận các server."
    );
    for host in data.hosts.iter_mut().filter(|h| h.workspace_id == id) {
        host.workspace_id = move_to.to_string();
        host.folder_id.clear();
    }
    data.workspaces.retain(|w| w.id != id);
    if data.active_workspace == id {
        data.active_workspace = move_to.to_string();
    }
    Ok(())
}

pub fn activate(data: &mut Data, id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        data.workspaces.iter().any(|w| w.id == id),
        "Workspace không tồn tại."
    );
    data.active_workspace = id.to_string();
    Ok(())
}

/// Moves servers into another workspace, at its root (jump hosts may live in any workspace).
pub fn move_hosts(data: &mut Data, ids: &[String], to: &str) -> anyhow::Result<()> {
    place_hosts(data, ids, to, "")
}

/// Puts servers into `folder` ('' = the root) of workspace `workspace`.
pub fn place_hosts(
    data: &mut Data,
    ids: &[String],
    workspace: &str,
    folder: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        data.workspaces.iter().any(|w| w.id == workspace),
        "Workspace không tồn tại."
    );
    anyhow::ensure!(
        has_folder(data, workspace, folder),
        "Thư mục không tồn tại."
    );
    for host in data.hosts.iter_mut().filter(|h| ids.contains(&h.id)) {
        host.workspace_id = workspace.to_string();
        host.folder_id = folder.to_string();
    }
    Ok(())
}

/// Creates a folder (an id not yet in the workspace, chosen by the caller) inside
/// `folder.parent`, or renames / folds an existing one. Moving is `move_folder`.
pub fn save_folder(data: &mut Data, workspace: &str, folder: Folder) -> anyhow::Result<()> {
    anyhow::ensure!(!folder.id.trim().is_empty(), "Thiếu mã thư mục.");
    let name = clean_folder_name(&folder.name)?;
    let ws = find_workspace(data, workspace)?;
    if let Some(index) = ws.folders.iter().position(|f| f.id == folder.id) {
        let parent = ws.folders[index].parent.clone();
        ensure_unique(&ws.folders, &folder.id, &parent, &name)?;
        ws.folders[index].name = name;
        ws.folders[index].collapsed = folder.collapsed;
        return Ok(());
    }
    anyhow::ensure!(
        folder.parent.is_empty() || ws.folders.iter().any(|f| f.id == folder.parent),
        "Thư mục cha không tồn tại."
    );
    anyhow::ensure!(
        depth_of(&ws.folders, &folder.parent) < MAX_DEPTH,
        "Thư mục chỉ lồng tối đa {MAX_DEPTH} cấp."
    );
    ensure_unique(&ws.folders, &folder.id, &folder.parent, &name)?;
    ws.folders.push(Folder {
        id: folder.id,
        name,
        parent: folder.parent,
        collapsed: false,
    });
    Ok(())
}

/// Moves a folder (with what it holds) into `parent`: not into itself, within `MAX_DEPTH`.
pub fn move_folder(data: &mut Data, workspace: &str, id: &str, parent: &str) -> anyhow::Result<()> {
    let ws = find_workspace(data, workspace)?;
    let index = ws
        .folders
        .iter()
        .position(|f| f.id == id)
        .ok_or_else(|| anyhow::anyhow!("Thư mục không tồn tại."))?;
    anyhow::ensure!(
        parent.is_empty() || ws.folders.iter().any(|f| f.id == parent),
        "Thư mục đích không tồn tại."
    );
    anyhow::ensure!(
        !subtree(&ws.folders, id).contains(parent),
        "Không thể chuyển thư mục vào chính nó."
    );
    anyhow::ensure!(
        depth_of(&ws.folders, parent) + height_of(&ws.folders, id) <= MAX_DEPTH,
        "Thư mục chỉ lồng tối đa {MAX_DEPTH} cấp."
    );
    let name = ws.folders[index].name.clone();
    ensure_unique(&ws.folders, id, parent, &name)?;
    ws.folders[index].parent = parent.to_string();
    Ok(())
}

/// Deletes a folder; its subfolders and servers move up to its parent. No server is removed.
pub fn delete_folder(data: &mut Data, workspace: &str, id: &str) -> anyhow::Result<()> {
    let ws = find_workspace(data, workspace)?;
    let gone = ws
        .folders
        .iter()
        .find(|f| f.id == id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Thư mục không tồn tại."))?;
    ws.folders.retain(|f| f.id != id);
    for folder in ws.folders.iter_mut().filter(|f| f.parent == id) {
        folder.parent = gone.parent.clone();
    }
    for host in data
        .hosts
        .iter_mut()
        .filter(|h| h.workspace_id == workspace && h.folder_id == id)
    {
        host.folder_id = gone.parent.clone();
    }
    // Two folders of the same name may now sit side by side; that is allowed after a delete.
    Ok(())
}

/// One folder per server group (`Host::group`) at the root of the workspace, holding the
/// servers of that group that are still at the root. Existing root folders of the same name
/// are reused. Returns how many servers were placed.
pub fn group_into_folders(data: &mut Data, workspace: &str) -> anyhow::Result<usize> {
    find_workspace(data, workspace)?;
    let mut placed = 0;
    let groups: Vec<String> = {
        let mut seen = HashSet::new();
        data.hosts
            .iter()
            .filter(|h| h.workspace_id == workspace && h.folder_id.is_empty())
            .map(|h| h.group.trim().to_string())
            .filter(|g| !g.is_empty() && seen.insert(g.to_lowercase()))
            .collect()
    };
    for group in groups {
        let name: String = group.chars().take(60).collect();
        let ws = find_workspace(data, workspace)?;
        let id = match ws
            .folders
            .iter()
            .find(|f| f.parent.is_empty() && f.name.to_lowercase() == name.to_lowercase())
        {
            Some(existing) => existing.id.clone(),
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                ws.folders.push(Folder {
                    id: id.clone(),
                    name,
                    parent: String::new(),
                    collapsed: false,
                });
                id
            }
        };
        for host in data.hosts.iter_mut().filter(|h| {
            h.workspace_id == workspace
                && h.folder_id.is_empty()
                && h.group.trim().to_lowercase() == group.to_lowercase()
        }) {
            host.folder_id = id.clone();
            placed += 1;
        }
    }
    Ok(placed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Host;

    fn host(id: &str, workspace: &str) -> Host {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "host": "example.com", "port": 22, "username": "root",
            "group": "", "auth": "password", "keyId": "", "workspaceId": workspace,
        }))
        .unwrap()
    }

    fn workspace(name: &str, color: &str) -> Workspace {
        Workspace {
            id: String::new(),
            name: name.into(),
            color: color.into(),
            folders: vec![],
        }
    }

    fn folder(id: &str, name: &str, parent: &str) -> Folder {
        Folder {
            id: id.into(),
            name: name.into(),
            parent: parent.into(),
            collapsed: false,
        }
    }

    #[test]
    fn older_files_get_a_default_workspace_holding_every_server() {
        let mut data: Data = serde_json::from_value(serde_json::json!({
            "hosts": [host("a", ""), host("b", "gone")],
            "keys": [], "knownHosts": {},
        }))
        .unwrap();
        normalize(&mut data);
        assert_eq!(data.workspaces.len(), 1);
        assert_eq!(data.active_workspace, DEFAULT_ID);
        assert!(data.hosts.iter().all(|h| h.workspace_id == DEFAULT_ID));
        assert!(data.hosts.iter().all(|h| h.folder_id.is_empty()));
    }

    #[test]
    fn create_rename_and_switch() {
        let mut data = Data::default();
        normalize(&mut data);
        save(&mut data, workspace(" Khách hàng A ", "blue")).unwrap();
        let created = data.workspaces[1].clone();
        assert_eq!(created.name, "Khách hàng A");
        assert_eq!(data.active_workspace, created.id);
        // Names are unique ignoring case; renaming to its own name is fine.
        assert!(save(&mut data, workspace("khách hàng a", "")).is_err());
        save(
            &mut data,
            Workspace {
                color: "nope".into(),
                ..created.clone()
            },
        )
        .unwrap();
        assert_eq!(data.workspaces[1].color, COLORS[0]);
        activate(&mut data, DEFAULT_ID).unwrap();
        assert!(activate(&mut data, "missing").is_err());
        assert_eq!(data.workspaces.len(), 2);
    }

    #[test]
    fn editing_a_workspace_keeps_its_folders() {
        let mut data = Data::default();
        normalize(&mut data);
        save_folder(&mut data, DEFAULT_ID, folder("f", "Web", "")).unwrap();
        // The workspace form sends only id, name and colour.
        let form: Workspace = serde_json::from_value(serde_json::json!({
            "id": DEFAULT_ID, "name": "Nhà", "color": "blue",
        }))
        .unwrap();
        save(&mut data, form).unwrap();
        assert_eq!(data.workspaces[0].name, "Nhà");
        assert_eq!(data.workspaces[0].folders.len(), 1);
    }

    #[test]
    fn deleting_moves_servers_and_keeps_the_last_workspace() {
        let mut data = Data::default();
        normalize(&mut data);
        save(&mut data, workspace("Prod", "red")).unwrap();
        let prod = data.active_workspace.clone();
        save_folder(&mut data, &prod, folder("f", "Web", "")).unwrap();
        data.hosts = vec![host("a", &prod), host("b", DEFAULT_ID)];
        data.hosts[0].folder_id = "f".into();
        assert!(delete(&mut data, &prod, &prod).is_err());
        delete(&mut data, &prod, DEFAULT_ID).unwrap();
        assert_eq!(data.active_workspace, DEFAULT_ID);
        assert!(data.hosts.iter().all(|h| h.workspace_id == DEFAULT_ID));
        assert!(data.hosts.iter().all(|h| h.folder_id.is_empty()));
        assert!(delete(&mut data, DEFAULT_ID, DEFAULT_ID).is_err());
        assert_eq!(data.workspaces.len(), 1);
    }

    #[test]
    fn move_hosts_between_workspaces() {
        let mut data = Data::default();
        normalize(&mut data);
        save(&mut data, workspace("Lab", "")).unwrap();
        let lab = data.active_workspace.clone();
        save_folder(&mut data, DEFAULT_ID, folder("f", "Web", "")).unwrap();
        data.hosts = vec![host("a", DEFAULT_ID), host("b", DEFAULT_ID)];
        data.hosts[0].folder_id = "f".into();
        move_hosts(&mut data, &["a".into()], &lab).unwrap();
        assert_eq!(data.hosts[0].workspace_id, lab);
        assert_eq!(data.hosts[0].folder_id, "");
        assert_eq!(data.hosts[1].workspace_id, DEFAULT_ID);
        assert!(move_hosts(&mut data, &["b".into()], "missing").is_err());
        // A folder of another workspace is refused.
        assert!(place_hosts(&mut data, &["a".into()], &lab, "f").is_err());
        place_hosts(&mut data, &["a".into()], DEFAULT_ID, "f").unwrap();
        assert_eq!(data.hosts[0].workspace_id, DEFAULT_ID);
        assert_eq!(data.hosts[0].folder_id, "f");
    }

    #[test]
    fn folders_nest_three_levels_with_unique_names() {
        let mut data = Data::default();
        normalize(&mut data);
        let ws = DEFAULT_ID;
        save_folder(&mut data, ws, folder("a", " Khách A ", "")).unwrap();
        save_folder(&mut data, ws, folder("b", "Prod", "a")).unwrap();
        save_folder(&mut data, ws, folder("c", "Web", "b")).unwrap();
        assert_eq!(data.workspaces[0].folders[0].name, "Khách A");
        assert!(save_folder(&mut data, ws, folder("d", "Too deep", "c")).is_err());
        assert!(save_folder(&mut data, ws, folder("e", "prod", "a")).is_err());
        assert!(save_folder(&mut data, ws, folder("e", "Prod", "missing")).is_err());
        assert!(save_folder(&mut data, ws, folder("e", "  ", "")).is_err());
        // Rename and fold, the parent stays.
        save_folder(
            &mut data,
            ws,
            Folder {
                collapsed: true,
                ..folder("b", "Production", "")
            },
        )
        .unwrap();
        let b = data.workspaces[0].folders.iter().find(|f| f.id == "b").unwrap();
        assert_eq!((b.name.as_str(), b.parent.as_str(), b.collapsed), ("Production", "a", true));
    }

    #[test]
    fn moving_folders_stays_within_depth_and_out_of_itself() {
        let mut data = Data::default();
        normalize(&mut data);
        let ws = DEFAULT_ID;
        save_folder(&mut data, ws, folder("a", "A", "")).unwrap();
        save_folder(&mut data, ws, folder("b", "B", "a")).unwrap();
        save_folder(&mut data, ws, folder("x", "X", "")).unwrap();
        save_folder(&mut data, ws, folder("y", "Y", "x")).unwrap();
        assert!(move_folder(&mut data, ws, "a", "b").is_err(), "into its own child");
        assert!(move_folder(&mut data, ws, "a", "a").is_err(), "into itself");
        // x (two levels) under b (level 2) would make four levels.
        assert!(move_folder(&mut data, ws, "x", "b").is_err());
        move_folder(&mut data, ws, "x", "a").unwrap();
        assert_eq!(depth_of(&data.workspaces[0].folders, "y"), 3);
        move_folder(&mut data, ws, "x", "").unwrap();
        assert_eq!(depth_of(&data.workspaces[0].folders, "y"), 2);
    }

    #[test]
    fn deleting_a_folder_moves_what_it_holds_up() {
        let mut data = Data::default();
        normalize(&mut data);
        let ws = DEFAULT_ID;
        save_folder(&mut data, ws, folder("a", "A", "")).unwrap();
        save_folder(&mut data, ws, folder("b", "B", "a")).unwrap();
        save_folder(&mut data, ws, folder("c", "C", "b")).unwrap();
        data.hosts = vec![host("h1", ws), host("h2", ws)];
        data.hosts[0].folder_id = "b".into();
        data.hosts[1].folder_id = "c".into();
        delete_folder(&mut data, ws, "b").unwrap();
        let folders = &data.workspaces[0].folders;
        assert_eq!(folders.iter().find(|f| f.id == "c").unwrap().parent, "a");
        assert_eq!(data.hosts[0].folder_id, "a");
        assert_eq!(data.hosts[1].folder_id, "c");
        delete_folder(&mut data, ws, "a").unwrap();
        assert_eq!(data.hosts[0].folder_id, "");
        assert!(delete_folder(&mut data, ws, "a").is_err());
    }

    #[test]
    fn normalize_repairs_broken_trees_and_placements() {
        let mut data = Data::default();
        normalize(&mut data);
        data.workspaces[0].folders = vec![
            folder("a", "A", "c"), // cycle a → c → b → a
            folder("b", "B", "a"),
            folder("c", "C", "b"),
            folder("a", "Duplicate", ""),
            folder("o", "Orphan", "gone"),
            folder("1", "1", ""),
            folder("2", "2", "1"),
            folder("3", "3", "2"),
            folder("4", "4", "3"),
        ];
        data.hosts = vec![host("h1", DEFAULT_ID), host("h2", DEFAULT_ID)];
        data.hosts[0].folder_id = "o".into();
        data.hosts[1].folder_id = "missing".into();
        normalize(&mut data);
        let folders = &data.workspaces[0].folders;
        assert_eq!(folders.len(), 8);
        assert_eq!(folders.iter().find(|f| f.id == "o").unwrap().parent, "");
        assert!(folders.iter().all(|f| depth_of(folders, &f.id) <= MAX_DEPTH));
        assert_eq!(folders.iter().find(|f| f.id == "4").unwrap().parent, "2");
        assert_eq!(data.hosts[0].folder_id, "o");
        assert_eq!(data.hosts[1].folder_id, "");
    }

    #[test]
    fn groups_become_root_folders() {
        let mut data = Data::default();
        normalize(&mut data);
        let ws = DEFAULT_ID;
        save_folder(&mut data, ws, folder("prod", "Production", "")).unwrap();
        let mut hosts = vec![
            host("a", ws),
            host("b", ws),
            host("c", ws),
            host("d", ws),
        ];
        hosts[0].group = "production".into();
        hosts[1].group = "Staging".into();
        hosts[2].group = "Staging".into();
        hosts[3].group = "Staging".into();
        hosts[3].folder_id = "prod".into(); // already placed: stays
        data.hosts = hosts;
        assert_eq!(group_into_folders(&mut data, ws).unwrap(), 3);
        assert_eq!(data.workspaces[0].folders.len(), 2);
        assert_eq!(data.hosts[0].folder_id, "prod");
        assert_eq!(data.hosts[1].folder_id, data.hosts[2].folder_id);
        assert_ne!(data.hosts[1].folder_id, "");
        assert_eq!(data.hosts[3].folder_id, "prod");
    }
}
