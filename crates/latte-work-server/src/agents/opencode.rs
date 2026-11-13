//! OpenCode 2.x ACP v1 over a dedicated stdio child.
//! <https://opencode.ai/docs/cli/acp/>
use super::{Action, AgentAdapter, AgentCommand, Input};
use crate::providers::LaunchConfig;
use anyhow::{Context, Result, bail, ensure};
use latte_work_protocol::{
    AgentSlashCommand, ContextUsage, Effort, EventKind, ExecutionPhase, SubagentStatus,
    SubagentUpdate, TurnUsage,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

mod metadata;
pub(crate) use metadata::commands;
pub(super) use metadata::{discover, models};

const FRAME_LIMIT: usize = 4 * 1024 * 1024;
const CHILD_CAPABILITY: &str = "opencode/child-session-updates";
const CHILD_META: &str = "opencode/child-session";
const MAX_CHILDREN: usize = 512;
const MAX_TOOLS: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Request {
    Initialize,
    Attach,
    Model,
    Effort,
    Prompt,
}

#[derive(Default)]
pub struct OpenCode {
    cwd: String,
    resume: Option<String>,
    session: Option<String>,
    model: Option<String>,
    effort: Option<Effort>,
    selected_model: Option<String>,
    next: u64,
    request: Option<(u64, Request)>,
    ready: bool,
    saved: bool,
    cancelling: bool,
    prompt: Option<String>,
    commands: Option<Vec<AgentSlashCommand>>,
    early_commands: Option<(String, Vec<AgentSlashCommand>)>,
    approvals: HashMap<String, Permission>,
    tools: HashMap<String, Tool>,
    children: HashMap<String, bool>,
    // ACP reports child lifecycle, but 2.3 can start a parent follow-up
    // without an ACP prompt or a terminal marker. Keep replacement/undo
    // fenced until an explicit foreground prompt settles or the user closes.
    possible_followup: bool,
    // ACP does not publish a completion event for detached shell commands.
    background_shell: bool,
    context: Option<ContextUsage>,
}

struct Permission {
    wire_id: Value,
    allow: String,
    reject: Option<String>,
}

#[derive(Default)]
struct Tool {
    name: Option<String>,
    shown: bool,
}

pub(super) fn version_2(value: &str) -> bool {
    let value = value.trim();
    let value = value.strip_prefix("opencode ").unwrap_or(value);
    let value = value.strip_prefix('v').unwrap_or(value);
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3 && parts[0] == "2" && parts[1..].iter().all(|part| part.parse::<u64>().is_ok())
}

pub(super) fn frame(value: Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    ensure!(
        bytes.len() <= latte_work_protocol::MAX_FRAME,
        "OpenCode ACP 请求超出限制"
    );
    Ok(bytes)
}

fn write(value: Value) -> Result<Action> {
    Ok(Action::Write(frame(value)?))
}

pub(super) fn initialize() -> Value {
    json!({
        "protocolVersion": 1,
        "clientInfo": {"name": "Latte Work", "version": env!("CARGO_PKG_VERSION")},
        "clientCapabilities": {"_meta": {(CHILD_CAPABILITY): true}}
    })
}

pub(super) fn verify_initialize(result: &Value) -> Result<()> {
    ensure!(
        result["protocolVersion"] == 1
            && result["agentInfo"]["name"] == "OpenCode"
            && result["agentInfo"]["version"]
                .as_str()
                .is_some_and(version_2)
            && result["agentCapabilities"]["sessionCapabilities"]["resume"].is_object(),
        "需要支持 ACP 会话恢复的 OpenCode 2.x"
    );
    Ok(())
}

fn rpc_error(error: &Value) -> String {
    if error["code"] == -32000 {
        return "OpenCode 需要认证；请在执行主机运行 opencode auth login".into();
    }
    let message = error["message"].as_str().unwrap_or("未知错误");
    format!(
        "OpenCode ACP：{}",
        message.chars().take(500).collect::<String>()
    )
}

fn string<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control))
        .with_context(|| format!("OpenCode ACP 缺少有效的 {name}"))
}

pub(super) fn config_option<'a>(result: &'a Value, id: &str) -> Option<&'a Value> {
    result["configOptions"]
        .as_array()?
        .iter()
        .find(|v| v["id"] == id && v["type"] == "select")
}

