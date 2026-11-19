#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backup;
mod edit;
mod files;
mod forward;
#[cfg(test)]
mod integration;
mod proxy;
mod ssh;
mod store;
mod sync;
mod transfer;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use store::{Host, Store};
use tauri::{Emitter, Manager, State};
use tokio::sync::{Mutex, Notify, Semaphore, oneshot};

#[derive(Clone)]
pub struct Events(Arc<dyn Fn(&str, Value) + Send + Sync>);
impl Events {
    fn desktop(app: tauri::AppHandle) -> Self {
        Self(Arc::new(move |name, value| {
            let _ = app.emit(name, value);
        }))
    }
    pub fn emit(&self, name: &str, value: Value) -> Result<(), ()> {
        (self.0)(name, value);
        Ok(())
    }
}

pub struct AppState {
    store: Mutex<Store>,
    sessions: ssh::Sessions,
    verdicts: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    transfers: Mutex<HashMap<String, Arc<Notify>>>,
    /// Destinations currently being written by a transfer (no two writers per target).
    targets: std::sync::Mutex<std::collections::HashSet<String>>,
    slots: Arc<Semaphore>,
    /// Pending authentication prompts (password, OTP…): answered by `auth_respond`.
    prompts: std::sync::Mutex<HashMap<String, oneshot::Sender<Option<Vec<String>>>>>,
    /// SSH agent socket / named pipe override (tests); `None` uses the system agent.
    agent_path: std::sync::Mutex<Option<String>>,
    /// Running port forwards by `sessionId:specId`.
    forwards: std::sync::Mutex<HashMap<String, forward::Running>>,
}
impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store: Mutex::new(store),
            sessions: Mutex::new(HashMap::new()),
            verdicts: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            targets: Default::default(),
            slots: Arc::new(Semaphore::new(2)),
            prompts: Default::default(),
            agent_path: Default::default(),
            forwards: Default::default(),
        }
    }
}
type Shared<'a> = State<'a, Arc<AppState>>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[tauri::command]
async fn snapshot(state: Shared<'_>) -> Result<Value, String> {
    Ok(state.store.lock().await.snapshot())
}
#[tauri::command]
async fn save_host(state: Shared<'_>, host: Host) -> Result<Value, String> {
    host.validate().map_err(err)?;
    let mut store = state.store.lock().await;
    if host.auth == "key" && !store.data.keys.iter().any(|k| k.id == host.key_id) {
        return Err("Chọn SSH key trước.".into());
    }
    let mut host = host;
    if !host.jump_host_id.is_empty() && !store.data.hosts.iter().any(|h| h.id == host.jump_host_id)
    {
        return Err("Jump host không tồn tại.".into());
    }
    let previous = store.data.hosts.iter().find(|h| h.id == host.id).cloned();
    host.seal_proxy_password(previous.as_ref()).map_err(err)?;
    let before = store.data.clone();
    store.data.hosts.retain(|h| h.id != host.id);
    store.data.hosts.push(host);
    if let Err(e) = store.save() {
        store.data = before;
        return Err(err(e));
    }
    Ok(store.snapshot())
}
#[tauri::command]
async fn delete_host(state: Shared<'_>, id: String) -> Result<Value, String> {
    let mut store = state.store.lock().await;
    if let Some(user) = store.data.hosts.iter().find(|h| h.jump_host_id == id) {
        return Err(format!(
            "Server đang là jump host của “{}”. Bỏ chọn jump host ở server đó trước.",
            user.name
        ));
    }
    let before = store.data.clone();
    store.data.hosts.retain(|h| h.id != id);
    if let Err(e) = store.save() {
        store.data = before;
        return Err(err(e));
    }
    Ok(store.snapshot())
}
#[tauri::command]
async fn import_key(
    state: Shared<'_>,
    name: String,
    path: String,
    passphrase: String,
) -> Result<Value, String> {
    let metadata = tokio::fs::metadata(&path).await.map_err(err)?;
    if metadata.len() > 1024 * 1024 {
        return Err("File key quá lớn.".into());
    }
    let private = tokio::fs::read_to_string(path).await.map_err(err)?;
    let mut store = state.store.lock().await;
    let before = store.data.clone();
    if let Err(e) = store.add_key(name, &private, &passphrase) {
        store.data = before;
        return Err(format!(
            "Không nhập được key: {e}. Kiểm tra file (OpenSSH, PEM hoặc PuTTY .ppk) và passphrase."
        ));
    }
    Ok(store.snapshot())
}
#[tauri::command]
async fn generate_key(state: Shared<'_>, name: String) -> Result<Value, String> {
    let private =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .map_err(err)?;
    let text = private
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(err)?;
    let mut store = state.store.lock().await;
    let before = store.data.clone();
    if let Err(e) = store.add_key(name, &text, "") {
        store.data = before;
        return Err(err(e));
    }
    Ok(store.snapshot())
}
#[tauri::command]
async fn delete_key(state: Shared<'_>, id: String) -> Result<Value, String> {
    let mut store = state.store.lock().await;
    if store
        .data
        .hosts
        .iter()
        .any(|h| h.auth == "key" && h.key_id == id)
    {
        return Err("Key đang được server sử dụng. Hãy đổi key của server trước.".into());
    }
    let before = store.data.clone();
    store.data.keys.retain(|k| k.id != id);
    if let Err(e) = store.save() {
        store.data = before;
        return Err(err(e));
    }
    Ok(store.snapshot())
}
#[tauri::command]
async fn forget_host(state: Shared<'_>, address: String) -> Result<Value, String> {
    let mut store = state.store.lock().await;
    let before = store.data.clone();
    store.data.known_hosts.remove(&address);
    if let Err(e) = store.save() {
        store.data = before;
        return Err(err(e));
    }
    Ok(store.snapshot())
}
#[tauri::command]
async fn verify_host(state: Shared<'_>, id: String, accepted: bool) -> Result<(), String> {
    if let Some(tx) = state.verdicts.lock().await.remove(&id) {
        let _ = tx.send(accepted);
    }
    Ok(())
}
#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    state: Shared<'_>,
    id: String,
    host_id: String,
) -> Result<(), String> {
    let host = state
        .store
        .lock()
        .await
        .data
        .hosts
        .iter()
        .find(|h| h.id == host_id)
        .cloned()
        .ok_or("Server không tồn tại")?;
    // Reconnecting reuses the tab's id; refuse while that id still has a live session.
    if state.sessions.lock().await.contains_key(&id) {
        return Err("Phiên này vẫn đang kết nối.".into());
    }
    let result = ssh::establish(
        Events::desktop(app.clone()),
        state.inner().clone(),
        id.clone(),
        host,
    )
    .await
    .map_err(err);
    if let Err(ref error) = result {
        let _ = app.emit("session", json!({"id":id,"status":"error","error":error}));
    }
    result
}
#[tauri::command]
async fn auth_respond(
    state: Shared<'_>,
    id: String,
    answers: Option<Vec<String>>,
) -> Result<(), String> {
    if let Some(tx) = state.prompts.lock().unwrap().remove(&id) {
        let _ = tx.send(answers);
    }
    Ok(())
}
#[tauri::command]
async fn terminal_input(state: Shared<'_>, id: String, data: String) -> Result<(), String> {
    use base64::Engine;
    // Raw terminal bytes (UTF-8 text, or binary mouse reports from xterm's onBinary), base64.
    if data.len() > 1400 * 1024 {
        return Err("Input quá lớn".into());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(err)?;
    let session = state
        .sessions
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or("Phiên đã đóng")?;
    session
        .input
        .send(ssh::Input::Data(data))
        .await
        .map_err(err)
}
#[tauri::command]
async fn terminal_resize(
    state: Shared<'_>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err("Kích thước không hợp lệ".into());
    }
    let session = state
        .sessions
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or("Phiên đã đóng")?;
    session
        .input
        .send(ssh::Input::Resize(cols, rows))
        .await
        .map_err(err)
}
#[tauri::command]
async fn disconnect(state: Shared<'_>, id: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().await.remove(&id) {
        let _ = session.input.send(ssh::Input::Close).await;
    }
    Ok(())
}
#[tauri::command]
async fn list_files(
    state: Shared<'_>,
    session_id: Option<String>,
    directory: String,
) -> Result<Value, String> {
    files::list(state.inner(), session_id, directory)
        .await
        .map_err(err)
}
#[tauri::command]
async fn file_action(
    state: Shared<'_>,
    session_id: Option<String>,
    directory: String,
    name: String,
    new_name: Option<String>,
    action: String,
    is_directory: bool,
) -> Result<(), String> {
    files::action(
        state.inner(),
        session_id,
        directory,
        name,
        new_name,
        action,
        is_directory,
    )
    .await
    .map_err(err)
}
#[tauri::command]
async fn transfer(
    app: tauri::AppHandle,
    state: Shared<'_>,
    request: transfer::Transfer,
) -> Result<(), String> {
    transfer::start(Events::desktop(app), state.inner().clone(), request)
        .await
        .map_err(err)
}
#[tauri::command]
async fn cancel_transfer(state: Shared<'_>, id: String) -> Result<(), String> {
    if let Some(cancel) = state.transfers.lock().await.get(&id) {
        cancel.notify_one();
    }
    Ok(())
}
#[tauri::command]
async fn read_text(state: Shared<'_>, session_id: String, path: String) -> Result<Value, String> {
    edit::read_text(state.inner(), &session_id, path)
        .await
        .map_err(err)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn write_text(
    state: Shared<'_>,
    session_id: String,
    path: String,
    content: String,
    expected_size: Option<u64>,
    expected_mtime: Option<u64>,
    force: bool,
) -> Result<Value, String> {
    let expected = expected_size.zip(expected_mtime);
    edit::write_text(state.inner(), &session_id, path, content, expected, force)
        .await
        .map_err(err)
}
#[tauri::command]
async fn delete_entries(
    state: Shared<'_>,
    session_id: Option<String>,
    directory: String,
    names: Vec<String>,
    count_only: bool,
) -> Result<Value, String> {
    edit::delete_entries(state.inner(), session_id, directory, names, !count_only)
        .await
        .map_err(err)
}
#[tauri::command]
async fn chmod(
    state: Shared<'_>,
    session_id: String,
    directory: String,
    name: String,
    mode: u32,
) -> Result<(), String> {
    edit::chmod(state.inner(), &session_id, directory, name, mode)
        .await
        .map_err(err)
}
#[tauri::command]
async fn sync_preview(
    state: Shared<'_>,
    session_id: String,
    local_directory: String,
    remote_directory: String,
) -> Result<Value, String> {
    sync::preview(
        state.inner(),
        &session_id,
        local_directory,
        remote_directory,
    )
    .await
    .map_err(err)
}
#[tauri::command]
async fn sync_run(
    app: tauri::AppHandle,
    state: Shared<'_>,
    request: sync::SyncRun,
) -> Result<Value, String> {
    sync::run(Events::desktop(app), state.inner().clone(), request)
        .await
        .map_err(err)
}
#[tauri::command]
async fn start_forward(
    app: tauri::AppHandle,
    state: Shared<'_>,
    session_id: String,
    spec: forward::Spec,
) -> Result<Value, String> {
    forward::start(
        Events::desktop(app),
        state.inner().clone(),
        session_id,
        spec,
    )
    .await
    .map_err(err)
}
#[tauri::command]
async fn stop_forward(state: Shared<'_>, id: String) -> Result<bool, String> {
    Ok(forward::stop(state.inner(), &id))
}
#[tauri::command]
async fn list_forwards(state: Shared<'_>) -> Result<Vec<Value>, String> {
    Ok(forward::list(state.inner()))
}
#[tauri::command]
async fn export_key(
    state: Shared<'_>,
    key_id: String,
    path: String,
    passphrase: String,
) -> Result<(), String> {
    let store = state.store.lock().await;
    backup::export_key(&store, &key_id, std::path::Path::new(&path), &passphrase).map_err(err)
}
#[tauri::command]
async fn create_backup(state: Shared<'_>, path: String, password: String) -> Result<Value, String> {
    let store = state.store.lock().await;
    backup::create(&store, std::path::Path::new(&path), &password).map_err(err)
}
#[tauri::command]
async fn inspect_backup(
    state: Shared<'_>,
    path: String,
    password: String,
) -> Result<Value, String> {
    let store = state.store.lock().await;
    backup::inspect(&store, std::path::Path::new(&path), &password).map_err(err)
}
#[tauri::command]
async fn restore_backup(
    state: Shared<'_>,
    path: String,
    password: String,
    replace: Vec<String>,
) -> Result<Value, String> {
    let mut store = state.store.lock().await;
    let report = backup::restore(&mut store, std::path::Path::new(&path), &password, &replace)
        .map_err(err)?;
    Ok(json!({"report": report, "snapshot": store.snapshot()}))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let store = Store::load(app.path().app_data_dir()?)?;
            app.manage(Arc::new(AppState::new(store)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            save_host,
            delete_host,
            import_key,
            generate_key,
            delete_key,
            forget_host,
            verify_host,
            auth_respond,
            connect,
            terminal_input,
            terminal_resize,
            disconnect,
            list_files,
            file_action,
            transfer,
            cancel_transfer,
            read_text,
            write_text,
            delete_entries,
            chmod,
            sync_preview,
            sync_run,
            start_forward,
            stop_forward,
            list_forwards,
            export_key,
            create_backup,
            inspect_backup,
            restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("Không khởi động được SSH Studio");
}
