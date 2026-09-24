//! A single host daemon; `connect` is a disposable local/SSH byte bridge.
mod agents;
mod files;
mod providers;
mod runtime;
mod store;
mod terminal;
mod upgrade;
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use latte_work_protocol::{AgentInfo, MAX_FRAME, Request, Response, VERSION};
use runtime::{Control, Database, Runs, db};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    os::unix::fs::{FileTypeExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::{UnixListener, UnixStream},
    sync::oneshot,
};
use tokio_util::codec::{FramedRead, LinesCodec};

#[derive(Clone)]
struct Service {
    lifecycle: Arc<upgrade::Lifecycle>,
    terminals: terminal::SharedTerminals,
    database: Database,
    runs: Runs,
    agent_binary: String,
    agent: AgentInfo,
    server_id: String,
    providers: Arc<Mutex<providers::ProviderStore>>,
}
#[tokio::main]
async fn main() {
    if let Err(error) = entry().await {
        eprintln!("latte-work-server: {error:#}");
        std::process::exit(1);
    }
}
async fn entry() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" {
        println!(
            "latte-work-server 0.1.0\nUsage: latte-work-server <serve|connect|connect-local> [--state-dir PATH]\nOne daemon per host user; connect starts it if absent.\nLATTE_WORK_CLAUDE: absolute CLI path override (default auto-detected claude)."
        );
        return Ok(());
    }
    let dir = if args.len() == 3 && args[1] == "--state-dir" {
        PathBuf::from(&args[2])
    } else if args.len() == 1 {
        PathBuf::from(std::env::var_os("HOME").context("HOME missing")?)
            .join(".local/share/latte-work")
    } else {
        bail!("无效参数；使用 --help 查看用法");
    };
    let dir = prepare_dir(&dir)?;
    match args[0].as_str() {
        "serve" => serve(&dir).await,
        "connect" => bridge(&dir).await,
        "connect-local" => match upgrade::connect_local(&dir).await {
            Ok(stream) => forward(stream).await,
            Err(error) => {
                let response = Response::Error {
                    code: "local_upgrade_required".into(),
                    message: error.to_string(),
                };
                let mut bytes = serde_json::to_vec(&response)?;
                bytes.push(b'\n');
                tokio::io::stdout().write_all(&bytes).await?;
                Ok(())
            }
        },
        _ => bail!("未知命令"),
    }
}
fn prepare_dir(dir: &Path) -> Result<PathBuf> {
    if dir.exists() && dir.symlink_metadata()?.file_type().is_symlink() {
        bail!("状态目录不能是符号链接");
    }
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(dir.canonicalize()?)
}
fn lock(dir: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("server.lock"))?;
    file.try_lock().context("此 Host 的 Server 已运行")?;
    Ok(file)
}
async fn bridge(dir: &Path) -> Result<()> {
    forward(connect_socket(dir).await?).await
}
async fn connect_socket(dir: &Path) -> Result<UnixStream> {
    let socket = dir.join("control.sock");
    let stream = match UnixStream::connect(&socket).await {
        Ok(s) => s,
        Err(_) => {
            let mut command = std::process::Command::new(std::env::current_exe()?);
            use std::os::unix::process::CommandExt;
            command
                .arg("serve")
                .arg("--state-dir")
                .arg(dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            let mut daemon = command.spawn().context("无法启动 Host Server")?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                if let Ok(s) = UnixStream::connect(&socket).await {
                    break s;
                }
                if tokio::time::Instant::now() > deadline {
                    bail!("无法连接 Server；请运行 latte-work-server serve 查看诊断");
                }
                // A concurrent bridge may win the singleton lock; still wait for its socket.
                let _ = daemon.try_wait();
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    Ok(stream)
}
async fn forward(stream: UnixStream) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    tokio::select! {result=tokio::io::copy(&mut input,&mut writer)=>{result?;},result=tokio::io::copy(&mut reader,&mut output)=>{result?;}}
    Ok(())
}
async fn serve(dir: &Path) -> Result<()> {
    let _lock = lock(dir)?;
    let socket = dir.join("control.sock");
    if let Ok(metadata) = socket.symlink_metadata() {
        if !metadata.file_type().is_socket() {
            bail!("control.sock 被非 socket 文件占用");
        }
        std::fs::remove_file(&socket)?;
    }
    let database = Arc::new(Mutex::new(store::Store::open(&dir.join("state.sqlite"))?));
    let (agent_binary, agent) = agents::discover().await;
    let service = Service {
        lifecycle: Arc::new(upgrade::Lifecycle::new()?),
        terminals: Arc::new(Mutex::new(terminal::Terminals::default())),
        providers: Arc::new(Mutex::new(providers::ProviderStore::open(dir)?)),
        database,
        runs: Arc::new(Mutex::new(HashMap::new())),
        agent_binary,
        agent,
        server_id: uuid::Uuid::new_v4().to_string(),
    };
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    eprintln!(
        "Latte Work server {} listening at {}",
        service.server_id,
        socket.display()
    );
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            result=listener.accept()=>{let (stream,_)=result?;let service=service.clone();tokio::spawn(async move {if let Err(e)=connection(stream,service).await {eprintln!("client disconnected: {e}");}});},
            _=tokio::signal::ctrl_c()=>break,
        _=terminate.recv()=>break,
        _=service.lifecycle.shutdown.notified()=>break,
        }
    }
    service
        .terminals
        .lock()
        .map_err(|_| anyhow::anyhow!("终端锁异常"))?
        .close_all();
    let controls: Vec<_> = service
        .runs
        .lock()
        .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
        .values()
        .cloned()
        .collect();
    for control in controls {
        let _ = control.send(Control::Cancel).await;
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    std::fs::remove_file(socket)?;
    Ok(())
}
async fn connection(stream: UnixStream, service: Service) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME));
    let mut ready = false;
    while let Some(line) = lines.next().await {
        let line = line?;
        if let Ok(request) = serde_json::from_str::<upgrade::Request>(&line) {
            let response = upgrade::handle(&service, request).await;
            let mut bytes = serde_json::to_vec(&response)?;
            bytes.push(b'\n');
            let written =
                tokio::time::timeout(Duration::from_secs(15), writer.write_all(&bytes)).await;
            if matches!(response, upgrade::Response::UpgradeReady) {
                service.lifecycle.shutdown.notify_one();
            }
            written??;
            continue;
        }
        // Hold admission through dispatch so a Send/CreateTerminal cannot race an idle check.
        let draining = service.lifecycle.draining.read().await;
        let response = if *draining {
            Response::Error {
                code: "server_upgrading".into(),
                message: "本机后台正在更新，请重新连接；任务不会自动重发".into(),
            }
        } else {
            match serde_json::from_str::<Request>(&line) {
                Ok(Request::Hello { version }) => {
                    if version == VERSION {
                        ready = true;
                        Response::Hello {
                            version: VERSION,
                            server_id: service.server_id.clone(),
                            agents: vec![service.agent.clone()],
                        }
                    } else {
                        Response::Error {
                            code: "version_mismatch".into(),
                            message: format!("Server 协议为 {VERSION}，客户端为 {version}"),
                        }
                    }
                }
                Ok(request) if ready => match dispatch(&service, request).await {
                    Ok(response) => response,
                    Err(error) => Response::Error {
                        code: "request_failed".into(),
                        message: error.to_string(),
                    },
                },
                Ok(_) => Response::Error {
                    code: "handshake_required".into(),
                    message: "请先发送 hello".into(),
                },
                Err(error) => Response::Error {
                    code: "invalid_request".into(),
                    message: error.to_string(),
                },
            }
        };
        let mut bytes = serde_json::to_vec(&response)?;
        if bytes.len() > MAX_FRAME {
            bytes = serde_json::to_vec(&Response::Error {
                code: "response_too_large".into(),
                message: "响应超出限制".into(),
            })?;
        }
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(15), writer.write_all(&bytes)).await??;
    }
    Ok(())
}
async fn dispatch(s: &Service, request: Request) -> Result<Response> {
    Ok(match request {
        Request::Hello { .. } => unreachable!(),
        Request::Providers => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .list(),
        Request::Models {
            agent,
            model,
            project_id,
        } => {
            let project = project_id
                .map(|id| db(&s.database, |d| d.project(&id)))
                .transpose()?;
            let mut response = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                .models(&agent, model.as_deref())?;
            if let Response::Models {
                provider: None,
                model_labels,
                ..
            } = &mut response
            {
                *model_labels = agents::model_labels(
                    &agent,
                    project.as_ref().map(|p| std::path::Path::new(&p.path)),
                );
            }
            response
        }
        Request::SaveProvider { provider } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .save(provider)?,
        Request::DeleteProvider { id } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .delete(&id)?,
        Request::BindAgentProvider {
            agent,
            provider_id,
            target,
        } => {
            if let Some(target) = target {
                let snapshot = provider_id
                    .as_deref()
                    .map(|id| {
                        s.providers
                            .lock()
                            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                            .snapshot(&agent, id)
                    })
                    .transpose()?;
                let mut client =
                    latte_work_client::Client::ssh(&target.ssh, &target.server_path).await?;
                let response = client
                    .request(Request::SyncAgentProvider { agent, snapshot })
                    .await?;
                match response {
                    Response::Providers { .. } => response,
                    Response::Error { message, .. } => bail!("远程同步失败：{message}"),
                    _ => bail!("远程 Provider 响应格式不匹配"),
                }
            } else {
                s.providers
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                    .bind(&agent, provider_id)?
            }
        }
        Request::ProvidersForHost { host_id } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .list_for_host(&host_id)?,
        Request::BindHostAgentProvider {
            host_id,
            agent,
            provider_id,
        } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .bind_host(&host_id, &agent, provider_id)?,
        Request::ForgetHostProviders { host_id } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .forget_host(&host_id)?,
        Request::ExportHostAgentProvider { host_id, agent } => {
            let store = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?;
            Response::ProviderSnapshot {
                snapshot: store.snapshot_for_host(&host_id, &agent)?,
                configured: store.host_configured(&host_id),
            }
        }
        Request::ModelsForProvider {
            agent,
            model,
            project_id,
            provider,
        } => {
            let project = project_id
                .map(|id| db(&s.database, |d| d.project(&id)))
                .transpose()?;
            let mut response =
                providers::ProviderStore::models_for_provider(&agent, model.as_deref(), provider)?;
            if let Response::Models {
                provider: None,
                model_labels,
                ..
            } = &mut response
            {
                *model_labels = agents::model_labels(
                    &agent,
                    project.as_ref().map(|p| std::path::Path::new(&p.path)),
                );
            }
            response
        }
        Request::Session { session_id } => Response::Session {
            session: db(&s.database, |d| d.session(&session_id))?,
        },
        Request::SyncAgentProvider { agent, snapshot } => s
            .providers
            .lock()
            .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
            .sync(&agent, snapshot)?,
        Request::WriteTerminal { terminal_id, data } => {
            terminal::write(&s.terminals, &terminal_id, data).await?
        }
        Request::CreateTerminal {
            project_id,
            terminal_id,
            cols,
            rows,
        } => {
            let project = db(&s.database, |d| d.project(&project_id))?;
            let terminals = s.terminals.clone();
            tokio::task::spawn_blocking(move || {
                terminals
                    .lock()
                    .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                    .create(
                        project_id,
                        Path::new(&project.path),
                        terminal_id,
                        cols,
                        rows,
                    )
            })
            .await??
        }
        Request::Terminals { project_id } => {
            db(&s.database, |d| d.project(&project_id))?;
            s.terminals
                .lock()
                .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                .list(&project_id)?
        }
        Request::ReadTerminal { terminal_id, after } => s
            .terminals
            .lock()
            .map_err(|_| anyhow::anyhow!("终端锁异常"))?
            .read(&terminal_id, after)?,
        Request::ResizeTerminal {
            terminal_id,
            cols,
            rows,
        } => s
            .terminals
            .lock()
            .map_err(|_| anyhow::anyhow!("终端锁异常"))?
            .resize(&terminal_id, cols, rows)?,
        Request::CloseTerminal { terminal_id } => s
            .terminals
            .lock()
            .map_err(|_| anyhow::anyhow!("终端锁异常"))?
            .close(&terminal_id),
        Request::Projects => Response::Projects {
            projects: db(&s.database, |d| d.projects())?,
        },
        Request::AddProject { path, name } => Response::Project {
            project: db(&s.database, |d| {
                d.add_named_project(Path::new(&path), name.as_deref())
            })?,
        },
        Request::RenameProject { project_id, name } => Response::Project {
            project: db(&s.database, |d| d.rename_project(&project_id, &name))?,
        },
        Request::RemoveProject { project_id } => {
            db(&s.database, |d| d.remove_project(&project_id))?;
            Response::Projects {
                projects: db(&s.database, |d| d.projects())?,
            }
        }
        Request::BrowseDirectories { path } => {
            tokio::task::spawn_blocking(move || files::browse_directories(path.as_deref()))
                .await??
        }
        Request::Sessions { project_id } => Response::Sessions {
            sessions: db(&s.database, |d| d.sessions(&project_id))?,
        },
        Request::PinnedSessions => Response::Sessions {
            sessions: db(&s.database, |d| d.pinned_sessions())?,
        },
        Request::RenameSession { session_id, title } => Response::Session {
            session: db(&s.database, |d| d.rename_session(&session_id, &title))?,
        },
        Request::PinSession { session_id, pinned } => Response::Session {
            session: db(&s.database, |d| d.pin_session(&session_id, pinned))?,
        },
        Request::MarkSessionUnread { session_id, unread } => Response::Session {
            session: db(&s.database, |d| d.mark_session_unread(&session_id, unread))?,
        },
        Request::ArchiveSession {
            session_id,
            archived,
        } => Response::Session {
            session: db(&s.database, |d| d.archive_session(&session_id, archived))?,
        },
        Request::CreateSession { project_id, agent } => {
            if agent != s.agent.id {
                bail!("此 Agent 尚未实现");
            }
            Response::Session {
                session: db(&s.database, |d| d.create_session(project_id, agent))?,
            }
        }
        Request::Send {
            provider,
            session_id,
            request_id,
            text,
            model,
            effort,
        } => {
            let fingerprint = providers::turn_fingerprint(provider.as_ref())?;
            if db(&s.database, |d| {
                d.already_accepted(
                    &session_id,
                    &request_id,
                    &text,
                    model.as_deref(),
                    effort,
                    fingerprint.as_deref(),
                )
            })? {
                return Ok(Response::Accepted { duplicate: true });
            }
            if !s.agent.available {
                bail!(
                    "{} CLI 不可用；请在此 Host 安装并登录后重启 Server",
                    s.agent.name
                );
            }
            let agent_id = db(&s.database, |d| Ok(d.session(&session_id)?.agent))?;
            if agent_id != s.agent.id {
                bail!("此 Agent 尚未实现：{agent_id}");
            }
            let mut launch_config = s
                .providers
                .lock()
                .map_err(|_| anyhow::anyhow!("Provider 配置锁异常"))?
                .turn_config(&agent_id, model.as_deref(), provider)?;
            let selected_model = launch_config.model.as_deref().or_else(|| {
                launch_config
                    .provider
                    .as_ref()
                    .map(|p| p.metadata.model.as_str())
            });
            if effort.is_some_and(|level| {
                !agents::effort_levels(&agent_id, selected_model).contains(&level)
            }) {
                bail!("此 Agent 不支持所选思考强度");
            }
            launch_config.effort = effort;
            let (new, session, path) = db(&s.database, |d| {
                let session = d.session(&session_id)?;
                let path = d.project(&session.project_id)?.path;
                let new = d.begin(
                    &session_id,
                    &request_id,
                    &text,
                    model.as_deref(),
                    effort,
                    fingerprint.as_deref(),
                )?;
                Ok((new, session, path))
            })?;
            if new {
                runtime::launch(
                    s.database.clone(),
                    s.runs.clone(),
                    s.agent_binary.clone(),
                    session,
                    path,
                    text,
                    launch_config,
                )?;
            }
            Response::Accepted { duplicate: !new }
        }
        Request::Poll { session_id, after } => db(&s.database, |d| {
            let session = d.session(&session_id)?;
            let (events, has_more) = d.events(&session_id, after)?;
            Ok(Response::Events {
                session,
                events,
                has_more,
            })
        })?,
        Request::Approve {
            session_id,
            request_id,
            allow,
        } => {
            let control = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .get(&session_id)
                .cloned()
                .context("此会话没有运行中的任务")?;
            let (reply, receive) = oneshot::channel();
            control
                .send(Control::Approval {
                    id: request_id,
                    allow,
                    reply,
                })
                .await?;
            tokio::time::timeout(Duration::from_secs(10), receive)
                .await??
                .map_err(anyhow::Error::msg)?;
            Response::Ok
        }
        Request::Cancel { session_id } => {
            let control = s
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .get(&session_id)
                .cloned()
                .context("此会话没有运行中的任务")?;
            control.send(Control::Cancel).await?;
            Response::Ok
        }
        Request::Files { project_id, path } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            Response::Files {
                entries: files::list(Path::new(&p.path), &path)?,
            }
        }
        Request::ReadFile { project_id, path } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (text, truncated) = files::read(Path::new(&p.path), &path).await?;
            Response::Content { text, truncated }
        }
        Request::Diff { project_id } => {
            let p = db(&s.database, |d| d.project(&project_id))?;
            let (text, truncated) = files::diff(Path::new(&p.path)).await?;
            Response::Content { text, truncated }
        }
    })
}