pub(super) fn options(option: &Value) -> impl Iterator<Item = (&str, &Value)> {
    option["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| string(value, "value").ok().map(|id| (id, value)))
}

pub(super) fn parse_commands(update: &Value) -> Result<Vec<AgentSlashCommand>> {
    let entries = update["availableCommands"]
        .as_array()
        .context("OpenCode ACP 未返回命令列表")?;
    ensure!(entries.len() <= 1000, "OpenCode 命令列表超出限制");
    let mut seen = HashSet::new();
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let name = string(entry, "name").ok()?;
            if name.len() > 128
                || name.chars().any(|c| c.is_whitespace() || c == '/')
                || !seen.insert(name)
            {
                return None;
            }
            Some(AgentSlashCommand {
                name: name.into(),
                display_name: None,
                description: entry["description"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(240)
                    .collect(),
                argument_hint: entry["input"]["hint"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(120)
                    .collect(),
                ui_action: None,
            })
        })
        .collect())
}

impl OpenCode {
    fn request(&mut self, kind: Request, method: &str, params: Value) -> Result<Action> {
        ensure!(self.request.is_none(), "OpenCode ACP 请求仍在执行");
        self.next += 1;
        self.request = Some((self.next, kind));
        write(json!({"jsonrpc":"2.0", "id":self.next, "method":method, "params":params}))
    }

    fn begin(&mut self) -> Result<Vec<Action>> {
        ensure!(self.next == 0, "OpenCode ACP 已初始化");
        Ok(vec![self.request(
            Request::Initialize,
            "initialize",
            initialize(),
        )?])
    }

    fn session_id(&self) -> Result<&str> {
        self.session.as_deref().context("OpenCode ACP 会话尚未打开")
    }

    fn set_config(&mut self, kind: Request, key: &str, value: &str) -> Result<Action> {
        let params = json!({"sessionId": self.session_id()?, "configId":key, "value":value});
        self.request(kind, "session/set_config_option", params)
    }

    fn ready(&mut self) -> Result<Vec<Action>> {
        // 2.0.0 announces commands before the attach response; later 2.x
        // announces them after it. Wait for both before forwarding slash input.
        if self.ready || self.session.is_none() || self.commands.is_none() || self.request.is_some()
        {
            return Ok(vec![]);
        }
        self.ready = true;
        let mut actions = vec![Action::Ready];
        if let Some(prompt) = self.prompt.take() {
            actions.extend(self.start(&prompt)?);
        }
        Ok(actions)
    }

    fn start(&mut self, text: &str) -> Result<Vec<Action>> {
        let command = text
            .trim_start()
            .strip_prefix('/')
            .map(|tail| tail.split_whitespace().next().unwrap_or_default());
        if let Some(name) = command
            && (name != "compact"
                || !self
                    .commands
                    .as_ref()
                    .is_some_and(|list| list.iter().any(|c| c.name == name)))
        {
            return Ok(vec![Action::Finished {
                failed: true,
                message: Some("此 OpenCode 命令尚不支持；消息未发送给模型".into()),
            }]);
        }
        let session = self.session_id()?.to_owned();
        let action = self.request(Request::Prompt, "session/prompt", json!({
            "sessionId": session, "prompt": [{"type":"text", "text":if command.is_some() {text.trim_start()} else {text}}]
        }))?;
        self.tools.clear();
        self.context = None;
        self.saved = true;
        // OpenCode creates its durable session on session/new, before prompting.
        Ok(vec![Action::NativeSession(session), action])
    }

    fn apply_effort(&mut self, result: &Value) -> Result<Vec<Action>> {
        if let Some(option) = config_option(result, "effort") {
            let value = self.effort.map(Effort::as_str).unwrap_or("default");
            ensure!(
                options(option).any(|(id, _)| id == value),
                "此 OpenCode 模型不支持所选思考强度"
            );
            if option["currentValue"] != value {
                return Ok(vec![self.set_config(Request::Effort, "effort", value)?]);
            }
        } else {
            ensure!(self.effort.is_none(), "此 OpenCode 模型不支持所选思考强度");
        }
        self.ready()
    }

