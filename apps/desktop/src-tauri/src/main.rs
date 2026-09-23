#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use latte_work_client::Client;
use latte_work_protocol::{Request, Response};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
#[derive(Default)]
struct Connections(Mutex<HashMap<String, Arc<Mutex<Client>>>>);
#[derive(Clone, Serialize, Deserialize)]
struct Host {
    id: String,
    name: String,
    ssh: Option<String>,
    server_path: Option<String>,
}
#[tauri::command]
async fn connect_host(
    app: tauri::AppHandle,
    state: State<'_, Connections>,
    host: Host,
) -> Result<Response, String> {
    let client = if let Some(ssh) = &host.ssh {
        Client::ssh(
            ssh,
            host.server_path
                .as_deref()
                .ok_or("请填写远程 Server 的绝对路径")?,
        )
        .await
    } else {
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
        Client::local(&binary, None).await
    }
    .map_err(|e| format!("{e:#}"))?;
    let mut client = client;
    let response = client
        .request(Request::Hello {
            version: latte_work_protocol::VERSION,
        })
        .await
        .map_err(|e| e.to_string())?;
    state
        .0
        .lock()
        .await
        .insert(host.id, Arc::new(Mutex::new(client)));
    Ok(response)
}
#[tauri::command]
async fn host_request(
    state: State<'_, Connections>,
    host_id: String,
    request: Request,
) -> Result<Response, String> {
    let client = state
        .0
        .lock()
        .await
        .get(&host_id)
        .cloned()
        .ok_or("Host 未连接")?;
    client
        .lock()
        .await
        .request(request)
        .await
        .map_err(|e| format!("{e:#}"))
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
fn save_hosts(app: tauri::AppHandle, hosts: Vec<Host>) -> Result<(), String> {
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
async fn reveal_project(
    state: State<'_, Connections>,
    host_id: String,
    project_id: String,
) -> Result<(), String> {
    if host_id != "local" {
        return Err("仅本机项目可在 Finder 中显示".into());
    }
    let client = state
        .0
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Connections::default())
        .invoke_handler(tauri::generate_handler![
            connect_host,
            host_request,
            load_hosts,
            save_hosts,
            choose_project_folder,
            reveal_project
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Latte Work desktop");
}
