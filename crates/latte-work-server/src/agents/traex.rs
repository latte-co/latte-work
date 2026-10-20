//! Traex app-server v2 JSON-RPC over line-framed stdio.
//! Contract: `traex app-server generate-json-schema` (0.210.1-alpha.3).
use super::{Action, AgentAdapter, AgentCommand, Input};
use crate::providers::LaunchConfig;
use anyhow::{Context, Result, bail};
use latte_work_protocol::{EventKind, ExecutionPhase, QuestionOption, UserQuestion};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
#[path = "traex_metadata.rs"]
mod metadata;
#[path = "traex_provider.rs"]
mod provider;
pub(crate) use metadata::{ModelSelection, models, validate_selection};
pub(super) use metadata::{discover, permission_modes};

#[derive(Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Fresh,
    Initializing,
    Opening,
    Ready,
    Starting,
    Running,
}
struct PendingRequest {
    method: &'static str,
    interrupt_turn: Option<String>,
    queued_input: Option<(String, String)>,
}
#[derive(Default)]
pub struct Traex {
    phase: Phase,
    discovering: bool,
    cwd: String,
    resume: Option<String>,
    thread: Option<String>,
    turn: Option<String>,
    completed_turn: Option<String>,
    completed_success: bool,
    steered: HashSet<String>,
    early_completions: HashMap<String, Value>,
    title: Option<String>,
    pending_prompt: Option<String>,
    config: Option<LaunchConfig>,
    model_provider: Option<String>,
    counter: u64,
    pending: HashMap<String, PendingRequest>,
    approvals: HashMap<String, &'static str>,
    streamed: HashSet<String>,
    tools: HashSet<String>,
    children: HashSet<String>,
    interrupt_requested: bool,
    rename: Option<String>,
}
fn write(value: Value) -> Result<Action> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    Ok(Action::Write(bytes))
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .with_context(|| format!("Traex 缺少有效的 {key}"))
}
impl Traex {
    fn request(&mut self, method: &'static str, params: Value) -> Result<Action> {
        if self.pending.len() >= 32 {
            bail!("Traex 待处理控制请求超出限制");
        }
        self.counter = self
            .counter
            .checked_add(1)
            .context("Traex 请求编号超出限制")?;
        let id = format!("latte-{}", self.counter);
        self.pending.insert(
            id.clone(),
            PendingRequest {
                method,
                queued_input: None,
                interrupt_turn: (method == "turn/interrupt")
                    .then(|| self.turn.clone())
                    .flatten(),
            },
        );
        write(json!({"id":id,"method":method,"params":params}))
    }
    fn initialize(&mut self) -> Result<Vec<Action>> {
        self.phase = Phase::Initializing;
        Ok(vec![self.request(
            "initialize",
            json!({"clientInfo":{"name":"latte-work","version":"0.1.0"}}),
        )?])
    }
    fn steer(&mut self, request_id: &str, prompt: &str) -> Result<Vec<Action>> {
        if self.phase != Phase::Running || self.turn.is_none() {
            bail!("Traex 正在准备本轮任务，消息保留在队列，请稍后再发送");
        }
        if prompt.trim_start().starts_with('/') {
            bail!("Traex 尚不支持原生命令，消息保留在队列");
        }
        if self.steered.len()
            + self
                .pending
                .values()
                .filter(|p| p.queued_input.is_some())
                .count()
            >= 16
        {
            bail!("Traex 待处理消息已达上限，消息保留在队列");
        }
        let turn = self.turn.clone().expect("checked turn");
        let action = self.request("turn/steer", json!({"threadId":self.thread,"expectedTurnId":turn,"input":[{"type":"text","text":prompt}]}))?;
        self.pending
            .get_mut(&format!("latte-{}", self.counter))
            .expect("inserted request")
            .queued_input = Some((request_id.into(), turn));
        Ok(vec![action])
    }
    fn start(&mut self, prompt: &str) -> Result<Vec<Action>> {
        if prompt.trim_start().starts_with('/') {
            bail!("Traex 尚不支持原生命令，请使用普通消息");
        }
        self.phase = Phase::Starting;
        self.early_completions.clear();
        self.streamed.clear();
        self.tools.clear();
        let config = self.config.as_ref().context("Traex 启动配置缺失")?;
        let mut params = json!({"threadId":self.thread,"input":[{"type":"text","text":prompt}],"model":config.traex_model.as_ref().map(|m| &m.model).or(config.model.as_ref()),"effort":config.effort,"modelProvider":self.model_provider});
        if let Some(selection) = &config.traex_model {
            params["modelBackendVariant"] = json!(selection.backend_variant);
        }
        Ok(vec![self.request("turn/start", params)?])
    }
    fn admit_turn(&mut self, turn: &Value) -> Result<Vec<Action>> {
        let id = field(turn, "id")?.to_owned();
        self.turn = Some(id.clone());
        self.phase = Phase::Running;
        let mut actions = vec![Action::NativeSession(
            self.thread.clone().context("Traex 会话 ID 缺失")?,
        )];
        // Do not trust a completion's ID to admit a turn. Wait for the start
        // response/notification, then replay only the matching buffered result.
        let completion = self.early_completions.remove(&id);
        self.early_completions.clear();
        if let Some(completion) = completion {
            actions.extend(self.notification(&completion)?);
        }
        if std::mem::take(&mut self.interrupt_requested) {
            actions.extend(self.interrupt()?);
        }
        Ok(actions)
    }
    fn interrupt(&mut self) -> Result<Vec<Action>> {
        match self.turn.clone() {
            Some(turn) => Ok(vec![self.request(
                "turn/interrupt",
                json!({"threadId":self.thread,"turnId":turn}),
            )?]),
            None if self.phase == Phase::Starting => {
                self.interrupt_requested = true;
                Ok(vec![])
            }
            None => Ok(vec![Action::Interrupted]),
        }
    }
    fn open_thread(&mut self) -> Result<Vec<Action>> {
        let config = self.config.as_ref().context("Traex 启动配置缺失")?;
        let mut params = json!({"cwd":self.cwd,"model":config.traex_model.as_ref().map(|m| &m.model).or(config.model.as_ref()),"modelProvider":self.model_provider});
        if let Some(selection) = &config.traex_model {
            params["config"] = json!({"model_backend_variant":selection.backend_variant});
        }
        match config.permission_mode.as_deref() {
            Some("default") => {
                params["approvalPolicy"] = json!("on-request");
                params["sandbox"] = json!("workspace-write");
                params["approvalsReviewer"] = json!("user");
            }
            Some("bypass_permissions") => {
                params["approvalPolicy"] = json!("never");
                params["sandbox"] = json!("danger-full-access");
                params["approvalsReviewer"] = json!("user");
            }
            None => {}
            Some(_) => bail!("Traex 不支持所选权限模式"),
        }
        let method = if let Some(resume) = &self.resume {
            params["threadId"] = json!(resume);
            "thread/resume"
        } else {
            "thread/start"
        };
        Ok(vec![self.request(method, params)?])
    }
    fn response(&mut self, message: &Value) -> Result<Vec<Action>> {
        let Some(id) = message["id"].as_str() else {
            return Ok(vec![]);
        };
        let Some(request) = self.pending.remove(id) else {
            return Ok(vec![]);
        };
        let method = request.method;
        if let Some(error) = message.get("error") {
            if let Some((request_id, _)) = request.queued_input {
                return Ok(vec![Action::InputRejected {
                    request_id,
                    message: format!(
                        "Traex 未接收消息：{}",
                        error["message"].as_str().unwrap_or("原生发送请求被拒绝")
                    ),
                }]);
            }
            // Completion can win the race with interrupt processing. Only an
            // explicitly completed, identity-bound turn makes this error obsolete.
            if method == "turn/interrupt"
                && request.interrupt_turn.is_some()
                && request.interrupt_turn == self.completed_turn
            {
                return Ok(vec![Action::Interrupted]);
            }
            if method == "thread/name/set" {
                self.rename = None;
                return Ok(vec![Action::TitleRenamed(Err(error["message"]
                    .as_str()
                    .unwrap_or("Traex 拒绝修改标题")
                    .into()))]);
            }
            bail!(
                "Traex {method} 失败：{}",
                error["message"].as_str().unwrap_or("原生请求失败")
            );
        }
        let result = message.get("result").context("Traex 控制响应缺少 result")?;
        if let Some((request_id, expected)) = request.queued_input {
            if result["turnId"].as_str() != Some(expected.as_str()) {
                bail!("Traex 消息交付返回了不同的 turn，处理状态待确认");
            }
            if self.turn.as_deref() == Some(expected.as_str()) && self.phase == Phase::Running {
                self.steered.insert(request_id);
                return Ok(vec![]);
            }
            if self.completed_turn.as_deref() == Some(expected.as_str()) {
                return Ok(if self.completed_success {
                    vec![Action::InputsConsumed(vec![request_id])]
                } else {
                    vec![]
                });
            }
            bail!("Traex 消息交付所属 turn 已变化，处理状态待确认");
        }
        match method {
            "initialize" => {
                if self.discovering {
                    return Ok(vec![Action::Commands(vec![])]);
                }
                if self.phase != Phase::Initializing {
                    bail!("Traex 初始化状态不一致");
                }
                self.phase = Phase::Opening;
                let mut actions = vec![write(json!({"method":"initialized"}))?];
                if self.config.as_ref().is_some_and(|c| c.provider.is_some()) {
                    actions.extend(self.open_thread()?);
                } else {
                    actions.push(
                        self.request("config/read", json!({"includeLayers":false,"cwd":self.cwd}))?,
                    );
                }
                Ok(actions)
            }
            "config/read" => {
                // Resolve the current CLI provider explicitly on resume rather than
                // retaining the previous turn's App-owned provider from the rollout.
                self.model_provider = Some(
                    result["config"]["model_provider"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .context("Traex 未返回原生 Provider")?
                        .to_owned(),
                );
                if let Some(config) = &mut self.config
                    && config.model.is_none()
                {
                    config.model = result["config"]["model"].as_str().map(str::to_owned);
                    config.traex_model = config.model.as_ref().map(|model| ModelSelection {
                        model: model.clone(),
                        backend_variant: result["config"]["model_backend_variant"]
                            .as_str()
                            .unwrap_or("standard")
                            .into(),
                    });
                }
                self.open_thread()
            }
            "thread/start" | "thread/resume" => {
                let thread = field(&result["thread"], "id")?.to_owned();
                if self.resume.as_ref().is_some_and(|resume| resume != &thread) {
                    bail!("Traex 恢复了不同的会话");
                }
                self.thread = Some(thread);
                self.phase = Phase::Ready;
                // Traex does not persist an empty thread. Keep its ID in the actor
                // until turn admission, so reconfiguration/restart can safely reopen
                // an empty conversation instead of resuming a nonexistent rollout.
                let mut actions = vec![Action::Ready];
                if let Some(title) = self.title.take() {
                    self.rename = Some(title.clone());
                    actions.push(self.request(
                        "thread/name/set",
                        json!({"threadId":self.thread,"name":title}),
                    )?);
                }
                if let Some(prompt) = self.pending_prompt.take() {
                    actions.extend(self.start(&prompt)?);
                }
                Ok(actions)
            }
            "turn/start" => {
                if self.phase == Phase::Starting {
                    self.admit_turn(&result["turn"])
                } else {
                    Ok(vec![])
                }
            }
            // Stop needs native turn/completed too; an RPC ack alone cannot settle a turn.
            "turn/interrupt" => Ok(vec![Action::Interrupted]),
            "thread/name/set" => Ok(self
                .rename
                .take()
                .map(|title| Action::TitleRenamed(Ok(title)))
                .into_iter()
                .collect()),
            _ => bail!("Traex 返回意外控制响应"),
        }
    }
    fn native_request(&mut self, message: &Value) -> Result<Vec<Action>> {
        let params = &message["params"];
        let method = message["method"].as_str().unwrap_or_default();
        if params["threadId"].as_str() != self.thread.as_deref()
            || params["turnId"].as_str() != self.turn.as_deref()
            || self.phase != Phase::Running
        {
            return Ok(vec![write(
                json!({"id":message["id"],"error":{"code":-32602,"message":"Request does not belong to the active Latte turn"}}),
            )?]);
        }
        let original = json!({"id":message["id"],"method":method,"params":params});
        let id = serde_json::to_string(&message["id"])?;
        let tool_use_id = params["itemId"].as_str().map(str::to_owned);
        match method {
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval" => {
                if self.approvals.len() >= 32 || self.approvals.contains_key(&id) {
                    bail!("Traex 审批数量超出限制或原生 ID 重复");
                }
                let (method, tool) = match method {
                    "item/commandExecution/requestApproval" => {
                        ("item/commandExecution/requestApproval", "Bash")
                    }
                    "item/fileChange/requestApproval" => {
                        ("item/fileChange/requestApproval", "FileChange")
                    }
                    _ => ("item/permissions/requestApproval", "Permissions"),
                };
                self.approvals.insert(id.clone(), method);
                let mut input = params.clone();
                if let Some(fields) = input.as_object_mut() {
                    for key in ["threadId", "turnId", "itemId", "startedAtMs"] {
                        fields.remove(key);
                    }
                }
                Ok(vec![Action::Approval {
                    id,
                    tool_use_id,
                    tool: tool.into(),
                    input,
                }])
            }
            "item/tool/requestUserInput" => {
                let questions = questions(params)?;
                Ok(vec![Action::Question {
                    id,
                    tool_use_id,
                    input: original,
                    questions,
                }])
            }
            _ => Ok(vec![write(
                json!({"id":message["id"],"error":{"code":-32601,"message":"Unsupported Traex request in Latte Work"}}),
            )?]),
        }
    }
    fn notification(&mut self, message: &Value) -> Result<Vec<Action>> {
        let params = &message["params"];
        if params["threadId"].as_str() != self.thread.as_deref() {
            return Ok(vec![]);
        }
        let method = message["method"].as_str().unwrap_or_default();
        if method == "thread/name/updated" {
            return Ok(params["threadName"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(|s| Action::NativeName(s.into()))
                .into_iter()
                .collect());
        }
        if method == "turn/started" && matches!(self.phase, Phase::Starting) {
            return self.admit_turn(&params["turn"]);
        }
        if method == "turn/completed" && self.phase == Phase::Starting && self.turn.is_none() {
            let id = field(&params["turn"], "id")?.to_owned();
            if self.early_completions.len() >= 32 && !self.early_completions.contains_key(&id) {
                bail!("Traex 提前完成消息超出限制");
            }
            self.early_completions.insert(id, message.clone());
            return Ok(vec![]);
        }
        if !matches!(self.phase, Phase::Running | Phase::Starting) {
            return Ok(vec![]);
        }
        let turn = if method == "turn/completed" {
            params["turn"]["id"].as_str()
        } else {
            params["turnId"].as_str()
        };
        if turn.is_none() || turn != self.turn.as_deref() {
            return Ok(vec![]);
        }
        match method {
            "item/agentMessage/delta" => {
                let id = field(params, "itemId")?.to_owned();
                if self.streamed.len() >= 4096 && !self.streamed.contains(&id) {
                    bail!("Traex 消息数量超出限制");
                }
                self.streamed.insert(id);
                let text = params["delta"].as_str().context("Traex 文本增量无效")?;
                Ok(vec![
                    Action::Event(EventKind::Progress {
                        phase: ExecutionPhase::Replying,
                    }),
                    Action::Event(EventKind::Text { text: text.into() }),
                ])
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                Ok(vec![Action::Event(EventKind::Progress {
                    phase: ExecutionPhase::Thinking,
                })])
            }
            "item/started" | "item/completed" => {
                self.item(&params["item"], method == "item/completed")
            }
            "turn/completed" => {
                let status = field(&params["turn"], "status")?;
                let failed = match status {
                    "completed" => false,
                    "failed" | "interrupted" => true,
                    _ => bail!("Traex 返回非终态完成消息"),
                };
                self.phase = Phase::Ready;
                self.approvals.clear();
                self.completed_turn = self.turn.take();
                self.completed_success = !failed;
                self.streamed.clear();
                self.tools.clear();
                let message = if failed {
                    Some(
                        params["turn"]["error"]["message"]
                            .as_str()
                            .unwrap_or(if status == "interrupted" {
                                "Traex 已中断"
                            } else {
                                "Traex 执行失败"
                            })
                            .into(),
                    )
                } else {
                    None
                };
                let mut actions = Vec::new();
                if !failed && !self.steered.is_empty() {
                    actions.push(Action::InputsConsumed(self.steered.drain().collect()));
                }
                self.steered.clear();
                actions.push(Action::Finished { failed, message });
                Ok(actions)
            }
            "error" if params["willRetry"] != true => bail!(
                "Traex：{}",
                params["error"]["message"]
                    .as_str()
                    .unwrap_or("原生执行失败")
            ),
            _ => Ok(vec![]),
        }
    }
    fn item(&mut self, item: &Value, completed: bool) -> Result<Vec<Action>> {
        let kind = field(item, "type")?;
        let id = field(item, "id")?.to_owned();
        if kind == "reasoning" {
            return Ok(vec![Action::Event(EventKind::Progress {
                phase: ExecutionPhase::Thinking,
            })]);
        }
        if kind == "agentMessage" {
            return Ok(if completed && !self.streamed.contains(&id) {
                let text = item["text"].as_str().context("Traex 回复无效")?.into();
                if self.streamed.len() >= 4096 {
                    bail!("Traex 消息数量超出限制");
                }
                self.streamed.insert(id);
                vec![Action::Event(EventKind::Text { text })]
            } else {
                vec![]
            });
        }
        let name = match kind {
            "commandExecution" => "Bash".to_owned(),
            "fileChange" => "FileChange".into(),
            "mcpToolCall" => format!(
                "mcp__{}__{}",
                item["server"].as_str().unwrap_or("unknown"),
                item["tool"].as_str().unwrap_or("unknown")
            ),
            "dynamicToolCall" => field(item, "tool")?.into(),
            "webSearch" => "WebSearch".into(),
            "collabAgentToolCall" => "Agent".into(),
            _ => return Ok(vec![]),
        };
        if kind == "collabAgentToolCall" {
            // Receiver IDs are evidence of native work even before a state snapshot.
            // Missing state stays busy; only an explicit terminal snapshot releases it.
            for child in item["receiverThreadIds"].as_array().into_iter().flatten() {
                let child = child.as_str().context("Traex 子智能体 ID 无效")?;
                if self.children.len() >= 512 && !self.children.contains(child) {
                    bail!("Traex 子智能体数量超出限制");
                }
                self.children.insert(child.into());
            }
            if let Some(states) = item["agentsStates"].as_object() {
                for (child, state) in states {
                    if matches!(
                        state["status"].as_str(),
                        Some("completed" | "errored" | "shutdown" | "notFound")
                    ) {
                        self.children.remove(child);
                    } else {
                        if self.children.len() >= 512 && !self.children.contains(child) {
                            bail!("Traex 子智能体数量超出限制");
                        }
                        self.children.insert(child.clone());
                    }
                }
            }
        }
        let mut actions = Vec::new();
        if !self.tools.contains(&id) {
            if self.tools.len() >= 4096 {
                bail!("Traex 工具数量超出限制");
            }
            self.tools.insert(id.clone());
            let input = if kind == "commandExecution" {
                json!({"command":item["command"],"cwd":item["cwd"]})
            } else if kind == "mcpToolCall" || kind == "dynamicToolCall" {
                item["arguments"].clone()
            } else {
                item.clone()
            };
            actions.push(Action::Event(EventKind::Tool {
                id: id.clone(),
                name,
                input,
            }));
        }
        if completed {
            if kind != "webSearch"
                && !matches!(
                    item["status"].as_str(),
                    Some("completed" | "failed" | "declined")
                )
            {
                bail!("Traex 工具完成状态无效");
            }
            let is_error = matches!(item["status"].as_str(), Some("failed" | "declined"))
                || item["success"] == false
                || item["exitCode"].as_i64().is_some_and(|code| code != 0);
            let content = if kind == "commandExecution" {
                item["aggregatedOutput"].clone()
            } else if item.get("result").is_some() {
                item["result"].clone()
            } else {
                item.clone()
            };
            actions.push(Action::Event(EventKind::ToolResult {
                id,
                content,
                is_error,
            }));
        }
        Ok(actions)
    }
}
impl AgentAdapter for Traex {
    fn max_output_frame_length(&self) -> usize {
        // thread/resume returns persisted turns in a single control response.
        // That history is not emitted as a public event or replayed to the model.
        16 * 1024 * 1024
    }
    fn can_start_turn(&self) -> bool {
        self.phase == Phase::Ready && self.pending.is_empty()
    }
    fn can_reconfigure(&self) -> bool {
        self.can_start_turn() && self.children.is_empty()
    }
    fn has_background_work(&self) -> bool {
        !self.children.is_empty()
    }
    fn knows_subagent(&self, _: &str) -> bool {
        false
    }
    fn set_initial_title(&mut self, title: Option<String>) {
        self.title = title;
    }
    fn command(
        &mut self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand> {
        if !matches!(
            config.permission_mode.as_deref(),
            None | Some("default" | "bypass_permissions")
        ) {
            bail!("Traex 不支持所选权限模式");
        }
        self.cwd = cwd.into();
        self.resume = resume.map(str::to_owned);
        let mut resolved = config.clone();
        if resolved.model.is_none() {
            resolved.model = resolved.provider.as_ref().map(|p| p.metadata.model.clone());
        }
        self.model_provider = resolved.provider.as_ref().map(|_| provider::id());
        self.config = Some(resolved);
        let mut command = crate::agent_environment::command(binary);
        command.args(["app-server", "--stdio"]).current_dir(cwd);
        if let Some(provider) = &config.provider {
            provider::configure(
                &mut command,
                provider,
                self.model_provider
                    .as_deref()
                    .context("Traex Provider ID 缺失")?,
            )?;
        }
        Ok(AgentCommand {
            command,
            _settings: None,
        })
    }
    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>> {
        match input {
            Input::Open if self.phase == Phase::Fresh => self.initialize(),
            Input::DiscoverCommands => {
                self.discovering = true;
                self.initialize()
            }
            Input::Start { prompt } => match self.phase {
                Phase::Fresh => {
                    if prompt.trim_start().starts_with('/') {
                        bail!("Traex 尚不支持原生命令");
                    }
                    self.pending_prompt = Some(prompt.into());
                    self.initialize()
                }
                Phase::Ready => self.start(prompt),
                _ => bail!("Traex 当前不能开始新一轮任务"),
            },
            Input::Interrupt => self.interrupt(),
            Input::Queue { request_id, prompt } => self.steer(request_id, prompt),
            Input::RenameTitle { title, .. } => {
                if !matches!(self.phase, Phase::Ready | Phase::Running) || self.rename.is_some() {
                    bail!("Traex 会话尚未就绪或标题修改待确认");
                }
                self.rename = Some(title.into());
                Ok(vec![self.request(
                    "thread/name/set",
                    json!({"threadId":self.thread,"name":title}),
                )?])
            }
            Input::Approval { id, input, allow } => {
                let method = self.approvals.remove(id).context("Traex 审批已过期")?;
                let native_id: Value = serde_json::from_str(id).context("Traex 审批 ID 无效")?;
                let result = match Some(method) {
                    Some(
                        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval",
                    ) => json!({"decision":if allow {"accept"}else{"decline"}}),
                    Some("item/permissions/requestApproval") => {
                        json!({"permissions":if allow {input["permissions"].clone()}else{json!({})},"scope":"turn"})
                    }
                    _ => bail!("Traex 审批类型不匹配"),
                };
                Ok(vec![write(json!({"id":native_id,"result":result}))?])
            }
            Input::QuestionAnswer {
                input,
                questions,
                answers,
                ..
            } => {
                let mut mapped = serde_json::Map::new();
                if let Some(answers) = answers {
                    for answer in answers {
                        let question = questions
                            .iter()
                            .find(|q| q.id == answer.question_id)
                            .context("Traex 问题不匹配")?;
                        let mut values = Vec::new();
                        for index in answer.option_indices {
                            values.push(
                                question
                                    .options
                                    .get(index as usize)
                                    .context("Traex 问题选项无效")?
                                    .label
                                    .clone(),
                            );
                        }
                        if let Some(text) = answer.text.filter(|s| !s.trim().is_empty()) {
                            values.push(text);
                        }
                        mapped.insert(question.id.clone(), json!({"answers":values}));
                    }
                }
                Ok(vec![write(
                    json!({"id":input["id"],"result":{"answers":mapped}}),
                )?])
            }
            Input::Message(line) => {
                let message: Value = serde_json::from_str(line).context("Traex 返回无效 JSON")?;
                if message.get("method").is_some() {
                    if message.get("id").is_some() {
                        self.native_request(&message)
                    } else {
                        self.notification(&message)
                    }
                } else {
                    self.response(&message)
                }
            }
            _ => bail!("Traex 会话状态不支持此操作"),
        }
    }
}
fn questions(params: &Value) -> Result<Vec<UserQuestion>> {
    let source = params["questions"]
        .as_array()
        .filter(|q| !q.is_empty() && q.len() <= 8)
        .context("Traex 问题数量无效")?;
    let mut ids = HashSet::new();
    source
        .iter()
        .map(|q| {
            if q["isSecret"] == true {
                bail!("Latte Work 尚不支持 Traex 密文问题");
            }
            let id = field(q, "id")?.to_owned();
            if !ids.insert(id.clone()) {
                bail!("Traex 问题 ID 重复");
            }
            let options = q["options"]
                .as_array()
                .map(|options| {
                    if options.len() > 32 {
                        bail!("Traex 问题选项超出限制");
                    }
                    options
                        .iter()
                        .map(|o| {
                            Ok(QuestionOption {
                                label: field(o, "label")?.into(),
                                description: o["description"].as_str().unwrap_or_default().into(),
                            })
                        })
                        .collect::<Result<Vec<_>>>()
                })
                .transpose()?
                .unwrap_or_default();
            Ok(UserQuestion {
                id,
                header: q["header"].as_str().unwrap_or_default().into(),
                text: q["question"].as_str().context("Traex 问题文本缺失")?.into(),
                options,
                multi_select: q["multiSelect"] == true,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> LaunchConfig {
        LaunchConfig {
            traex_model: None,
            provider: None,
            settings_dir: std::env::temp_dir(),
            model: Some("native-model".into()),
            effort: None,
            permission_mode: Some("default".into()),
        }
    }
    fn encoded(actions: &[Action]) -> Vec<Value> {
        actions
            .iter()
            .filter_map(|a| {
                if let Action::Write(b) = a {
                    Some(serde_json::from_slice(b).unwrap())
                } else {
                    None
                }
            })
            .collect()
    }
    fn message(agent: &mut Traex, value: Value) -> Vec<Action> {
        agent.advance(Input::Message(&value.to_string())).unwrap()
    }
    fn opened() -> Traex {
        let mut agent = Traex::default();
        agent.command("traex", "/tmp", None, &config()).unwrap();
        agent.advance(Input::Open).unwrap();
        message(&mut agent, json!({"id":"latte-1","result":{}}));
        message(
            &mut agent,
            json!({"id":"latte-2","result":{"config":{"model_provider":"native-provider","model":"native-default"}}}),
        );
        message(
            &mut agent,
            json!({"id":"latte-3","result":{"thread":{"id":"t"}}}),
        );
        agent
    }
    fn running() -> Traex {
        let mut agent = opened();
        agent.advance(Input::Start { prompt: "hello" }).unwrap();
        message(
            &mut agent,
            json!({"id":"latte-4","result":{"turn":{"id":"turn"}}}),
        );
        agent
    }
    #[test]
    fn open_is_prompt_free_and_resume_is_identity_bound() {
        let mut agent = Traex::default();
        agent
            .command("traex", "/tmp", Some("t"), &config())
            .unwrap();
        let writes = encoded(&agent.advance(Input::Open).unwrap());
        assert_eq!(writes[0]["method"], "initialize");
        let writes = encoded(&message(&mut agent, json!({"id":"latte-1","result":{}})));
        assert_eq!(writes[1]["method"], "config/read");
        let writes = encoded(&message(
            &mut agent,
            json!({"id":"latte-2","result":{"config":{"model_provider":"current-cli"}}}),
        ));
        assert_eq!(writes[0]["params"]["modelProvider"], "current-cli");
        assert_eq!(writes[0]["method"], "thread/resume");
        assert_eq!(writes[0]["params"]["threadId"], "t");
        assert_eq!(writes[0]["params"]["sandbox"], "workspace-write");
        assert!(!writes.iter().any(|v| v["method"] == "turn/start"));
        assert!(
            agent
                .advance(Input::Message(
                    r#"{"id":"latte-3","result":{"thread":{"id":"different"}}}"#
                ))
                .is_err()
        );
    }
    #[test]
    fn idle_parent_can_continue_while_children_still_prevent_reconfiguration() {
        let mut agent = opened();
        agent.children.insert("child-thread".into());
        assert!(agent.can_start_turn());
        assert!(!agent.can_reconfigure());
        agent.advance(Input::Start { prompt: "followup" }).unwrap();
        assert!(!agent.can_start_turn());
        assert!(agent.children.contains("child-thread"));
    }
    #[test]
    fn only_the_active_native_turn_can_stream_or_finish() {
        let mut agent = running();
        assert!(message(&mut agent,json!({"method":"turn/completed","params":{"threadId":"child","turn":{"id":"turn","status":"completed"}}})).is_empty());
        assert!(message(&mut agent,json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"stale","status":"completed"}}})).is_empty());
        let actions = message(
            &mut agent,
            json!({"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"turn","itemId":"msg","delta":"hello"}}),
        );
        assert!(
            actions
                .iter()
                .any(|a| matches!(a,Action::Event(EventKind::Text {text}) if text=="hello"))
        );
        assert!(message(&mut agent,json!({"method":"item/completed","params":{"threadId":"t","turnId":"turn","item":{"id":"msg","type":"agentMessage","text":"hello"}}})).is_empty());
        let actions = message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"completed"}}}),
        );
        assert!(matches!(
            actions.as_slice(),
            [Action::Finished { failed: false, .. }]
        ));
        assert!(agent.can_reconfigure());
    }
    #[test]
    fn completion_before_start_evidence_is_replayed_only_for_the_admitted_turn() {
        for started_notification in [false, true] {
            for stop in [false, true] {
                let mut agent = opened();
                agent.advance(Input::Start { prompt: "hello" }).unwrap();
                if stop {
                    assert!(agent.advance(Input::Interrupt).unwrap().is_empty());
                }
                for (thread, turn) in [("other", "turn"), ("t", "stale"), ("t", "turn")] {
                    assert!(message(&mut agent, json!({"method":"turn/completed","params":{"threadId":thread,"turn":{"id":turn,"status":"completed"}}})).is_empty());
                }
                assert!(!agent.can_reconfigure());
                let actions = message(
                    &mut agent,
                    if started_notification {
                        json!({"method":"turn/started","params":{"threadId":"t","turn":{"id":"turn"}}})
                    } else {
                        json!({"id":"latte-4","result":{"turn":{"id":"turn"}}})
                    },
                );
                assert!(matches!(actions[0], Action::NativeSession(_)));
                assert!(matches!(actions[1], Action::Finished { failed: false, .. }));
                assert_eq!(actions.len(), if stop { 3 } else { 2 });
                if stop {
                    assert!(matches!(actions[2], Action::Interrupted));
                }
                if started_notification {
                    assert!(
                        message(
                            &mut agent,
                            json!({"id":"latte-4","result":{"turn":{"id":"turn"}}})
                        )
                        .is_empty()
                    );
                }
                assert!(agent.can_reconfigure());
                assert!(agent.early_completions.is_empty());
            }
        }
        let mut agent = opened();
        agent.advance(Input::Start { prompt: "hello" }).unwrap();
        message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"stale","status":"completed"}}}),
        );
        let actions = message(
            &mut agent,
            json!({"id":"latte-4","result":{"turn":{"id":"current"}}}),
        );
        assert!(matches!(actions.as_slice(), [Action::NativeSession(_)]));
        assert!(
            !agent.can_reconfigure(),
            "stale completion cannot settle the admitted turn"
        );
    }
    #[test]
    fn completion_only_text_is_bounded_deduplicated_and_reset_each_turn() {
        let mut agent = running();
        let completed = json!({"method":"item/completed","params":{"threadId":"t","turnId":"turn","item":{"id":"msg","type":"agentMessage","text":"hello"}}});
        let actions = message(&mut agent, completed.clone());
        assert!(
            matches!(actions.as_slice(), [Action::Event(EventKind::Text {text})] if text == "hello")
        );
        assert!(message(&mut agent, completed.clone()).is_empty());
        message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"completed"}}}),
        );
        agent.advance(Input::Start { prompt: "again" }).unwrap();
        message(
            &mut agent,
            json!({"id":"latte-5","result":{"turn":{"id":"turn"}}}),
        );
        assert!(matches!(
            message(&mut agent, completed).as_slice(),
            [Action::Event(EventKind::Text { .. })]
        ));
        for index in 1..4096 {
            agent
                .item(
                    &json!({"id":format!("msg-{index}"),"type":"agentMessage","text":"text"}),
                    true,
                )
                .unwrap();
        }
        assert!(
            agent
                .item(
                    &json!({"id":"overflow","type":"agentMessage","text":"text"}),
                    true
                )
                .is_err()
        );
        assert!(
            agent
                .item(
                    &json!({"id":"msg","type":"agentMessage","text":"hello"}),
                    true
                )
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn interrupt_errors_are_obsolete_only_after_that_turn_completes() {
        for completion_first in [false, true] {
            let mut agent = running();
            agent.advance(Input::Interrupt).unwrap();
            if completion_first {
                message(
                    &mut agent,
                    json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"completed"}}}),
                );
            }
            let result = agent.advance(Input::Message(
                r#"{"id":"latte-5","error":{"code":-32602,"message":"turn not found"}}"#,
            ));
            if completion_first {
                assert!(matches!(result.unwrap().as_slice(), [Action::Interrupted]));
                assert!(agent.can_reconfigure());
            } else {
                assert!(
                    result.is_err(),
                    "an active turn's interrupt failure must be reported"
                );
            }
        }
        let mut agent = running();
        message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"completed"}}}),
        );
        agent.advance(Input::Start { prompt: "again" }).unwrap();
        message(
            &mut agent,
            json!({"id":"latte-5","result":{"turn":{"id":"next"}}}),
        );
        agent.advance(Input::Interrupt).unwrap();
        assert!(
            agent
                .advance(Input::Message(
                    r#"{"id":"latte-6","error":{"message":"failed to interrupt next turn"}}"#
                ))
                .is_err()
        );
    }
    #[test]
    fn approvals_preserve_numeric_native_ids_and_never_grant_session_cache() {
        let mut agent = running();
        let actions = message(
            &mut agent,
            json!({"id":71,"method":"item/commandExecution/requestApproval","params":{"threadId":"t","turnId":"turn","itemId":"tool","command":"cat /private/file"}}),
        );
        let Action::Approval { input, .. } = &actions[0] else {
            panic!()
        };
        assert_eq!(input["command"], "cat /private/file");
        assert!(input.get("method").is_none() && input.get("threadId").is_none());
        let response = encoded(
            &agent
                .advance(Input::Approval {
                    id: "71",
                    input: input.clone(),
                    allow: true,
                })
                .unwrap(),
        );
        assert_eq!(response[0], json!({"id":71,"result":{"decision":"accept"}}));
        let unknown = encoded(&message(
            &mut agent,
            json!({"id":"new","method":"account/relogin","params":{"threadId":"t","turnId":"turn"}}),
        ));
        assert_eq!(unknown[0]["error"]["code"], -32601);
    }
    #[test]
    fn file_and_permission_approvals_are_single_use_and_grant_only_turn_scope() {
        for method in [
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
        ] {
            for allow in [false, true] {
                let mut agent = running();
                let permissions = json!({"fileSystem":{"write":["/tmp/project"]}});
                let actions = message(
                    &mut agent,
                    json!({"id":"approval","method":method,"params":{"threadId":"t","turnId":"turn","itemId":"tool","permissions":permissions}}),
                );
                let Action::Approval { input, .. } = &actions[0] else {
                    panic!("expected native approval")
                };
                let response = encoded(
                    &agent
                        .advance(Input::Approval {
                            id: r#""approval""#,
                            input: input.clone(),
                            allow,
                        })
                        .unwrap(),
                );
                let expected = if method == "item/fileChange/requestApproval" {
                    json!({"decision": if allow {"accept"} else {"decline"}})
                } else {
                    json!({"permissions": if allow {permissions} else {json!({})},"scope":"turn"})
                };
                assert_eq!(response, [json!({"id":"approval","result":expected})]);
                assert!(
                    agent
                        .advance(Input::Approval {
                            id: r#""approval""#,
                            input: input.clone(),
                            allow
                        })
                        .is_err()
                );
            }
        }
    }
    #[test]
    fn user_answers_map_indices_to_native_labels_and_skip_is_explicit() {
        let mut agent = running();
        let actions = message(
            &mut agent,
            json!({"id":"ask","method":"item/tool/requestUserInput","params":{"threadId":"t","turnId":"turn","itemId":"tool","questions":[{"id":"q","header":"Pick","question":"Choose","options":[{"label":"A","description":"first"}]}]}}),
        );
        let Action::Question {
            input, questions, ..
        } = &actions[0]
        else {
            panic!()
        };
        let response = encoded(
            &agent
                .advance(Input::QuestionAnswer {
                    id: "ask",
                    input: input.clone(),
                    questions: questions.clone(),
                    answers: Some(vec![latte_work_protocol::QuestionAnswer {
                        question_id: "q".into(),
                        option_indices: vec![0],
                        text: None,
                    }]),
                })
                .unwrap(),
        );
        assert_eq!(
            response[0]["result"]["answers"]["q"]["answers"],
            json!(["A"])
        );
        let response = encoded(
            &agent
                .advance(Input::QuestionAnswer {
                    id: "ask",
                    input: input.clone(),
                    questions: questions.clone(),
                    answers: None,
                })
                .unwrap(),
        );
        assert_eq!(response[0]["result"], json!({"answers":{}}));
    }
    #[test]
    fn stop_during_start_waits_for_the_native_turn_id() {
        let mut agent = opened();
        agent.advance(Input::Start { prompt: "hello" }).unwrap();
        assert!(agent.advance(Input::Interrupt).unwrap().is_empty());
        let writes = encoded(&message(
            &mut agent,
            json!({"id":"latte-4","result":{"turn":{"id":"turn"}}}),
        ));
        assert_eq!(writes[0]["method"], "turn/interrupt");
        let ack = message(&mut agent, json!({"id":"latte-5","result":{}}));
        assert!(matches!(ack.as_slice(), [Action::Interrupted]));
        assert!(!agent.can_reconfigure());
    }
    #[test]
    fn child_work_without_a_status_snapshot_fences_reconfiguration() {
        let mut agent = running();
        agent.item(&json!({"id":"spawn","type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["child"],"agentsStates":{},"status":"completed"}),true).unwrap();
        message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"completed"}}}),
        );
        assert!(agent.has_background_work());
        assert!(!agent.can_reconfigure());
        agent.item(&json!({"id":"wait","type":"collabAgentToolCall","tool":"wait","receiverThreadIds":["child"],"agentsStates":{"child":{"status":"completed"}},"status":"completed"}),true).unwrap();
        assert!(!agent.has_background_work());
        assert!(agent.can_reconfigure());
    }
    #[test]
    fn steer_is_turn_bound_and_only_completion_retires_the_input() {
        let mut agent = running();
        let writes = encoded(
            &agent
                .advance(Input::Queue {
                    request_id: "q",
                    prompt: "补充信息",
                })
                .unwrap(),
        );
        assert_eq!(writes[0]["method"], "turn/steer");
        assert_eq!(
            writes[0]["params"],
            json!({"threadId":"t","expectedTurnId":"turn","input":[{"type":"text","text":"补充信息"}]})
        );
        assert!(
            message(
                &mut agent,
                json!({"id":writes[0]["id"],"result":{"turnId":"turn"}})
            )
            .is_empty()
        );
        let done = message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"completed"}}}),
        );
        assert!(
            matches!(&done[..],[Action::InputsConsumed(ids),Action::Finished{failed:false,..}] if ids==&["q"])
        );
    }
    #[test]
    fn steer_rejection_preserves_the_turn_and_late_ack_needs_matching_completion() {
        let mut agent = running();
        let write = encoded(
            &agent
                .advance(Input::Queue {
                    request_id: "q",
                    prompt: "extra",
                })
                .unwrap(),
        )
        .remove(0);
        let rejection = message(
            &mut agent,
            json!({"id":write["id"],"error":{"code":-32601,"message":"unsupported steer"}}),
        );
        assert!(matches!(&rejection[..],[Action::InputRejected{request_id,..}] if request_id=="q"));
        assert!(agent.phase == Phase::Running);
        let write = encoded(
            &agent
                .advance(Input::Queue {
                    request_id: "q2",
                    prompt: "extra",
                })
                .unwrap(),
        )
        .remove(0);
        message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"completed"}}}),
        );
        assert!(
            matches!(&message(&mut agent,json!({"id":write["id"],"result":{"turnId":"turn"}}))[..],[Action::InputsConsumed(ids)] if ids==&["q2"])
        );
        let mut agent = running();
        let write = encoded(
            &agent
                .advance(Input::Queue {
                    request_id: "q",
                    prompt: "extra",
                })
                .unwrap(),
        )
        .remove(0);
        assert!(
            agent
                .advance(Input::Message(
                    &json!({"id":write["id"],"result":{"turnId":"wrong"}}).to_string()
                ))
                .is_err()
        );
    }
    #[test]
    fn interrupted_steers_are_not_reported_as_processed_and_startup_is_explicit() {
        let mut agent = running();
        let write = encoded(
            &agent
                .advance(Input::Queue {
                    request_id: "q",
                    prompt: "extra",
                })
                .unwrap(),
        )
        .remove(0);
        message(
            &mut agent,
            json!({"id":write["id"],"result":{"turnId":"turn"}}),
        );
        let done = message(
            &mut agent,
            json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"turn","status":"interrupted"}}}),
        );
        assert!(!done.iter().any(|a| matches!(a, Action::InputsConsumed(_))));
        let mut agent = opened();
        assert!(
            agent
                .advance(Input::Queue {
                    request_id: "q",
                    prompt: "extra"
                })
                .is_err()
        );
    }
    #[test]
    fn malformed_frames_fail_and_unsupported_actions_never_become_prompts() {
        let mut agent = opened();
        assert!(
            agent
                .advance(Input::Queue {
                    request_id: "q",
                    prompt: "text"
                })
                .is_err()
        );
        assert!(agent.advance(Input::Message("not json")).is_err());
        let mut agent = opened();
        assert!(agent.advance(Input::Start { prompt: "/unknown" }).is_err());
        let mut agent = Traex::default();
        agent.command("traex", "/tmp", None, &config()).unwrap();
        agent.advance(Input::Open).unwrap();
        assert!(
            agent
                .advance(Input::Message(
                    r#"{"id":"latte-1","error":{"message":"auth failed"}}"#
                ))
                .is_err()
        );
    }
}