    fn response(&mut self, message: &Value) -> Result<Vec<Action>> {
        let Some((id, kind)) = self.request else {
            return Ok(vec![]);
        };
        if message["id"].as_u64() != Some(id) {
            return Ok(vec![]);
        }
        self.request = None;
        if let Some(error) = message.get("error") {
            if kind == Request::Prompt {
                return Ok(self.finish(true, Some(rpc_error(error))));
            }
            bail!("{}", rpc_error(error));
        }
        let result = message.get("result").context("OpenCode ACP 缺少响应结果")?;
        match kind {
            Request::Initialize => {
                verify_initialize(result)?;
                let mut params = json!({"cwd":self.cwd, "mcpServers":[]});
                let method = if let Some(id) = &self.resume {
                    params["sessionId"] = json!(id);
                    "session/resume"
                } else {
                    "session/new"
                };
                Ok(vec![self.request(Request::Attach, method, params)?])
            }
            Request::Attach => {
                let session = if let Some(id) = &self.resume {
                    // ACP resume normally omits sessionId. Never adopt a different one.
                    ensure!(
                        result
                            .get("sessionId")
                            .is_none_or(|value| value.as_str() == Some(id)),
                        "OpenCode 恢复了不同的会话"
                    );
                    id.clone()
                } else {
                    string(result, "sessionId")?.into()
                };
                if let Some((id, commands)) = self.early_commands.take()
                    && id == session
                {
                    self.commands = Some(commands);
                }
                self.session = Some(session);
                let catalog =
                    config_option(result, "model").context("OpenCode ACP 未返回模型配置")?;
                self.selected_model = catalog["currentValue"].as_str().map(str::to_owned);
                if let Some(model) = self.model.clone() {
                    ensure!(
                        options(catalog).any(|(id, _)| id == model),
                        "模型不在当前 OpenCode 可选列表中，请刷新模型列表"
                    );
                    if catalog["currentValue"] != model {
                        return Ok(vec![self.set_config(Request::Model, "model", &model)?]);
                    }
                }
                self.apply_effort(result)
            }
            Request::Model => {
                let catalog = config_option(result, "model").context("OpenCode 未确认所选模型")?;
                ensure!(
                    catalog["currentValue"].as_str() == self.model.as_deref(),
                    "OpenCode 未确认所选模型"
                );
                self.selected_model.clone_from(&self.model);
                self.apply_effort(result)
            }
            Request::Effort => {
                let expected = self.effort.map(Effort::as_str).unwrap_or("default");
                ensure!(
                    config_option(result, "effort")
                        .is_some_and(|entry| entry["currentValue"] == expected),
                    "OpenCode 未确认所选思考强度"
                );
                self.ready()
            }
            Request::Prompt => {
                let reason = result["stopReason"].as_str().unwrap_or_default();
                let message = match reason {
                    "end_turn" => None,
                    "cancelled" => Some("OpenCode 已取消本轮".into()),
                    "max_tokens" => Some("OpenCode 达到输出令牌上限".into()),
                    "max_turn_requests" => Some("OpenCode 达到本轮请求次数上限".into()),
                    "refusal" => Some("OpenCode 拒绝了本轮请求".into()),
                    _ => Some("OpenCode 返回未知的结束状态".into()),
                };
                let mut actions = Vec::new();
                if let Some(usage) = result["usage"].as_object() {
                    let n =
                        |key: &str| usage.get(key).and_then(Value::as_f64).filter(|n| *n >= 0.0);
                    actions.push(Action::Event(EventKind::Usage {
                        context: self.context.take(),
                        totals: Some(TurnUsage {
                            input_tokens: n("inputTokens"),
                            output_tokens: n("outputTokens"),
                            cache_read_tokens: n("cachedReadTokens"),
                            cache_write_tokens: n("cachedWriteTokens"),
                            model_time_ms: None,
                            steps: None,
                        }),
                    }));
                }
                if reason == "end_turn" && !self.children.values().any(|active| *active) {
                    self.possible_followup = false;
                }
                actions.extend(self.finish(message.is_some(), message));
                Ok(actions)
            }
        }
    }

    fn finish(&mut self, failed: bool, message: Option<String>) -> Vec<Action> {
        self.tools.clear();
        self.context = None;
        let mut actions = Vec::new();
        if std::mem::take(&mut self.cancelling) {
            self.approvals.clear();
            actions.push(Action::Interrupted);
        }
        actions.push(Action::Finished { failed, message });
        actions
    }

    fn running(&self) -> bool {
        self.request
            .is_some_and(|(_, kind)| kind == Request::Prompt)
    }

