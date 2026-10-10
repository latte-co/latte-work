//! One manager per host, many independently supervised agent processes.
use crate::{
    agents::{self, Action, Input},
    providers::LaunchConfig,
    store::Store,
};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use latte_work_protocol::{EventKind, Response, Session, Status};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Child,
    sync::{mpsc, oneshot},
};
use tokio_util::codec::{FramedRead, LinesCodec};

pub type Database = Arc<Mutex<Store>>;
pub type Runs = Arc<Mutex<HashMap<String, Run>>>;
#[derive(Clone)]
pub struct Run {
    pub control: mpsc::Sender<Control>,
    pub safe_to_close: Arc<AtomicBool>,
    pub session_open: Arc<AtomicBool>,
}
pub struct SendTurn {
    pub request_id: String,
    pub text: String,
    pub model: Option<String>,
    pub fingerprint: Option<String>,
    pub config: LaunchConfig,
}
pub enum Control {
    Open {
        config: LaunchConfig,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Interrupt {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Send {
        turn: SendTurn,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    Cancel {
        reply: Option<oneshot::Sender<Result<(), String>>>,
        only_if_idle: bool,
    },
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

/// Attach live process evidence to all session projections, never to the database.
pub fn project_session_state(runs: &Runs, response: &mut Response) -> Result<()> {
    let map = runs.lock().map_err(|_| anyhow::anyhow!("执行状态锁异常"))?;
    let project = |session: &mut Session| {
        let run = map.get(&session.id).filter(|run| !run.control.is_closed());
        session.agent_session_open =
            Some(run.is_some_and(|run| run.session_open.load(Ordering::SeqCst)));
        session.agent_session_busy = Some(
            run.is_some_and(|run| !run.safe_to_close.load(Ordering::SeqCst))
                || session.status.active(),
        );
    };
    match response {
        Response::Session { session }
        | Response::Events { session, .. }
        | Response::History { session, .. } => project(session),
        Response::Sessions { sessions } => sessions.iter_mut().for_each(project),
        Response::RecentSessions { sessions, .. } => sessions
            .iter_mut()
            .for_each(|entry| project(&mut entry.session)),
        _ => {}
    }
    Ok(())
}

/// Session actors serialize admission, native output and cancellation. Persist the
/// request before writing it, but never recreate a process merely because a turn ended.
pub async fn submit(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    turn: SendTurn,
) -> Result<bool> {
    let control = control_for(database, runs, binary, session, path)?;
    let (reply, receive) = oneshot::channel();
    control
        .try_send(Control::Send { turn, reply })
        .context("会话正在停止或请求队列已满，请重试；消息不会自动重发")?;
    tokio::time::timeout(Duration::from_secs(10), receive)
        .await
        .context("会话接收超时，请核对请求状态；消息不会自动重发")??
        .map_err(anyhow::Error::msg)
}
fn control_for(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
) -> Result<mpsc::Sender<Control>> {
    let mut map = runs.lock().map_err(|_| anyhow::anyhow!("执行状态锁异常"))?;
    if let Some(run) = map.get(&session.id) {
        Ok(run.control.clone())
    } else {
        if map.len() >= 64 {
            bail!("保留中的 Agent 会话已达 64 个，请关闭不再使用的会话或退出 App 后重试");
        }
        let (tx, rx) = mpsc::channel(16);
        let safe_to_close = Arc::new(AtomicBool::new(false));
        let session_open = Arc::new(AtomicBool::new(false));
        map.insert(
            session.id.clone(),
            Run {
                control: tx.clone(),
                safe_to_close: safe_to_close.clone(),
                session_open: session_open.clone(),
            },
        );
        tokio::spawn(actor(
            database,
            runs.clone(),
            binary,
            session,
            path,
            rx,
            safe_to_close,
            session_open,
        ));
        Ok(tx)
    }
}
pub async fn open(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    config: LaunchConfig,
) -> Result<()> {
    let control = control_for(database, runs, binary, session, path)?;
    let (reply, receive) = oneshot::channel();
    control
        .try_send(Control::Open { config, reply })
        .context("会话请求队列已满或正在关闭，请重试")?;
    tokio::time::timeout(Duration::from_secs(20), receive)
        .await
        .context("打开 Agent 会话超时，请重试")??
        .map_err(anyhow::Error::msg)
}
pub async fn close(database: &Database, runs: &Runs, id: &str, only_if_idle: bool) -> Result<()> {
    db(database, |s| s.session(id))?;
    let control = runs
        .lock()
        .map_err(|_| anyhow::anyhow!("执行状态锁异常"))?
        .get(id)
        .map(|r| r.control.clone());
    if let Some(control) = control {
        let (reply, receive) = oneshot::channel();
        control
            .send(Control::Cancel {
                reply: Some(reply),
                only_if_idle,
            })
            .await?;
        tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .context("关闭 Agent 会话超时")??
            .map_err(anyhow::Error::msg)?;
    }
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
                Action::SourceUsed { id, name } => {
                    db(database, |s| s.observe_tool(session_id, &id, &name))?
                }
                Action::Commands(_) => bail!("执行中的 Agent 返回了意外的命令目录"),
                Action::Write(bytes) => write(input, &bytes).await?,
                Action::Ready => self.ready = true,
                Action::Interrupted => {}
                Action::TurnStarted => db(database, |s| {
                    if !s.session(session_id)?.status.active() {
                        s.state(session_id, Status::Running, None)?;
                    }
                    Ok(())
                })?,
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
                    tool_use_id,
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
                                tool_use_id,
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
type Output = FramedRead<tokio::process::ChildStdout, LinesCodec>;
struct Process {
    adapter: Box<dyn agents::AgentAdapter>,
    group: Group,
    input: tokio::process::ChildStdin,
    output: Output,
    drain: tokio::task::JoinHandle<()>,
    _settings: Option<tempfile::NamedTempFile>,
    state: TurnState,
    session_open: Arc<AtomicBool>,
    config: LaunchConfig,
    path: String,
    turn_active: bool,
    stopping: bool,
    interrupt_sent: bool,
    stop_reply: Option<oneshot::Sender<Result<(), String>>>,
    init_deadline: tokio::time::Instant,
    turn_deadline: tokio::time::Instant,
}
impl Drop for Process {
    fn drop(&mut self) {
        self.session_open.store(false, Ordering::SeqCst);
        self.drain.abort();
    }
}
impl Process {
    fn spawn(
        binary: &str,
        session: &Session,
        path: &str,
        config: LaunchConfig,
        session_open: Arc<AtomicBool>,
    ) -> Result<Self> {
        let mut adapter = agents::create(&session.agent)?;
        let prepared = adapter.command(binary, path, session.native_id.as_deref(), &config)?;
        let mut command = prepared.command;
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
        let input = group.child.stdin.take().context("Agent stdin missing")?;
        let output = FramedRead::new(
            group.child.stdout.take().context("Agent stdout missing")?,
            LinesCodec::new_with_max_length(1024 * 1024),
        );
        let mut stderr = group.child.stderr.take().context("Agent stderr missing")?;
        let drain = tokio::spawn(async move {
            let mut buf = [0; 4096];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
            }
        });
        Ok(Self {
            adapter,
            group,
            input,
            output,
            drain,
            _settings: prepared._settings,
            state: TurnState::default(),
            session_open,
            config,
            path: path.into(),
            turn_active: false,
            stopping: false,
            interrupt_sent: false,
            stop_reply: None,
            init_deadline: tokio::time::Instant::now() + Duration::from_secs(18),
            turn_deadline: tokio::time::Instant::now() + Duration::from_secs(24 * 3600),
        })
    }
    async fn apply(&mut self, actions: Vec<Action>, database: &Database, id: &str) -> Result<()> {
        let became_ready = actions.iter().any(|a| matches!(a, Action::Ready));
        if actions.iter().any(|a| matches!(a, Action::TurnStarted)) {
            self.turn_active = true;
            self.turn_deadline = tokio::time::Instant::now() + Duration::from_secs(24 * 3600);
        }
        if actions.iter().any(|a| matches!(a, Action::Interrupted))
            || (self.stopping && actions.iter().any(|a| matches!(a, Action::Finished { .. })))
        {
            // A CLI may emit the interrupted result before its control acknowledgement.
            self.state.pending.clear();
        }
        if let Some((status, message)) = self
            .state
            .apply(actions, &mut self.input, database, id, &self.config)
            .await?
        {
            if !self.state.pending.is_empty() {
                bail!("Agent 在审批完成前结束了本轮任务");
            }
            self.turn_active = false;
            let (status, message) = if self.stopping {
                (
                    Status::Stopped,
                    Some("已停止；已执行的文件改动不会撤销。".into()),
                )
            } else {
                (status, message.map(|s| self.config.redact(&s)))
            };
            finish_turn(
                database,
                id,
                &self.path,
                status != Status::Completed,
                !self.adapter.can_reconfigure(),
            )
            .await?;
            db(database, |s| s.state(id, status, message))?;
            self.stopping = false;
            self.interrupt_sent = false;
            if let Some(reply) = self.stop_reply.take() {
                let _ = reply.send(Ok(()));
            }
        }
        if became_ready && self.stopping && !self.interrupt_sent {
            self.interrupt_sent = true;
            let actions = self.adapter.advance(Input::Interrupt)?;
            self.state
                .apply(actions, &mut self.input, database, id, &self.config)
                .await?;
        }
        self.session_open.store(self.state.ready, Ordering::SeqCst);
        Ok(())
    }
    async fn close(&mut self) {
        self.session_open.store(false, Ordering::SeqCst);
        // Closing stdin alone lets some CLI versions wait indefinitely for background work.
        // Explicit stop/shutdown terminates and reaps the entire owned process group.
        let _ = killpg(Pid::from_raw(self.group.pid), Signal::SIGTERM);
        if tokio::time::timeout(Duration::from_secs(2), self.group.child.wait())
            .await
            .is_err()
        {
            let _ = killpg(Pid::from_raw(self.group.pid), Signal::SIGKILL);
            let _ = self.group.child.wait().await;
        }
        // Reap descendants even if the parent exited before them.
        let _ = killpg(Pid::from_raw(self.group.pid), Signal::SIGKILL);
        self.drain.abort();
    }
}
async fn finish_turn(
    database: &Database,
    id: &str,
    path: &str,
    interrupted: bool,
    background_pending: bool,
) -> Result<()> {
    if let Some((request_id, before)) = db(database, |s| s.pending_turn(id))? {
        let after = crate::task_changes::Snapshot::capture(std::path::Path::new(path))
            .await
            .unwrap_or_else(|e| crate::task_changes::Snapshot::unavailable(e.to_string()));
        let turn = crate::task_changes::FrozenTurn::freeze(
            request_id.clone(),
            before,
            after,
            interrupted,
            background_pending,
        )
        .await;
        let turn = match turn {
            Ok(turn) => turn,
            Err(error) => {
                crate::task_changes::FrozenTurn::freeze(
                    request_id,
                    crate::task_changes::Snapshot::unavailable(error.to_string()),
                    crate::task_changes::Snapshot::unavailable(error.to_string()),
                    interrupted,
                    background_pending,
                )
                .await?
            }
        };
        db(database, |s| s.finish_turn(id, &turn))?;
    }
    Ok(())
}
fn same_config(a: &LaunchConfig, b: &LaunchConfig) -> bool {
    a.model == b.model
        && a.effort == b.effort
        && a.permission_mode == b.permission_mode
        && match (&a.provider, &b.provider) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                a.credential == b.credential
                    && a.metadata.base_url == b.metadata.base_url
                    && a.metadata.protocol == b.metadata.protocol
                    && a.metadata.auth == b.metadata.auth
                    && a.metadata.model == b.metadata.model
            }
            _ => false,
        }
}
#[allow(clippy::too_many_arguments)]
async fn accept_turn(
    process: &mut Option<Process>,
    database: &Database,
    binary: &str,
    session: &Session,
    path: &str,
    turn: SendTurn,
    session_open: &Arc<AtomicBool>,
) -> Result<bool> {
    let config = turn.config.clone();
    if db(database, |s| {
        s.already_accepted(
            &session.id,
            &turn.request_id,
            &turn.text,
            turn.model.as_deref(),
            config.effort,
            turn.fingerprint.as_deref(),
            config.permission_mode.as_deref(),
        )
    })? {
        return Ok(false);
    }
    if db(database, |s| Ok(s.session(&session.id)?.status.active()))? {
        bail!("会话已有运行中的任务");
    }
    if process.as_ref().is_some_and(|p| !p.state.ready) {
        bail!("Agent 会话正在恢复，请稍后重试；消息未发送");
    }
    if let Some(current) = process.as_mut()
        && !same_config(&current.config, &config)
    {
        if !current.adapter.can_reconfigure() {
            bail!(
                "此会话仍有后台 Agent 或待处理的回复；请先在会话菜单中关闭，再更换模型、Provider、权限或思考强度。当前任务未被中断"
            );
        }
        current.close().await;
        *process = None;
    }
    db(database, |s| {
        s.begin(
            &session.id,
            &turn.request_id,
            &turn.text,
            turn.model.as_deref(),
            config.effort,
            turn.fingerprint.as_deref(),
            config.permission_mode.as_deref(),
        )
    })?;
    // After durable admission, all failures become explicit terminal events. The
    // accepted request ID still reconciles a lost transport response without replay.
    let result = async {
        let baseline = crate::task_changes::Snapshot::capture(std::path::Path::new(path))
            .await
            .unwrap_or_else(|e| crate::task_changes::Snapshot::unavailable(e.to_string()));
        db(database, |s| {
            s.save_turn_baseline(&session.id, &turn.request_id, &baseline)
        })?;
        if db(database, |s| s.baseline(&session.id))?.is_none() {
            let task_baseline = if db(database, |s| s.first_request(&session.id))? {
                baseline
            } else {
                crate::task_changes::Snapshot::unavailable(
                    "此历史任务没有记录文件基线，请查看工作区改动".into(),
                )
            };
            db(database, |s| s.save_baseline(&session.id, &task_baseline))?;
        }
        if process.is_none() {
            let current = db(database, |s| s.session(&session.id))?;
            *process = Some(Process::spawn(
                binary,
                &current,
                path,
                turn.config,
                session_open.clone(),
            )?);
        }
        let p = process.as_mut().context("Agent process missing")?;
        p.turn_active = true;
        p.turn_deadline = tokio::time::Instant::now() + Duration::from_secs(24 * 3600);
        let notice = if let Some(provider) = &p.config.provider {
            Some(format!(
                "Provider：{} · 模型：{}",
                provider.metadata.name,
                p.config
                    .model
                    .as_deref()
                    .unwrap_or(&provider.metadata.model)
            ))
        } else {
            p.config.model.as_ref().map(|m| format!("模型：{m}"))
        };
        if let Some(text) = notice {
            db(database, |s| {
                s.event(&session.id, EventKind::Notice { text })
            })?;
        }
        let actions = p.adapter.advance(Input::Start { prompt: &turn.text })?;
        p.apply(actions, database, &session.id).await
    }
    .await;
    if let Err(error) = result {
        let message = if let Some(p) = process.as_mut() {
            let message = p.config.redact(&error.to_string());
            p.close().await;
            message
        } else {
            config.redact(&error.to_string())
        };
        *process = None;
        finish_turn(database, &session.id, path, true, false).await?;
        db(database, |s| {
            s.end_subagents(&session.id, latte_work_protocol::SubagentStatus::Unknown)?;
            s.state(&session.id, Status::Failed, Some(message))
        })?;
    }
    Ok(true)
}
#[allow(clippy::too_many_arguments)]
async fn actor(
    database: Database,
    runs: Runs,
    binary: String,
    session: Session,
    path: String,
    mut controls: mpsc::Receiver<Control>,
    safe_to_close: Arc<AtomicBool>,
    session_open: Arc<AtomicBool>,
) {
    let mut process: Option<Process> = None;
    let mut opening: Vec<oneshot::Sender<Result<(), String>>> = Vec::new();
    loop {
        let init_deadline = process
            .as_ref()
            .filter(|p| !p.state.ready)
            .map(|p| p.init_deadline);
        let turn_deadline = process
            .as_ref()
            .filter(|p| p.turn_active)
            .map(|p| p.turn_deadline);
        let result: Result<()> = tokio::select! {
            control = controls.recv() => match control {
                Some(Control::Open { config, reply }) => {
                    let result = async {
                        if process.is_none() {
                            let current = db(&database, |s| s.session(&session.id))?;
                            let mut p = Process::spawn(&binary, &current, &path, config, session_open.clone())?;
                            let actions = p.adapter.advance(Input::Open)?;
                            p.apply(actions, &database, &session.id).await?;
                            process = Some(p);
                        }
                        Ok::<_, anyhow::Error>(())
                    }
                    .await;
                    match result {
                        Ok(()) if process.as_ref().is_some_and(|p| p.state.ready) => {
                            let _ = reply.send(Ok(()));
                        }
                        Ok(()) => opening.push(reply),
                        Err(error) => {
                            let _ = reply.send(Err(error.to_string()));
                        }
                    }
                    Ok(())
                }
                Some(Control::Interrupt { reply }) => {
                    if let Some(p) = process.as_mut().filter(|p| p.turn_active) {
                        if p.stopping {
                            let _ = reply.send(Err("任务正在停止".into()));
                            Ok(())
                        } else {
                            p.stopping = true;
                            p.stop_reply = Some(reply);
                            p.turn_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                            if !p.state.ready {
                                Ok(())
                            } else {
                                p.interrupt_sent = true;
                                match p.adapter.advance(Input::Interrupt) {
                                    Ok(actions) => p.apply(actions, &database, &session.id).await,
                                    Err(error) => Err(error),
                                }
                            }
                        }
                    } else {
                        let _ = reply.send(Ok(()));
                        Ok(())
                    }
                }
                Some(Control::Send { turn, reply }) => {
                    safe_to_close.store(false, Ordering::SeqCst);
                    let result = accept_turn(&mut process, &database, &binary, &session, &path, turn, &session_open).await;
                    let _ = reply.send(result.map_err(|e| e.to_string()));
                    Ok(())
                }
                Some(Control::Cancel { reply, only_if_idle }) => {
                    if only_if_idle && process.as_ref().is_some_and(|p| p.turn_active || !p.state.pending.is_empty() || !p.adapter.can_reconfigure()) {
                        if let Some(reply) = reply { let _ = reply.send(Err("会话有运行任务、审批或后台任务，请确认后关闭".into())); }
                        continue;
                    }
                    if let Some(p) = process.as_mut() {
                        p.close().await;
                    }
                    process = None;
                    if let Err(error) = finish_turn(&database, &session.id, &path, true, false).await {
                        eprintln!("cannot freeze stopped turn: {error}");
                    }
                    // Preserve completed history when merely closing an idle runtime.
                    let result = db(&database, |s| {
                        s.end_subagents(&session.id, latte_work_protocol::SubagentStatus::Stopped)?;
                        if s.session(&session.id)?.status.active() {
                            s.state(
                                &session.id,
                                Status::Stopped,
                                Some("已停止；已执行的文件改动不会撤销。".into()),
                            )?;
                        }
                        Ok(())
                    });
                    if let Ok(mut map) = runs.lock() {
                        map.remove(&session.id);
                    }
                    if result.is_ok()
                        && let Some(reply) = reply
                    {
                        let _ = reply.send(Ok(()));
                    }
                    break;
                }
                Some(Control::Approval { id, allow, reply }) => {
                    let valid = process
                        .as_ref()
                        .is_some_and(|p| p.state.pending.contains_key(&id));
                    if !valid {
                        let _ = reply.send(Err("审批已过期或不属于当前执行".into()));
                        Ok(())
                    } else {
                        let result = async {
                            let p = process.as_mut().context("此会话没有运行中的任务")?;
                            let (native_id, original) = p
                                .state
                                .pending
                                .remove(&id)
                                .context("审批已过期或不属于当前执行")?;
                            let actions = p.adapter.advance(Input::Approval {
                                id: &native_id,
                                input: original,
                                allow,
                            })?;
                            p.apply(actions, &database, &session.id).await?;
                            db(&database, |s| {
                                s.event(
                                    &session.id,
                                    EventKind::ApprovalResolved {
                                        request_id: id,
                                        allow,
                                    },
                                )?;
                                s.state(
                                    &session.id,
                                    if !p.state.pending.is_empty() {
                                        Status::Waiting
                                    } else if p.turn_active {
                                        Status::Running
                                    } else {
                                        Status::Completed
                                    },
                                    None,
                                )
                            })
                        }
                        .await;
                        let _ = reply.send(result.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                        result
                    }
                }
                None => break,
            },
            line = async { match process.as_mut() { Some(p) => p.output.next().await, None => std::future::pending().await } } => {
                async {
                    let p = process.as_mut().context("Agent process missing")?;
                    let line = line.context("Agent 进程意外退出；会话历史已保留，后台任务状态无法恢复")??;
                    let actions = p.adapter.advance(Input::Message(&line))?;
                    p.apply(actions, &database, &session.id).await
                }.await
            },
            _ = deadline(init_deadline) => Err(anyhow::anyhow!("Agent 初始化超时（18 秒）")),
            _ = deadline(turn_deadline) => Err(anyhow::anyhow!("任务超过 24 小时上限")),
        };
        if let Err(error) = result {
            let recovery = process
                .as_ref()
                .filter(|p| p.state.ready)
                .map(|p| p.config.clone());
            let message = if let Some(p) = process.as_mut() {
                let text = p.config.redact(&error.to_string());
                if let Some(reply) = p.stop_reply.take() {
                    let _ = reply.send(Err(text.clone()));
                }
                p.close().await;
                text
            } else {
                error.to_string()
            };
            process = None;
            if let Err(error) = finish_turn(&database, &session.id, &path, true, false).await {
                eprintln!("cannot freeze failed turn: {error}");
            }
            if let Err(e) = db(&database, |s| {
                s.end_subagents(&session.id, latte_work_protocol::SubagentStatus::Unknown)?;
                s.state(&session.id, Status::Failed, Some(message))
            }) {
                eprintln!("cannot persist terminal state: {e}");
            }
            if let Some(config) = recovery {
                let restore = async {
                    let current = db(&database, |s| s.session(&session.id))?;
                    let mut p =
                        Process::spawn(&binary, &current, &path, config, session_open.clone())?;
                    let actions = p.adapter.advance(Input::Open)?;
                    p.apply(actions, &database, &session.id).await?;
                    Ok::<_, anyhow::Error>(p)
                }
                .await;
                if let Ok(p) = restore {
                    process = Some(p);
                }
            }
        }
        if process.as_ref().is_some_and(|p| p.state.ready) {
            for reply in opening.drain(..) {
                let _ = reply.send(Ok(()));
            }
        } else if process.is_none() {
            for reply in opening.drain(..) {
                let _ = reply.send(Err("Agent 会话未能打开，请重试".into()));
            }
        }
        safe_to_close.store(
            process
                .as_ref()
                .is_none_or(|p| p.state.pending.is_empty() && p.adapter.can_reconfigure()),
            Ordering::SeqCst,
        );
    }
    if let Some(p) = process.as_mut() {
        p.close().await;
    }
}
async fn deadline(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// A bounded metadata-only launch, sharing supervision but never storing or sending a turn.
pub async fn commands(
    binary: &str,
    agent: &str,
    path: &str,
    config: &LaunchConfig,
) -> Result<Vec<latte_work_protocol::AgentSlashCommand>> {
    let mut adapter = agents::create(agent)?;
    let start = adapter.advance(Input::DiscoverCommands)?;
    let mut prepared = adapter.command(binary, path, None, config)?;
    let child = prepared
        .command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()
        .context("无法启动 Agent 读取命令列表")?;
    let pid = child.id().context("Agent PID missing")? as i32;
    let mut group = Group { child, pid };
    let mut input = group.child.stdin.take().context("Agent stdin missing")?;
    let mut output = FramedRead::new(
        group.child.stdout.take().context("Agent stdout missing")?,
        LinesCodec::new_with_max_length(1024 * 1024),
    );
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        for action in start {
            match action {
                Action::Write(bytes) => write(&mut input, &bytes).await?,
                _ => bail!("Agent 不支持命令发现"),
            }
        }
        for _ in 0..128 {
            let line = output
                .next()
                .await
                .context("Agent 在返回命令列表前退出")??;
            for action in adapter.advance(Input::Message(&line))? {
                match action {
                    Action::Commands(commands) => return Ok(commands),
                    // Discovery may reject control requests, but never approve tools.
                    Action::Write(bytes) => write(&mut input, &bytes).await?,
                    _ => bail!("命令发现期间 Agent 请求执行任务"),
                }
            }
        }
        bail!("Agent 命令发现消息超出限制")
    })
    .await;
    let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    let _ = group.child.wait().await;
    result.context("读取 Agent 命令超时，请重试")?
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
            permission_mode: None,
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
