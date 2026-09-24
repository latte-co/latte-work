//! One manager per host, many independently supervised agent processes.
use crate::{
    agents::{self, Action, Input},
    providers::LaunchConfig,
    store::Store,
};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use latte_work_protocol::{EventKind, Session, Status};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Child,
    sync::{mpsc, oneshot},
};
use tokio_util::codec::{FramedRead, LinesCodec};

pub type Database = Arc<Mutex<Store>>;
pub type Runs = Arc<Mutex<HashMap<String, mpsc::Sender<Control>>>>;
pub enum Control {
    Cancel,
    Approval {
        id: String,
        allow: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
}
pub fn db<T>(database: &Database, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    {
        let mut guard = database.lock().map_err(|_| anyhow::anyhow!("存储锁异常"))?;
        f(&mut guard)
    }
}

pub fn launch(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    text: String,
    config: LaunchConfig,
) -> Result<()> {
    let (tx, rx) = mpsc::channel(16);
    runs.lock()
        .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
        .insert(session.id.clone(), tx);
    tokio::spawn(async move {
        let result = run(&database, &binary, &session, &path, &text, rx, &config).await;
        // Remove the old control channel before publishing the terminal state.
        if let Ok(mut map) = runs.lock() {
            map.remove(&session.id);
        }
        let (status, message) = match result {
            Ok((status, message)) => (status, message.map(|text| config.redact(&text))),
            Err(error) => (Status::Failed, Some(config.redact(&error.to_string()))),
        };
        if let Err(error) = db(&database, |s| s.state(&session.id, status, message)) {
            eprintln!("cannot persist terminal state: {error}");
        }
    });
    Ok(())
}
async fn write(input: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> Result<()> {
    if bytes.len() > latte_work_protocol::MAX_FRAME {
        bail!("Agent 输出请求超出限制");
    }
    tokio::time::timeout(Duration::from_secs(5), input.write_all(bytes)).await??;
    Ok(())
}
type Outcome = (Status, Option<String>);
#[derive(Default)]
struct TurnState {
    ready: bool,
    pending: HashMap<String, (String, Value)>,
}
impl TurnState {
    async fn apply(
        &mut self,
        actions: Vec<Action>,
        input: &mut (impl AsyncWrite + Unpin),
        database: &Database,
        session_id: &str,
        config: &LaunchConfig,
    ) -> Result<Option<Outcome>> {
        for action in actions {
            match action {
                Action::Write(bytes) => write(input, &bytes).await?,
                Action::Ready => self.ready = true,
                Action::NativeSession(id) => db(database, |s| {
                    let mut current = s.session(session_id)?;
                    current.native_id = Some(id);
                    s.save(&current)
                })?,
                Action::Event(event) => db(database, |s| {
                    s.event(session_id, config.redact_event(event)?)
                })?,
                Action::Approval {
                    id,
                    tool,
                    input: original,
                } => {
                    if self.pending.len() >= 32 {
                        bail!("待审批工具数量超出限制");
                    }
                    let public_id = uuid::Uuid::new_v4().to_string();
                    self.pending
                        .insert(public_id.clone(), (id, original.clone()));
                    db(database, |s| {
                        s.event(
                            session_id,
                            config.redact_event(EventKind::Approval {
                                request_id: public_id,
                                tool,
                                input: original,
                            })?,
                        )?;
                        s.state(session_id, Status::Waiting, None)
                    })?;
                }
                Action::Finished { failed, message } => {
                    return Ok(Some((
                        if failed {
                            Status::Failed
                        } else {
                            Status::Completed
                        },
                        message,
                    )));
                }
            }
        }
        Ok(None)
    }
}
struct Group {
    child: Child,
    pid: i32,
}
impl Drop for Group {
    fn drop(&mut self) {
        let _ = killpg(Pid::from_raw(self.pid), Signal::SIGKILL);
        let _ = self.child.start_kill();
    }
}
async fn run(
    database: &Database,
    binary: &str,
    session: &Session,
    path: &str,
    text: &str,
    mut controls: mpsc::Receiver<Control>,
    config: &LaunchConfig,
) -> Result<(Status, Option<String>)> {
    let mut adapter = agents::create(&session.agent)?;
    let prepared = adapter.command(binary, path, session.native_id.as_deref(), config)?;
    let mut command = prepared.command;
    let _settings = prepared._settings;
    if let Some(provider) = &config.provider {
        db(database, |s| {
            s.event(
                &session.id,
                EventKind::Notice {
                    text: format!(
                        "Provider：{} · 模型：{}",
                        provider.metadata.name,
                        config.model.as_deref().unwrap_or(&provider.metadata.model)
                    ),
                },
            )
        })?;
    }
    if config.provider.is_none()
        && let Some(model) = &config.model
    {
        db(database, |s| {
            s.event(
                &session.id,
                EventKind::Notice {
                    text: format!("模型：{model}"),
                },
            )
        })?;
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    let child = command.spawn().with_context(|| {
        format!(
            "无法启动 Agent {}，请检查此 Host 的 CLI 安装和登录状态",
            session.agent
        )
    })?;
    let pid = child.id().context("Agent PID missing")? as i32;
    let mut group = Group { child, pid };
    let mut input = group.child.stdin.take().context("Agent stdin missing")?;
    let mut output = FramedRead::new(
        group.child.stdout.take().context("Agent stdout missing")?,
        LinesCodec::new_with_max_length(1024 * 1024),
    );
    let stderr = group.child.stderr.take().context("Agent stderr missing")?;
    // Drain stderr continuously, keep no sensitive stderr in the durable event log.
    let drain = tokio::spawn(async move {
        let mut stderr = stderr;
        let mut buf = [0; 4096];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
        }
    });
    let mut state = TurnState::default();
    let deadline = tokio::time::sleep(Duration::from_secs(45));
    tokio::pin!(deadline);
    let turn_limit = tokio::time::sleep(Duration::from_secs(24 * 3600));
    tokio::pin!(turn_limit);
    // Keep all protocol failures inside this scope so process/stderr cleanup always runs.
    let outcome = async {
        let actions = adapter.advance(Input::Start { prompt: text })?;
        if let Some(done) = state.apply(actions, &mut input, database, &session.id, config).await? {
            return Ok(done);
        }
        loop {
            tokio::select! {
                _=&mut deadline,if !state.ready=>break Err(anyhow::anyhow!("Agent 初始化超时（45 秒）")),
                _=&mut turn_limit=>break Err(anyhow::anyhow!("任务超过 24 小时上限")),
                control=controls.recv()=>match control {
                    Some(Control::Cancel)=>{let _=killpg(Pid::from_raw(pid),Signal::SIGTERM);break Ok((Status::Stopped,Some("已停止；已执行的文件改动不会撤销。".into())));}
                    Some(Control::Approval{id,allow,reply})=>{
                        if let Some((native_id, original))=state.pending.remove(&id) {
                            let result = async {
                                let actions = adapter.advance(Input::Approval { id: &native_id, input: original, allow })?;
                                let done = state.apply(actions, &mut input, database, &session.id, config).await?;
                                db(database,|s|{s.event(&session.id,EventKind::ApprovalResolved{request_id:id,allow})?;s.state(&session.id,if state.pending.is_empty(){Status::Running}else{Status::Waiting},None)})?;
                                Ok::<_, anyhow::Error>(done)
                            }.await;
                            match result {
                                Ok(done) => { let _=reply.send(Ok(())); if let Some(done)=done { break Ok(done); } },
                                Err(error) => { let _=reply.send(Err(error.to_string())); break Err(error); },
                            }
                        }else{let _=reply.send(Err("审批已过期或不属于当前执行".into()));}
                    }
                    None=>break Err(anyhow::anyhow!("Server 控制通道已关闭")),
                },
                line=output.next()=>{
                    let line = match line {
                        Some(line) => line?,
                        None => bail!("Agent 进程退出，未收到任务完成事件；请检查该 Host 的登录状态和 CLI 配置"),
                    };
                    let actions = adapter.advance(Input::Message(&line))?;
                    if let Some(done) = state.apply(actions, &mut input, database, &session.id, config).await? {
                        break Ok(done);
                    }
                }
            }
        }
    }.await;
    drop(input);
    if tokio::time::timeout(Duration::from_secs(2), group.child.wait())
        .await
        .is_err()
    {
        let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
        let _ = group.child.wait().await;
    }
    drain.abort();
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn actions_preserve_wire_bytes_and_ready_never_sends_an_implicit_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let database = Arc::new(Mutex::new(
            Store::open(&dir.path().join("state.sqlite")).unwrap(),
        ));
        let config = LaunchConfig {
            provider: None,
            model: None,
            effort: None,
            settings_dir: dir.path().into(),
        };
        let (mut writer, mut reader) = tokio::io::duplex(1024);
        let mut state = TurnState::default();
        // Deliberately not JSON: Runtime must not encode or interpret an adapter's wire bytes.
        let actions = vec![
            Action::Write(b"first\n".to_vec()),
            Action::Ready,
            Action::Write(b"second\n".to_vec()),
        ];
        assert!(
            state
                .apply(actions, &mut writer, &database, "unused", &config)
                .await
                .unwrap()
                .is_none()
        );
        assert!(state.ready);
        drop(writer);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"first\nsecond\n");
        assert!(
            write(
                &mut tokio::io::sink(),
                &vec![0; latte_work_protocol::MAX_FRAME + 1]
            )
            .await
            .is_err()
        );
    }
}