    fn session_update(&mut self, params: &Value) -> Result<Vec<Action>> {
        let id = string(params, "sessionId")?;
        let update = &params["update"];
        if update["sessionUpdate"] == "available_commands_update" {
            if self.session.as_deref() == Some(id) {
                self.commands = Some(parse_commands(update)?);
                return self.ready();
            }
            if self.session.is_none()
                && self
                    .request
                    .is_some_and(|(_, kind)| kind == Request::Attach)
                && self.resume.as_deref().is_none_or(|resume| resume == id)
            {
                self.early_commands = Some((id.into(), parse_commands(update)?));
            }
            return Ok(vec![]);
        }
        if self.session.as_deref() != Some(id)
            || !self.running()
            || !update["_meta"][CHILD_META].is_null()
        {
            return Ok(vec![]);
        }
        if update["sessionUpdate"] == "usage_update" {
            self.context = self.selected_model.as_ref().and_then(|model| {
                let used = update["used"].as_f64()?;
                let size = update["size"].as_f64()?;
                (used >= 0.0 && size > 0.0).then(|| ContextUsage {
                    model: model.clone(),
                    used_tokens: used,
                    window_tokens: Some(size),
                })
            });
        }
        self.events(update, None)
    }

    fn child_update(&mut self, params: &Value) -> Result<Vec<Action>> {
        if !self.saved || params["rootSessionId"].as_str() != self.session.as_deref() {
            return Ok(vec![]);
        }
        let child = string(params, "childSessionId")?;
        if Some(child) == self.session.as_deref() {
            return Ok(vec![]);
        }
        let parent = string(params, "parentSessionId")?;
        if Some(parent) != self.session.as_deref() && !self.children.contains_key(parent) {
            return Ok(vec![]);
        }
        let channel = format!("opencode-child:{child}");
        if params["type"] == "status" {
            let status = match params["status"].as_str() {
                Some("created" | "running") => SubagentStatus::Running,
                Some("completed") => SubagentStatus::Completed,
                Some("interrupted") => SubagentStatus::Stopped,
                Some("failed") => SubagentStatus::Failed,
                _ => return Ok(vec![]),
            };
            if !self.children.contains_key(child) {
                if !self.running() && !self.possible_followup || !status.active() {
                    return Ok(vec![]);
                }
                ensure!(
                    self.children.len() < MAX_CHILDREN,
                    "OpenCode 子任务数量超出限制"
                );
            }
            self.children.insert(child.into(), status.active());
            self.possible_followup = true;
            return Ok(vec![Action::Event(EventKind::Subagent {
                update: SubagentUpdate {
                    id: child.into(),
                    tool_use_id: Some(channel),
                    title: params["title"]
                        .as_str()
                        .map(|s| s.chars().take(160).collect()),
                    agent_type: None,
                    status: Some(status),
                    summary: None,
                    last_tool: None,
                },
            })]);
        }
        if params["type"] == "update" && self.children.get(child) == Some(&true) {
            return self.events(&params["update"], Some(&channel));
        }
        Ok(vec![])
    }

