//! Workspaces: named groups of servers (for example one per client or per project). Every host
//! belongs to exactly one workspace; the sidebar shows the servers of the active one.
use crate::store::Data;
use serde::{Deserialize, Serialize};

/// Accent colours offered in the workspace form (the first one is the default).
pub const COLORS: [&str; 8] = [
    "mint", "blue", "violet", "pink", "orange", "yellow", "red", "slate",
];
/// Id of the workspace created for servers saved before workspaces existed.
pub const DEFAULT_ID: &str = "personal";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
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

/// Repairs the workspace list after loading or restoring: at least one workspace, known
/// colours, every host in an existing workspace, and a valid active workspace.
pub fn normalize(data: &mut Data) {
    if data.workspaces.is_empty() {
        data.workspaces.push(Workspace {
            id: DEFAULT_ID.into(),
            name: "Cá nhân".into(),
            color: COLORS[0].into(),
        });
    }
    let mut seen = std::collections::HashSet::new();
    data.workspaces
        .retain(|w| !w.id.is_empty() && seen.insert(w.id.clone()));
    for workspace in &mut data.workspaces {
        if !COLORS.contains(&workspace.color.as_str()) {
            workspace.color = COLORS[0].into();
        }
        if workspace.name.trim().is_empty() {
            workspace.name = "Workspace".into();
        }
    }
    if !data
        .workspaces
        .iter()
        .any(|w| w.id == data.active_workspace)
    {
        data.active_workspace = data.workspaces[0].id.clone();
    }
    let fallback = data.workspaces[0].id.clone();
    for host in &mut data.hosts {
        if !data.workspaces.iter().any(|w| w.id == host.workspace_id) {
            host.workspace_id = fallback.clone();
        }
    }
}

/// Creates (empty id) or renames / recolours a workspace. A new workspace becomes active.
pub fn save(data: &mut Data, mut workspace: Workspace) -> anyhow::Result<()> {
    workspace.name = clean_name(data, &workspace.id, &workspace.name)?;
    if !COLORS.contains(&workspace.color.as_str()) {
        workspace.color = COLORS[0].into();
    }
    match data.workspaces.iter_mut().find(|w| w.id == workspace.id) {
        Some(existing) if !workspace.id.is_empty() => *existing = workspace,
        _ => {
            workspace.id = uuid::Uuid::new_v4().to_string();
            data.active_workspace = workspace.id.clone();
            data.workspaces.push(workspace);
        }
    }
    Ok(())
}

/// Deletes a workspace and moves its servers into `move_to`. The last workspace stays.
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

/// Moves servers into another workspace (jump hosts may live in any workspace).
pub fn move_hosts(data: &mut Data, ids: &[String], to: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        data.workspaces.iter().any(|w| w.id == to),
        "Workspace không tồn tại."
    );
    for host in data.hosts.iter_mut().filter(|h| ids.contains(&h.id)) {
        host.workspace_id = to.to_string();
    }
    Ok(())
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
    }

    #[test]
    fn create_rename_and_switch() {
        let mut data = Data::default();
        normalize(&mut data);
        save(
            &mut data,
            Workspace {
                id: String::new(),
                name: " Khách hàng A ".into(),
                color: "blue".into(),
            },
        )
        .unwrap();
        let created = data.workspaces[1].clone();
        assert_eq!(created.name, "Khách hàng A");
        assert_eq!(data.active_workspace, created.id);
        // Names are unique ignoring case; renaming to its own name is fine.
        let duplicate = Workspace {
            id: String::new(),
            name: "khách hàng a".into(),
            color: "".into(),
        };
        assert!(save(&mut data, duplicate).is_err());
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
    fn deleting_moves_servers_and_keeps_the_last_workspace() {
        let mut data = Data::default();
        normalize(&mut data);
        save(
            &mut data,
            Workspace {
                id: String::new(),
                name: "Prod".into(),
                color: "red".into(),
            },
        )
        .unwrap();
        let prod = data.active_workspace.clone();
        data.hosts = vec![host("a", &prod), host("b", DEFAULT_ID)];
        assert!(delete(&mut data, &prod, &prod).is_err());
        delete(&mut data, &prod, DEFAULT_ID).unwrap();
        assert_eq!(data.active_workspace, DEFAULT_ID);
        assert!(data.hosts.iter().all(|h| h.workspace_id == DEFAULT_ID));
        assert!(delete(&mut data, DEFAULT_ID, DEFAULT_ID).is_err());
        assert_eq!(data.workspaces.len(), 1);
    }

    #[test]
    fn move_hosts_between_workspaces() {
        let mut data = Data::default();
        normalize(&mut data);
        save(
            &mut data,
            Workspace {
                id: String::new(),
                name: "Lab".into(),
                color: "".into(),
            },
        )
        .unwrap();
        let lab = data.active_workspace.clone();
        data.hosts = vec![host("a", DEFAULT_ID), host("b", DEFAULT_ID)];
        move_hosts(&mut data, &["a".into()], &lab).unwrap();
        assert_eq!(data.hosts[0].workspace_id, lab);
        assert_eq!(data.hosts[1].workspace_id, DEFAULT_ID);
        assert!(move_hosts(&mut data, &["b".into()], "missing").is_err());
    }
}
