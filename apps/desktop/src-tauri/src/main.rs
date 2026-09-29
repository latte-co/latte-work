#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod lifecycle;
mod paste;
mod providers;
use latte_work_client::{Client, SshAuthentication};
use latte_work_protocol::{Request, Response};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    io::AsyncWriteExt,
    net::UnixListener,
    sync::{Mutex, RwLock},
    task::JoinHandle,
};
#[derive(Default)]
struct Connections {
    clients: Mutex<HashMap<String, Arc<Mutex<Client>>>>,
    passwords: Mutex<HashMap<String, CachedPassword>>,
    turns: Mutex<HashMap<(String, String), String>>,
    terminals: Mutex<HashSet<(String, String)>>,
    admission: RwLock<()>,
    quitting: AtomicBool,
    exit_ready: AtomicBool,
    close_ack: Mutex<Option<lifecycle::CloseAck>>,
}
struct CachedPassword {
    ssh: String,
    port: Option<u16>,
    value: String,
}
impl CachedPassword {
    fn for_target(&self, ssh: &str, port: Option<u16>) -> Option<&str> {
        (self.ssh == ssh && self.port == port).then_some(self.value.as_str())
    }
}
struct Askpass {
    directory: PathBuf,
    socket: PathBuf,
    task: JoinHandle<()>,
}
impl Askpass {
    fn start(password: String) -> Result<Self, String> {
        if password.is_empty() || password.len() > 4096 || password.contains('\0') {
            return Err("SSH 密码长度无效".into());
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("lw-a-{:x}-{stamp:x}", std::process::id()));
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let socket = directory.join("socket");
        let listener = (|| -> std::io::Result<UnixListener> {
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
            UnixListener::bind(&socket)
        })();
        let listener = match listener {
            Ok(value) => value,
            Err(error) => {
                let _ = std::fs::remove_file(&socket);
                let _ = std::fs::remove_dir(&directory);
                return Err(error.to_string());
            }
        };
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = stream.write_all(password.as_bytes()).await;
            }
        });
        Ok(Self {
            directory,
            socket,
            task,
        })
    }
}
impl Drop for Askpass {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_dir(&self.directory);
    }
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SshAuthMode {
    #[default]
    None,
    IdentityFile,
    Password,
}
#[derive(Clone, Serialize, Deserialize)]
struct Host {
    id: String,
    name: String,
    ssh: Option<String>,
    server_path: Option<String>,
    #[serde(default)]
    auth: SshAuthMode,
    #[serde(default)]
    identity_file: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}