    fn events(&mut self, update: &Value, child: Option<&str>) -> Result<Vec<Action>> {
        let event = |event| match child {
            Some(tool_use_id) => Action::SubagentEvent {
                tool_use_id: tool_use_id.into(),
                event,
            },
            None => Action::Event(event),
        };
        let mut actions = Vec::new();
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") if update["content"]["type"] == "text" => {
                if let Some(text) = update["content"]["text"].as_str() {
                    actions.push(event(EventKind::Text { text: text.into() }));
                }
            }
            Some("agent_thought_chunk") if child.is_none() => {
                actions.push(event(EventKind::Progress {
                    phase: ExecutionPhase::Thinking,
                }));
            }
            Some("tool_call" | "tool_call_update") => {
                let id = string(update, "toolCallId")?;
                if !self.tools.contains_key(id) {
                    ensure!(self.tools.len() < MAX_TOOLS, "OpenCode 工具数量超出限制");
                }
                let tool = self.tools.entry(id.into()).or_default();
                if update["sessionUpdate"] == "tool_call" {
                    tool.name = Some(tool_label(update, None));
                }
                let status = update["status"].as_str();
                let terminal = matches!(status, Some("completed" | "failed"));
                if !tool.shown && (terminal || status == Some("in_progress")) {
                    let name = tool_label(update, tool.name.as_deref());
                    actions.push(event(EventKind::Tool {
                        id: id.into(),
                        name,
                        input: update.get("rawInput").cloned().unwrap_or_else(|| json!({})),
                    }));
                    tool.shown = true;
                }
                if terminal {
                    let metadata = &update["rawOutput"]["metadata"];
                    if metadata["status"] == "running" && metadata["shellID"].is_string() {
                        self.background_shell = true;
                    }
                    let content: Vec<_> = update["content"].as_array().into_iter().flatten()
                        .filter_map(|v| match v["type"].as_str() {
                            Some("content") if v["content"]["type"] == "text" => {
                                Some(json!({"type":"text", "text":v["content"]["text"].as_str()?}))
                            }
                            Some("diff") => {
                                Some(json!({"type":"text","text":format!("已修改：{}", v["path"].as_str()?)}))
                            }
                            _ => None,
                        }).collect();
                    let content = if content.is_empty() {
                        update["rawOutput"]["error"]
                            .as_str()
                            .map_or_else(|| json!([]), |text| json!([{"type":"text","text":text}]))
                    } else {
                        json!(content)
                    };
                    actions.push(event(EventKind::ToolResult {
                        id: id.into(),
                        content,
                        is_error: status == Some("failed"),
                    }));
                    self.tools.remove(id);
                }
            }
            _ => {}
        }
        Ok(actions)
    }

    fn permission(&mut self, id: &Value, params: &Value) -> Result<Vec<Action>> {
        let tool = &params["toolCall"];
        let child = tool["_meta"][CHILD_META]["id"].as_str();
        let belongs = self
            .session
            .as_deref()
            .is_some_and(|session| params["sessionId"] == session)
            && match child {
                Some(child) => self.children.get(child) == Some(&true),
                None => self.running(),
            };
        let option = |kind| {
            params["options"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|v| v["kind"] == kind)
                .and_then(|v| string(v, "optionId").ok())
                .map(str::to_owned)
        };
        let Some(allow) = option("allow_once").filter(|_| belongs && !self.cancelling) else {
            return Ok(vec![permission_result(id, None)?]);
        };
        let key = serde_json::to_string(id)?;
        ensure!(
            self.approvals.len() < 32 && !self.approvals.contains_key(&key),
            "OpenCode 权限请求重复或数量超出限制"
        );
        let reject = option("reject_once").filter(|reject| *reject != allow);
        self.approvals.insert(
            key.clone(),
            Permission {
                wire_id: id.clone(),
                allow,
                reject,
            },
        );
        let tool_use_id = string(tool, "toolCallId").ok().map(str::to_owned);
        let mut input = tool["rawInput"].as_object().cloned().unwrap_or_default();
        for (wire, field) in [
            ("title", "title"),
            ("locations", "locations"),
            ("content", "preview"),
        ] {
            if let Some(value) = tool.get(wire) {
                input.entry(field).or_insert_with(|| value.clone());
            }
        }
        // Permission-only calls may omit rawInput but describe their command in title.
        if tool["kind"] == "execute" && !input.contains_key("command") && tool["title"].is_string()
        {
            input.insert("command".into(), tool["title"].clone());
        }
        Ok(vec![Action::Approval {
            id: key,
            tool_use_id,
            tool: tool_label(tool, None),
            input: Value::Object(input),
        }])
    }

    fn message(&mut self, line: &str) -> Result<Vec<Action>> {
        let message: Value = serde_json::from_str(line).context("无效的 OpenCode ACP 消息")?;
        ensure!(message["jsonrpc"] == "2.0", "无效的 OpenCode ACP 协议版本");
        match message["method"].as_str() {
            Some(method) => {
                if let Some(id) = message.get("id") {
                    ensure!(
                        id.is_i64() || id.as_str().is_some_and(|s| s.len() <= 512),
                        "无效的 OpenCode ACP 请求 ID"
                    );
                    if method == "session/request_permission" {
                        return self.permission(id, &message["params"]);
                    }
                    // No filesystem, terminal, or other client capabilities were granted.
                    return Ok(vec![write(
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported client method"}}),
                    )?]);
                }
                match method {
                    "session/update" => self.session_update(&message["params"]),
                    "opencode/session/child_update" => self.child_update(&message["params"]),
                    _ => Ok(vec![]),
                }
            }
            None => self.response(&message),
        }
    }
}

fn tool_label(update: &Value, fallback: Option<&str>) -> String {
    // ACP "execute" covers shell as well as other tools. Only map a
    // structured command (or OpenCode's explicit shell name) to Bash.
    let name = update["name"].as_str();
    if matches!(name, Some("shell" | "bash"))
        || (update["kind"] == "execute" && update["rawInput"]["command"].is_string())
    {
        return "Bash".into();
    }
    name.or_else(|| update["title"].as_str())
        .or(fallback)
        .or_else(|| update["kind"].as_str())
        .unwrap_or("OpenCode 工具")
        .chars()
        .take(180)
        .collect()
}

