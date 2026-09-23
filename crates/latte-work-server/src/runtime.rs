//! One manager per host, many independently supervised agent processes.
use crate::{
    agents::{AgentAdapter, Output, claude::Claude},
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
    io::{AsyncReadExt, AsyncWriteExt},
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
async fn write(input: &mut tokio::process::ChildStdin, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(5), input.write_all(&bytes)).await??;
    Ok(())
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
    let mut adapter: Box<dyn AgentAdapter> = Box::<Claude>::default();
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
    let child = command
        .spawn()
        .context("无法启动 Claude Code，请在此 Host 安装并登录 claude CLI")?;
    let pid = child.id().context("Claude PID missing")? as i32;
    let mut group = Group { child, pid };
    let mut input = group.child.stdin.take().context("Claude stdin missing")?;
    let mut output = FramedRead::new(
        group.child.stdout.take().context("Claude stdout missing")?,
        LinesCodec::new_with_max_length(1024 * 1024),
    );
    let stderr = group.child.stderr.take().context("Claude stderr missing")?;
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
    write(&mut input, adapter.initialize()).await?;
    let mut initialized = false;
    let mut pending = HashMap::<String, (String, Value)>::new();
    let deadline = tokio::time::sleep(Duration::from_secs(45));
    tokio::pin!(deadline);
    let turn_limit = tokio::time::sleep(Duration::from_secs(24 * 3600));
    tokio::pin!(turn_limit);
    let outcome = loop {
        tokio::select! {
            _=&mut deadline,if !initialized=>break Err(anyhow::anyhow!("Claude 初始化超时（45 秒）")),
            _=&mut turn_limit=>break Err(anyhow::anyhow!("任务超过 24 小时上限")),
            control=controls.recv()=>match control {
                Some(Control::Cancel)=>{let _=killpg(Pid::from_raw(pid),Signal::SIGTERM);break Ok((Status::Stopped,Some("已停止；已执行的文件改动不会撤销。".into())));}
                Some(Control::Approval{id,allow,reply})=>{
                    if let Some((native_id, original))=pending.remove(&id) {
                        let result=write(&mut input,adapter.approval(&native_id,original,allow)).await;
                        if let Err(error)=result {let _=reply.send(Err(error.to_string()));break Err(error);}
                        db(database,|s|{s.event(&session.id,EventKind::ApprovalResolved{request_id:id,allow})?;s.state(&session.id,if pending.is_empty(){Status::Running}else{Status::Waiting},None)})?;
                        let _=reply.send(Ok(()));
                    }else{let _=reply.send(Err("审批已过期或不属于当前执行".into()));}
                }
                None=>break Err(anyhow::anyhow!("Server 控制通道已关闭")),
            },
            line=output.next()=>{
                let message=match line {Some(Ok(line))=>serde_json::from_str::<Value>(&line).context("Claude 返回无效 JSON")?,Some(Err(e))=>break Err(e.into()),None=>break Err(anyhow::anyhow!("Claude 进程退出，未收到任务完成事件；请检查该 Host 的登录状态和 CLI 配置"))};
                let actions=adapter.decode(message)?;
                let mut done=None;
                for action in actions {match action {
                    Output::Initialized=>{if !initialized {initialized=true;write(&mut input,adapter.prompt(text)).await?;}},
                    Output::NativeSession(id)=>{db(database,|s|{let mut current=s.session(&session.id)?;current.native_id=Some(id);s.save(&current)})?;},
                    Output::Event(event)=>{db(database,|s|s.event(&session.id,config.redact_event(event)?))?;},
                    Output::Approval{id,tool,input:original}=>{
                        if pending.len()>=32 {bail!("待审批工具数量超出限制");}
                        let public_id=uuid::Uuid::new_v4().to_string();
                        pending.insert(public_id.clone(),(id,original.clone()));
                        db(database,|s|{s.event(&session.id,config.redact_event(EventKind::Approval{request_id:public_id,tool,input:original})?)?;s.state(&session.id,Status::Waiting,None)})?;
                    },
                    Output::Reply(value)=>write(&mut input,value).await?,
                    Output::Finished{failed,message}=>done=Some((if failed{Status::Failed}else{Status::Completed},message)),
                }}
                if let Some(done)=done {break Ok(done);}
            }
        }
    };
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