#[tauri::command]
async fn connect_host(
    app: tauri::AppHandle,
    state: State<'_, Connections>,
    host: Host,
    password: Option<String>,
) -> Result<Response, String> {
    let _admission = state.admission.read().await;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("正在停止任务并退出，请稍候".into());
    }
    let client = if let Some(ssh) = &host.ssh {
        let secret = if matches!(host.auth, SshAuthMode::Password) {
            Some(match password.as_deref() {
                Some(value) if !value.is_empty() => value.to_owned(),
                _ => state
                    .passwords
                    .lock()
                    .await
                    .get(&host.id)
                    .and_then(|saved| saved.for_target(ssh, host.port))
                    .map(str::to_owned)
                    .ok_or("SSH_PASSWORD_REQUIRED")?,
            })
        } else {
            None
        };
        let identity = host.identity_file.as_deref().map(PathBuf::from);
        let askpass = std::env::current_exe().map_err(|e| e.to_string())?;
        let challenge = secret
            .as_ref()
            .map(|value| Askpass::start(value.clone()))
            .transpose()?;
        let auth = match host.auth {
            SshAuthMode::None => SshAuthentication::OpenSsh,
            SshAuthMode::IdentityFile => {
                SshAuthentication::IdentityFile(identity.as_deref().ok_or("请选择身份文件")?)
            }
            SshAuthMode::Password => SshAuthentication::Password {
                askpass: &askpass,
                socket: &challenge.as_ref().ok_or("请输入 SSH 密码")?.socket,
            },
        };
        let result = Client::ssh_with_auth(
            ssh,
            host.server_path.as_deref().unwrap_or(""),
            host.port,
            auth,
        )
        .await;
        drop(challenge);
        if result.is_ok() {
            let mut passwords = state.passwords.lock().await;
            if let Some(secret) = secret {
                passwords.insert(
                    host.id.clone(),
                    CachedPassword {
                        ssh: ssh.clone(),
                        port: host.port,
                        value: secret,
                    },
                );
            } else {
                passwords.remove(&host.id);
            }
        }
        result.map_err(|e| format!("{e:#}"))
    } else {
        connect_local(&app).await
    }?;
    let mut client = client;
    let response = client
        .request(Request::Hello {
            version: latte_work_protocol::VERSION,
        })
        .await
        .map_err(|e| e.to_string())?;
    state
        .clients
        .lock()
        .await
        .insert(host.id, Arc::new(Mutex::new(client)));
    Ok(response)
}
async fn connect_local(app: &tauri::AppHandle) -> Result<Client, String> {
    let mut binary = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("latte-work-server");
    if !binary.is_file() {
        let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
        binary = resource.join("latte-work-server");
    }
    if cfg!(debug_assertions)
        && let Ok(path) = std::env::var("LATTE_WORK_SERVER")
    {
        binary = PathBuf::from(path);
    }
    Client::local(&binary, None)
        .await
        .map_err(|e| format!("{e:#}"))
}
async fn local_client(
    app: &tauri::AppHandle,
    state: &Connections,
) -> Result<Arc<Mutex<Client>>, String> {
    if let Some(client) = state.clients.lock().await.get("local").cloned() {
        return Ok(client);
    }
    let client = Arc::new(Mutex::new(connect_local(app).await?));
    Ok(state
        .clients
        .lock()
        .await
        .entry("local".into())
        .or_insert(client)
        .clone())
}
#[tauri::command]
async fn host_request(
    app: tauri::AppHandle,
    state: State<'_, Connections>,
    host_id: String,
    request: Request,
) -> Result<Response, String> {
    let _admission = state.admission.read().await;
    if state.quitting.load(Ordering::SeqCst) && !matches!(request, Request::CloseTerminal { .. }) {
        return Err("正在停止任务并退出，请稍候".into());
    }
    if matches!(
        request,
        Request::Providers
            | Request::ProvidersForHost { .. }
            | Request::SaveProvider { .. }
            | Request::DeleteProvider { .. }
            | Request::BindAgentProvider { .. }
            | Request::BindHostAgentProvider { .. }
            | Request::ForgetHostProviders { .. }
            | Request::ExportHostAgentProvider { .. }
            | Request::SyncAgentProvider { .. }
            | Request::ModelsForProvider { .. }
    ) {
        return Err("Provider 配置由 App 管理，请使用 App 设置入口".into());
    }
    let client = state
        .clients
        .lock()
        .await
        .get(&host_id)
        .cloned()
        .ok_or("Host 未连接")?;
    if let Request::Send {
        session_id,
        request_id,
        ..
    } = &request
    {
        // Track before transport: an ambiguous send response may still mean it ran.
        state
            .turns
            .lock()
            .await
            .insert((host_id.clone(), session_id.clone()), request_id.clone());
    }
    // Keep ownership even if creation's transport response is lost.
    let created_terminal = if let Request::CreateTerminal { terminal_id, .. } = &request {
        let key = (host_id.clone(), terminal_id.clone());
        let fresh = state.terminals.lock().await.insert(key.clone());
        Some((key, fresh))
    } else {
        None
    };
    let closed_terminal = if let Request::CloseTerminal { terminal_id } = &request {
        Some((host_id.clone(), terminal_id.clone()))
    } else {
        None
    };
    let observed_turn = if let Request::Poll { session_id, .. } = &request {
        let key = (host_id.clone(), session_id.clone());
        state
            .turns
            .lock()
            .await
            .get(&key)
            .cloned()
            .map(|request| (key, request))
    } else {
        None
    };
    let response = if matches!(request, Request::Models { .. } | Request::Send { .. }) {
        latte_work_client::request_with_app_provider(&client, request, |agent| async move {
            providers::with_store(app, move |store| store.snapshot_for_host(&host_id, &agent))
                .await
                .map_err(anyhow::Error::msg)
        })
        .await
    } else {
        client.lock().await.request(request).await
    }
    .map_err(|e| format!("{e:#}"))?;
    if matches!(response, Response::Error { .. })
        && let Some((key, true)) = created_terminal
    {
        state.terminals.lock().await.remove(&key);
    }
    if matches!(response, Response::Ok)
        && let Some(key) = closed_terminal
    {
        state.terminals.lock().await.remove(&key);
    }
    if let Response::Events { session, .. } = &response
        && lifecycle::settled(&session.status)
        && let Some((key, request)) = observed_turn
    {
        let mut turns = state.turns.lock().await;
        if turns.get(&key) == Some(&request) {
            turns.remove(&key);
        }
    }
    ui_response(response)
}
fn ui_response(response: Response) -> Result<Response, String> {
    if matches!(response, Response::ProviderSnapshot { .. }) {
        return Err("Provider 凭据不能返回界面".into());
    }
    Ok(response)
}
#[tauri::command]
async fn disconnect_host(state: State<'_, Connections>, host_id: String) -> Result<(), String> {
    state.clients.lock().await.remove(&host_id);
    state.passwords.lock().await.remove(&host_id);
    Ok(())
}
fn host_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("hosts.json"))
}
#[tauri::command]
fn load_hosts(app: tauri::AppHandle) -> Result<Vec<Host>, String> {
    let path = host_file(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&data).map_err(|e| e.to_string())
}
#[tauri::command]
async fn save_hosts(app: tauri::AppHandle, hosts: Vec<Host>) -> Result<(), String> {
    let removed: Vec<_> = load_hosts(app.clone())?
        .into_iter()
        .filter(|old| !hosts.iter().any(|host| host.id == old.id))
        .collect();
    if !removed.is_empty() {
        providers::with_store(app.clone(), move |store| {
            for host in removed {
                store.forget_host(&host.id)?;
            }
            Ok(())
        })
        .await?;
    }
    let path = host_file(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("无效配置路径")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(&hosts).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}
#[tauri::command]
async fn choose_reference_path(
    app: tauri::AppHandle,
    directory: bool,
) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().file().set_title(if directory {
        "引用文件夹"
    } else {
        "引用文件"
    });
    let callback = move |file: Option<tauri_plugin_dialog::FilePath>| {
        let result = file
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose();
        let _ = send.send(result);
    };
    if directory {
        dialog.pick_folder(callback);
    } else {
        dialog.pick_file(callback);
    }
    receive.await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn choose_project_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择项目文件夹")
        .pick_folder(move |folder| {
            let result = folder
                .map(|p| {
                    p.into_path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .map_err(|e| e.to_string())
                })
                .transpose();
            let _ = send.send(result);
        });
    receive.await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn choose_identity_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择 SSH 身份文件")
        .pick_file(move |file| {
            let result = file
                .map(|p| {
                    p.into_path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .map_err(|e| e.to_string())
                })
                .transpose();
            let _ = send.send(result);
        });
    receive.await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn reveal_project(
    state: State<'_, Connections>,
    host_id: String,
    project_id: String,
) -> Result<(), String> {
    if host_id != "local" {
        return Err("仅本机项目可在 Finder 中显示".into());
    }
    let client = state
        .clients
        .lock()
        .await
        .get(&host_id)
        .cloned()
        .ok_or("Host 未连接")?;
    let response = client
        .lock()
        .await
        .request(Request::Projects)
        .await
        .map_err(|e| e.to_string())?;
    let Response::Projects { projects } = response else {
        return Err("项目列表不可用".into());
    };
    let project = projects
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("项目不存在")?;
    let path = PathBuf::from(project.path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("项目目录不存在".into());
    }
    if !cfg!(target_os = "macos") {
        return Err("此平台暂不支持 Finder".into());
    }
    let status = tokio::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("无法在 Finder 中显示项目".into());
    }
    Ok(())
}
fn main() {
    if std::env::var("LATTE_WORK_SSH_ASKPASS").as_deref() == Ok("1") {
        let result = std::env::var_os("LATTE_WORK_SSH_ASKPASS_SOCKET")
            .ok_or("missing askpass socket")
            .and_then(|path| {
                let stream = std::os::unix::net::UnixStream::connect(PathBuf::from(path))
                    .map_err(|_| "askpass socket unavailable")?;
                let mut password = Vec::new();
                stream
                    .take(4097)
                    .read_to_end(&mut password)
                    .map_err(|_| "askpass read failed")?;
                if password.len() > 4096 {
                    return Err("askpass response too long");
                }
                use std::io::Write;
                std::io::stdout()
                    .write_all(&password)
                    .map_err(|_| "askpass write failed")
            });
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Connections::default())
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            #[cfg(target_os = "macos")]
            if let Some(tauri::menu::MenuItemKind::Submenu(application)) = menu.items()?.first() {
                // Tauri's default macOS app submenu ends in native terminate:.
                // Replace it with an event-backed item also invoked by macos_quit.m.
                let position = application.items()?.len() - 1;
                application.remove_at(position)?;
                let quit = tauri::menu::MenuItem::with_id(
                    app,
                    "latte-quit",
                    "退出 Latte Work",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?;
                application.insert(&quit, position)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "latte-quit" {
                app.exit(0);
            }
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window must preserve its WebView and in-memory drafts.
                // Explicit application Quit is deliberately not intercepted.
                if window.hide().is_ok() {
                    api.prevent_close();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            lifecycle::app_close_ready,
            connect_host,
            disconnect_host,
            host_request,
            providers::provider_request,
            providers::fetch_provider_models,
            providers::bind_agent_provider,
            providers::agent_providers,
            load_hosts,
            save_hosts,
            choose_project_folder,
            choose_reference_path,
            paste::clipboard_file_paths,
            paste::paste_stage,
            paste::finish_paste_upload,
            paste::import_clipboard_file,
            choose_identity_file,
            reveal_project
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Latte Work desktop")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                let state = app.state::<Connections>();
                if !state.exit_ready.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if !state.quitting.swap(true, Ordering::SeqCst) {
                        lifecycle::quit(app.clone());
                    }
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn native_provider_snapshots_cannot_reach_the_webview() {
        let response: Response = serde_json::from_value(serde_json::json!({
            "kind": "provider_snapshot",
            "snapshot": {
                "provider": {
                    "id": "provider", "name": "Fixture", "protocol": "anthropic_messages",
                    "base_url": "https://example.test", "model": "model", "auth": "api_key",
                    "has_credential": true
                },
                "credential": "native-only-secret"
            }
        }))
        .unwrap();
        assert!(!format!("{response:?}").contains("native-only-secret"));
        let error = ui_response(response).unwrap_err();
        assert!(!error.contains("native-only-secret"));
        assert!(
            ui_response(Response::Providers {
                providers: vec![],
                bindings: vec![]
            })
            .is_ok()
        );
    }

    #[test]
    fn old_host_records_default_to_openssh_and_password_is_not_serialized() {
        let host: Host = serde_json::from_str(
            r#"{"id":"remote","name":"devbox","ssh":"devbox","server_path":"/server","password":"secret"}"#,
        )
        .unwrap();
        assert!(matches!(host.auth, SshAuthMode::None));
        let json = serde_json::to_string(&Host {
            auth: SshAuthMode::Password,
            ..host
        })
        .unwrap();
        assert!(json.contains("\"auth\":\"password\""));
        assert!(!json.contains("password\":\"secret"));
    }

    #[test]
    fn cached_password_is_only_reused_for_the_same_ssh_target() {
        let saved = CachedPassword {
            ssh: "user@old-host".into(),
            port: Some(2222),
            value: "test-secret".into(),
        };
        assert_eq!(
            saved.for_target("user@old-host", Some(2222)),
            Some("test-secret")
        );
        assert_eq!(saved.for_target("user@new-host", Some(2222)), None);
        assert_eq!(saved.for_target("user@old-host", Some(22)), None);
    }

    #[tokio::test]
    async fn askpass_uses_private_socket_and_removes_it_after_use() {
        let challenge = Askpass::start("test-password".to_owned()).unwrap();
        assert_eq!(
            std::fs::metadata(&challenge.directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let socket = challenge.socket.clone();
        let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let mut secret = String::new();
        stream.read_to_string(&mut secret).await.unwrap();
        assert_eq!(secret, "test-password");
        drop(challenge);
        assert!(!socket.exists());
    }
}