fn permission_result(id: &Value, selected: Option<&str>) -> Result<Action> {
    let outcome = selected.map_or_else(
        || json!({"outcome":"cancelled"}),
        |option_id| json!({"outcome":"selected", "optionId":option_id}),
    );
    write(json!({"jsonrpc":"2.0","id":id,"result":{"outcome":outcome}}))
}

impl AgentAdapter for OpenCode {
    fn can_reconfigure(&self) -> bool {
        self.can_start_turn() && !self.has_background_work()
    }

    fn can_start_turn(&self) -> bool {
        self.ready && self.request.is_none() && self.approvals.is_empty()
    }

    fn has_background_work(&self) -> bool {
        self.background_shell
            || self.possible_followup
            || self.children.values().any(|active| *active)
    }

    fn knows_subagent(&self, _native_id: &str) -> bool {
        // Only live ACP updates are available; Runtime must not read Claude history.
        false
    }

    fn set_session_title(&mut self, _title: Option<String>, _resuming: bool) {}

    fn command(
        &mut self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand> {
        ensure!(
            config.provider.is_none(),
            "OpenCode 使用执行主机上的原生 Provider 配置"
        );
        ensure!(
            config.permission_mode.is_none(),
            "OpenCode 使用执行主机上的原生权限策略"
        );
        self.cwd = cwd.into();
        self.resume = resume.map(str::to_owned);
        self.saved = self.resume.is_some();
        self.model.clone_from(&config.model);
        self.effort = config.effort;
        Ok(AgentCommand {
            command: metadata::command(binary, Some(cwd), &config.environment),
            _settings: None,
        })
    }

    fn frame_limit(&self) -> Option<usize> {
        Some(FRAME_LIMIT)
    }

    fn close_request(&self) -> Result<Option<Vec<u8>>> {
        let Some(session) = &self.session else {
            return Ok(None);
        };
        Ok(Some(frame(
            json!({"jsonrpc":"2.0","id":self.next + 1,"method":"session/close","params":{"sessionId":session}}),
        )?))
    }

    fn close_ack(&self, line: &str) -> bool {
        serde_json::from_str::<Value>(line).is_ok_and(|msg| {
            msg["jsonrpc"] == "2.0"
                && msg.get("method").is_none()
                && msg["id"].as_u64() == Some(self.next + 1)
                && msg.get("result").is_some()
        })
    }

    fn can_interrupt_startup(&self) -> bool {
        true
    }

    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>> {
        match input {
            Input::Open => self.begin(),
            Input::Start { prompt } if self.ready => self.start(prompt),
            Input::Start { prompt } => {
                ensure!(self.prompt.is_none(), "OpenCode 正在初始化");
                self.prompt = Some(prompt.into());
                if self.next == 0 {
                    self.begin()
                } else {
                    Ok(vec![])
                }
            }
            Input::Message(line) => self.message(line),
            Input::Interrupt if self.running() => {
                self.cancelling = true;
                let mut actions = vec![write(
                    json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.session_id()?}}),
                )?];
                // Early 2.x can wait for the client response inside the
                // same event loop that observes the native cancellation.
                // Cancel all displayed permissions without selecting allow.
                for (_, request) in self.approvals.drain() {
                    actions.push(permission_result(&request.wire_id, None)?);
                }
                Ok(actions)
            }
            Input::Interrupt => {
                let mut actions = vec![Action::Interrupted];
                if self.prompt.take().is_some() {
                    actions.push(Action::Finished {
                        failed: true,
                        message: None,
                    });
                }
                Ok(actions)
            }
            Input::Approval { id, allow, .. } => {
                let request = self
                    .approvals
                    .remove(id)
                    .context("OpenCode 权限请求已过期")?;
                let selected = if self.cancelling {
                    None
                } else if allow {
                    Some(request.allow.as_str())
                } else {
                    request.reject.as_deref()
                };
                Ok(vec![permission_result(&request.wire_id, selected)?])
            }
            Input::Queue { .. } => {
                bail!("OpenCode 暂不支持在当前轮中立即交付队列消息，请等待本轮结束")
            }
            Input::DiscoverCommands => bail!("OpenCode 通过独立 ACP 探针发现命令"),
            Input::RenameTitle { .. } => bail!("OpenCode ACP 暂不支持修改原生会话标题"),
            Input::QuestionAnswer { .. } => bail!("OpenCode ACP 暂不支持表单问答"),
        }
    }
}
