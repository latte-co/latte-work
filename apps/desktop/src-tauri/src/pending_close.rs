//! Explicit quit residual resources: finish local closes, reattach remote sessions.
//! No passwords, prompts or Provider secrets.
use crate::{Connections, Host};
use latte_work_client::Client;
use latte_work_protocol::lifecycle::Resource;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Serialize, Deserialize)]
struct Intent {
    owner_id: String,
    hosts: Vec<HostIntent>,
}
#[derive(Serialize, Deserialize)]
struct HostIntent {
    host: Host,
    server_id: String,
    resources: Vec<Resource>,
}
const LIMIT: u64 = 1024 * 1024;
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("pending-resources"))
}
fn lock(directory: &Path) -> Result<File, String> {
    if directory
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("关闭记录目录不能是符号链接".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let path = directory.join("pending.lock");
    regular(&path)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "关闭记录正在处理，请稍后重新连接".to_string())?;
    Ok(file)
}
fn regular(path: &Path) -> Result<(), String> {
    match path.symlink_metadata() {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err("关闭记录必须为普通文件".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn write(directory: &Path, intent: &Intent) -> Result<(), String> {
    let owner = uuid::Uuid::parse_str(&intent.owner_id).map_err(|e| e.to_string())?;
    let path = directory.join(format!("{owner}.json"));
    regular(&path)?;
    if intent.hosts.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    }
    let data = serde_json::to_vec(intent).map_err(|e| e.to_string())?;
    if data.len() as u64 > LIMIT {
        return Err("关闭记录超过大小限制".into());
    }
    let temp = directory.join(format!("{owner}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)?;
        File::open(directory)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result.map_err(|e| e.to_string())
}
fn read(path: &Path) -> Result<Intent, String> {
    regular(path)?;
    let mut data = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(LIMIT + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > LIMIT {
        return Err("关闭记录超过大小限制".into());
    }
    let intent: Intent = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    let owner = uuid::Uuid::parse_str(&intent.owner_id).map_err(|e| e.to_string())?;
    if path.file_name().and_then(|s| s.to_str()) != Some(format!("{owner}.json").as_str())
        || intent.hosts.len() > 128
        || intent.hosts.iter().any(|h| h.resources.len() > 128)
    {
        return Err("无效关闭记录".into());
    }
    Ok(intent)
}
fn same_target(a: &Host, b: &Host) -> bool {
    a.id == b.id
        && a.ssh == b.ssh
        && a.port == b.port
        && a.server_path == b.server_path
        && a.identity_file == b.identity_file
        && a.auth == b.auth
}
pub(crate) async fn persist(app: &tauri::AppHandle, state: &Connections) -> Result<(), String> {
    let instances = state.owned_instances.lock().await.clone();
    let hosts = state.host_targets.lock().await;
    let mut grouped = std::collections::BTreeMap::<(String, String), Vec<Resource>>::new();
    for ((host, resource), server_id) in instances {
        grouped.entry((host, server_id)).or_default().push(resource);
    }
    let mut intents = Vec::new();
    for ((host, server_id), resources) in grouped {
        let host = hosts.get(&host).cloned().ok_or("缺少关闭记录的主机信息")?;
        intents.push(HostIntent {
            host,
            server_id,
            resources,
        });
    }
    let intent = Intent {
        owner_id: state.owner_id().to_owned(),
        hosts: intents,
    };
    let directory = directory(app)?;
    let _lock = lock(&directory)?;
    write(&directory, &intent)
}
/// Resolve local cleanup or remote reattachment before exposing a connection.
pub(crate) async fn drain(
    app: &tauri::AppHandle,
    state: &Connections,
    host: &Host,
    client: &mut Client,
) -> Result<Vec<Resource>, String> {
    let _admission = state.cleanup_admission.lock().await;
    let adopted = drain_directory(&directory(app)?, host, client, state.owner_id()).await?;
    for resource in &adopted {
        state.owned_instances.lock().await.insert(
            (host.id.clone(), resource.clone()),
            client.server_id().to_owned(),
        );
        match resource {
            Resource::AgentSession(id) => {
                state
                    .turns
                    .lock()
                    .await
                    .insert((host.id.clone(), id.clone()), "open".into());
            }
            Resource::Terminal(id) => {
                state
                    .terminals
                    .lock()
                    .await
                    .insert((host.id.clone(), id.clone()));
            }
        }
    }
    Ok(adopted)
}
async fn drain_directory(
    directory: &Path,
    host: &Host,
    client: &mut Client,
    owner_id: &str,
) -> Result<Vec<Resource>, String> {
    let _lock = lock(directory)?;
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") {
            if paths.len() >= 128 {
                return Err("待关闭记录数量超过限制".into());
            }
            paths.push(path);
        }
    }
    paths.sort();
    let mut adopted = Vec::new();
    for path in paths {
        let mut intent = read(&path)?;
        for item in intent.hosts.iter().filter(|h| same_target(&h.host, host)) {
            if host.ssh.is_some() {
                adopted.extend(
                    client
                        .adopt_resources(
                            item.server_id.clone(),
                            intent.owner_id.clone(),
                            owner_id.to_owned(),
                            item.resources.clone(),
                        )
                        .await
                        .map_err(|e| format!("{e:#}"))?,
                );
            } else {
                client
                    .close_owned_resources(
                        item.server_id.clone(),
                        intent.owner_id.clone(),
                        item.resources.clone(),
                    )
                    .await
                    .map_err(|e| format!("{e:#}"))?;
            }
        }
        intent.hosts.retain(|h| !same_target(&h.host, host));
        write(directory, &intent)?;
    }
    Ok(adopted)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> Host {
        serde_json::from_value(serde_json::json!({"id":"local", "name":"本机", "ssh":null}))
            .unwrap()
    }
    #[test]
    fn quit_intent_is_private_atomic_and_contains_no_authentication_secret() {
        let directory = std::env::temp_dir().join(format!("lw-pending-{}", uuid::Uuid::new_v4()));
        let _lock = lock(&directory).unwrap();
        let intent = Intent {
            owner_id: uuid::Uuid::new_v4().to_string(),
            hosts: vec![HostIntent {
                host: host(),
                server_id: "old-server".into(),
                resources: vec![Resource::AgentSession("session".into())],
            }],
        };
        write(&directory, &intent).unwrap();
        let path = directory.join(format!("{}.json", intent.owner_id));
        assert_eq!(read(&path).unwrap().hosts[0].server_id, "old-server");
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            directory.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(!std::fs::read_to_string(&path).unwrap().contains("password"));
        let mut different = host();
        different.ssh = Some("other-target".into());
        assert!(!same_target(&host(), &different));
        drop(_lock);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn journal_rejects_symlinks_and_mismatched_owner_file() {
        let directory = std::env::temp_dir().join(format!("lw-pending-{}", uuid::Uuid::new_v4()));
        let _lock = lock(&directory).unwrap();
        let outside = directory.join("outside");
        std::fs::write(&outside, "private").unwrap();
        let path = directory.join("alias.json");
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(read(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&Intent {
                owner_id: uuid::Uuid::new_v4().to_string(),
                hosts: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(read(&path).is_err());
        drop(_lock);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn reconnect_closes_local_resources_but_only_adopts_remote_resources() {
        use std::os::unix::fs::PermissionsExt;
        for remote in [false, true] {
            let directory =
                std::env::temp_dir().join(format!("lw-pending-{}", uuid::Uuid::new_v4()));
            let _lock = lock(&directory).unwrap();
            let binary = directory.join("bridge");
            std::fs::write(&binary, r#"#!/usr/bin/env python3
import sys,json,pathlib
base=pathlib.Path(sys.argv[sys.argv.index('--state-dir')+1])
for line in sys.stdin:
    request=json.loads(line)
    with (base/'requests').open('a') as f: f.write(request['method']+'\n')
    if request['method']=='hello': response={'kind':'hello','version':1,'server_id':'fixture','agents':[]}
    elif request['method']=='adopt_resources': response={'kind':'resources_adopted','resources':request['resources']}
    elif request['method']=='close_owned_resources': response={'kind':'resources_closed'}
    else: response={'kind':'error','code':'unexpected','message':'No Open or Send allowed'}
    print(json.dumps(response),flush=True)
"#).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut host = host();
            if remote {
                host.id = "remote".into();
                host.ssh = Some("devbox".into());
            }
            let owner = uuid::Uuid::new_v4().to_string();
            let resource = Resource::AgentSession("session".into());
            write(
                &directory,
                &Intent {
                    owner_id: owner.clone(),
                    hosts: vec![HostIntent {
                        host: host.clone(),
                        server_id: "fixture".into(),
                        resources: vec![resource.clone()],
                    }],
                },
            )
            .unwrap();
            drop(_lock);
            let mut client = Client::local(&binary, Some(&directory)).await.unwrap();
            let adopted = drain_directory(&directory, &host, &mut client, "new-app")
                .await
                .unwrap();
            assert_eq!(adopted, if remote { vec![resource] } else { vec![] });
            assert!(!directory.join(format!("{owner}.json")).exists());
            assert_eq!(
                std::fs::read_to_string(directory.join("requests")).unwrap(),
                if remote {
                    "hello\nadopt_resources\n"
                } else {
                    "hello\nclose_owned_resources\n"
                }
            );
            drop(client);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
