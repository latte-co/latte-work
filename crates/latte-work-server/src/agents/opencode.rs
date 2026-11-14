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

mod config;
mod history;
mod metadata;
mod question;
pub(super) use history::read as child_history;
pub(crate) use metadata::commands;
pub(super) use metadata::{discover, models, permission_modes, skill_info};

const FRAME_LIMIT: usize = 4 * 1024 * 1024;
const CHILD_CAPABILITY: &str = "opencode/child-session-updates";
const CHILD_META: &str = "opencode/child-session";
const MAX_CHILDREN: usize = 512;
const MAX_TOOLS: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Request {
    Initialize,
    Attach,
    DefaultModel,
    DeleteProbe,
    Model,
    Effort,
    Prompt,
}

#[derive(Default)]
pub struct OpenCode {
    cwd: String,
    resume: Option<String>,
    fallback_model_on_open: bool,
    managed_provider: bool,
    legacy_instructions: Option<String>,
    initial_title: Option<String>,
    initial_title_pending: bool,
    sideband_ready: bool,
    rename: Option<(String, String)>,
    steering: Option<(String, String)>,
    native_permissions: HashMap<String, String>,
    child_interactions: HashSet<String>,
    command_children: HashSet<String>,
    background_inputs: HashSet<String>,
    foreground_inbox_delivered: bool,
    deferred_followup: Vec<String>,
    deferred_followup_bytes: usize,
    native_questions: HashSet<String>,
    followup: bool,
    native_command: Option<String>,
    slash_prompt: Option<String>,
    command_outcome: Option<bool>,
    command_waiting_for_end: bool,
    command_acknowledged: bool,
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
    questions: HashMap<String, question::Form>,
    tools: HashMap<String, Tool>,
    children: HashMap<String, bool>,
    child_roles: HashMap<String, String>,
    native_children: HashSet<String>,
    // A finished child can wake the parent before the next execution event.
    possible_followup: bool,
    // ACP does not publish a completion event for detached shell commands.
    background_shells: HashMap<String, (String, Option<String>)>,
    shell_exits: HashMap<String, Value>,
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
    child: bool,
}

pub(super) fn version_2(value: &str) -> bool {
    let value = value.trim();
    let value = value.strip_prefix("opencode ").unwrap_or(value);
    let value = value.strip_prefix('v').unwrap_or(value);
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3 && parts[0] == "2" && parts[1..].iter().all(|part| part.parse::<u64>().is_ok())
}

fn minor_version(version: &str) -> u64 {
    version
        .split('.')
        .nth(1)
        .and_then(|part| part.parse().ok())
        .unwrap_or_default()
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

fn slash_name(text: &str) -> Option<&str> {
    text.trim_start()
        .strip_prefix('/')?
        .split_whitespace()
        .next()
}

pub(super) fn initialize() -> Value {
    json!({
        "protocolVersion": 1,
        "clientInfo": {"name": "Latte Work", "version": env!("CARGO_PKG_VERSION")},
        "clientCapabilities": {"elicitation":{"form":{}}, "_meta": {(CHILD_CAPABILITY): true}}
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
    let mut commands: Vec<_> = entries
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
        .collect();
    if !seen.contains("compact") {
        commands.push(AgentSlashCommand {
            name: "compact".into(),
            display_name: None,
            description: "压缩当前 OpenCode 会话的上下文".into(),
            argument_hint: String::new(),
            ui_action: None,
        });
    }
    Ok(commands)
}

impl OpenCode {
    fn slash_command<'a>(&self, text: &'a str) -> Option<&'a str> {
        slash_name(text).filter(|name| {
            self.commands
                .as_ref()
                .is_some_and(|commands| commands.iter().any(|c| c.name == *name))
                || !name.contains(['/', '.'])
        })
    }
    fn cancel_questions(&mut self) -> Result<Vec<Action>> {
        std::mem::take(&mut self.native_questions)
            .into_iter()
            .map(|id| self.sideband_request("answer", &id, json!({"questionID":id,"answers":null})))
            .collect()
    }

    fn sideband_request(&self, action: &str, id: &str, body: Value) -> Result<Action> {
        ensure!(self.sideband_ready, "OpenCode 原生事件通道尚未就绪");
        let mut body = body;
        body["action"] = json!(action);
        body["id"] = json!(id);
        if body["sessionID"].is_null() {
            body["sessionID"] = json!(self.session_id()?);
        }
        Ok(Action::SidebandWrite(frame(body)?))
    }

    fn sideband(&mut self, line: &str) -> Result<Vec<Action>> {
        let message: Value = serde_json::from_str(line)?;
        let kind = message["type"].as_str().unwrap_or_default();
        let data = &message["data"];
        if kind == "ready" {
            self.sideband_ready = true;
            let mut actions = self.ready()?;
            if self.session.is_some() && self.saved {
                actions.push(self.sideband_request("get", "title", json!({}))?);
            }
            return Ok(actions);
        }
        if kind == "reply" {
            let id = string(&message, "id")?;
            if id == "initial-title" && self.initial_title_pending {
                self.initial_title_pending = false;
                let mut actions = Vec::new();
                if message["error"] == true {
                    actions.push(Action::Event(EventKind::Notice {
                        text: "OpenCode 未确认初始标题，Latte 保留手动设置的名称。".into(),
                    }));
                }
                actions.extend(self.ready()?);
                return Ok(actions);
            }
            if self
                .rename
                .as_ref()
                .is_some_and(|(pending, _)| pending == id)
            {
                let (_, title) = self.rename.take().expect("matched");
                return Ok(vec![Action::TitleRenamed(if message["error"] == true {
                    Err("OpenCode 未确认标题修改".into())
                } else {
                    Ok(title)
                })]);
            }
            if id == "title" {
                return Ok(self.generated_title(&message["title"]));
            }
            if self.native_command.as_deref() == Some(id) {
                if message["viaACP"] == true {
                    if self.cancelling {
                        return Ok(self.finish_command(true));
                    }
                    let prompt = self.slash_prompt.take().context("OpenCode 命令已失效")?;
                    self.native_command = None;
                    return self.start_prompt(&prompt);
                }
                self.legacy_instructions = None;
                if message["error"] == true || !self.command_waiting_for_end {
                    return Ok(self.finish_command(message["error"] == true));
                }
                self.command_acknowledged = true;
                return Ok(vec![]);
            }
            // Even a failed submission RPC can race with durable admission.
            // Keep a handed-off input pending until its native delivery event.
            return Ok(vec![]);
        }
        if kind == "shell.exited" {
            let id = string(data, "id")?;
            if let Some((tool, child)) = self.background_shells.remove(id) {
                return Ok(vec![shell_result(tool, child, data)]);
            }
            // The native event can arrive before the ACP tool result.
            if self.shell_exits.len() < MAX_TOOLS {
                self.shell_exits.insert(id.into(), data.clone());
            }
            return Ok(vec![]);
        }
        if kind == "session.created" && self.saved {
            let Some(parent) = data["parentID"].as_str() else {
                return Ok(vec![]);
            };
            if self.session.as_deref() != Some(parent) && !self.children.contains_key(parent) {
                return Ok(vec![]);
            }
            let id = string(data, "sessionID")?;
            if let Ok(role) = string(data, "agent")
                && self.child_roles.len() < MAX_CHILDREN
            {
                self.child_roles.insert(id.into(), role.into());
            }
            if !self.children.contains_key(id) {
                let actions = self.child_update(&json!({
                    "rootSessionId":self.session, "parentSessionId":parent,
                    "childSessionId":id,"type":"status","status":"created","title":data["title"],
                }))?;
                if self.children.contains_key(id) {
                    self.native_children.insert(id.into());
                    if self.native_command.is_some()
                        || self.followup
                        || self.command_children.contains(parent)
                    {
                        self.command_children.insert(id.into());
                    }
                }
                return Ok(actions);
            }
            self.native_children.insert(id.into());
            if self.native_command.is_some()
                || self.followup
                || self.command_children.contains(parent)
            {
                self.command_children.insert(id.into());
            }
            if let Some(role) = self.child_roles.get(id) {
                return Ok(vec![Action::Event(EventKind::Subagent {
                    update: SubagentUpdate {
                        id: id.into(),
                        tool_use_id: Some(format!("opencode-child:{id}")),
                        agent_type: Some(role.clone()),
                        title: None,
                        status: None,
                        summary: None,
                        last_tool: None,
                    },
                })]);
            }
            return Ok(vec![]);
        }
        let session = data["sessionID"].as_str();
        if kind == "question"
            && self.saved
            && (session == self.session.as_deref() && (self.running() || self.followup)
                || session.is_some_and(|id| self.children.get(id) == Some(&true)))
        {
            let id = string(data, "id")?;
            let questions = question::native_questions(&data["prompts"]);
            let Some(questions) = questions.filter(|_| !self.cancelling) else {
                return Ok(vec![self.sideband_request(
                    "answer",
                    id,
                    json!({"questionID":id,"answers":null}),
                )?]);
            };
            ensure!(
                self.native_questions.len() < 32 && self.native_questions.insert(id.into()),
                "OpenCode 问题重复或数量超出限制"
            );
            if session != self.session.as_deref() {
                self.child_interactions.insert(id.into());
            }
            return Ok(vec![Action::Question {
                id: id.into(),
                tool_use_id: data["toolCallId"].as_str().map(|tool| {
                    session
                        .filter(|session| Some(*session) != self.session.as_deref())
                        .map_or_else(
                            || tool.to_owned(),
                            |child| format!("opencode-child:{child}:{tool}"),
                        )
                }),
                input: json!({}),
                questions,
            }]);
        }
        if let Some(child) = data["sessionID"]
            .as_str()
            .filter(|id| self.children.contains_key(*id))
        {
            if kind == "permission.asked"
                && self.children.get(child) == Some(&true)
                && self.command_children.contains(child)
            {
                return self.native_permission(data, child);
            }
            if !self.native_children.contains(child) {
                return Ok(vec![]);
            }
            let status = match kind {
                "session.execution.started" => Some(SubagentStatus::Running),
                "session.execution.succeeded" => Some(SubagentStatus::Completed),
                "session.execution.interrupted" => Some(SubagentStatus::Stopped),
                "session.execution.failed" => Some(SubagentStatus::Failed),
                _ => None,
            };
            if let Some(status) = status {
                self.children.insert(child.into(), status.active());
                return Ok(vec![Action::Event(EventKind::Subagent {
                    update: SubagentUpdate {
                        id: child.into(),
                        tool_use_id: Some(format!("opencode-child:{child}")),
                        agent_type: self.child_roles.get(child).cloned(),
                        title: None,
                        status: Some(status),
                        summary: None,
                        last_tool: None,
                    },
                })]);
            }
            // Children announced on the native stream stay on that stream.
            let channel = format!("opencode-child:{child}");
            return self.native_output(kind, data, Some(&channel));
        }
        if !self.saved || data["sessionID"].as_str() != self.session.as_deref() {
            return Ok(vec![]);
        }
        let acp_prompt = self
            .request
            .is_some_and(|(_, kind)| kind == Request::Prompt);
        let background_delivery = kind == "session.inbox.delivered"
            && data["inboxID"]
                .as_str()
                .is_some_and(|id| self.background_inputs.contains(id));
        if acp_prompt
            && (!self.deferred_followup.is_empty()
                || (background_delivery && !self.foreground_inbox_delivered))
            && !matches!(kind, "session.inbox.enqueued" | "session.renamed")
        {
            // ACP acknowledges the foreground turn independently. Hold an
            // identified next execution until that acknowledgement is applied.
            self.deferred_followup_bytes += line.len();
            ensure!(
                self.deferred_followup_bytes <= FRAME_LIMIT && self.deferred_followup.len() < 2048,
                "OpenCode 后台事件等待 ACP 完成时超出限制"
            );
            self.deferred_followup.push(line.into());
            return Ok(vec![]);
        }
        match kind {
            "session.renamed" => Ok(self.generated_title(&data["title"])),
            "session.inbox.enqueued" if data["background"] == true => {
                ensure!(
                    self.background_inputs.len() < MAX_TOOLS,
                    "OpenCode 后台输入超出限制"
                );
                self.background_inputs
                    .insert(string(data, "inboxID")?.into());
                Ok(vec![])
            }
            "session.inbox.delivered" => {
                let inbox = string(data, "inboxID")?;
                if self
                    .steering
                    .as_ref()
                    .is_some_and(|(_, id)| data["inboxID"] == *id)
                {
                    let (request, _) = self.steering.take().expect("matched");
                    return Ok(vec![Action::InputsConsumed(vec![request])]);
                }
                if self.background_inputs.remove(inbox) {
                    // A background notification consumed within the
                    // foreground execution is already visible over ACP.
                    if !self.foreground_inbox_delivered
                        && self.native_command.is_none()
                        && !self.followup
                    {
                        self.followup = true;
                        return Ok(vec![Action::TurnStarted]);
                    }
                } else {
                    self.foreground_inbox_delivered = true;
                }
                Ok(vec![])
            }
            "session.inbox.cancelled" => {
                if let Some(id) = data["inboxID"].as_str() {
                    self.background_inputs.remove(id);
                }
                if self
                    .steering
                    .as_ref()
                    .is_some_and(|(_, id)| data["inboxID"] == *id)
                {
                    let (request_id, _) = self.steering.take().expect("matched");
                    return Ok(vec![Action::InputRejected {
                        request_id,
                        message: "OpenCode 已取消未消费的补充消息".into(),
                    }]);
                }
                Ok(vec![])
            }
            "session.skill.activated" => {
                self.foreground_inbox_delivered = true;
                Ok(vec![])
            }
            "session.execution.started" if self.native_command.is_some() => {
                self.command_waiting_for_end = true;
                self.command_outcome = None;
                Ok(vec![])
            }
            "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted"
                if self.native_command.is_some() =>
            {
                self.command_outcome = Some(kind == "session.execution.succeeded");
                self.command_waiting_for_end = false;
                self.foreground_inbox_delivered = false;
                if self.command_acknowledged {
                    return Ok(self.finish_command(false));
                }
                Ok(vec![])
            }
            "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted"
                if self.followup =>
            {
                self.followup = false;
                self.possible_followup = self.children.values().any(|active| *active)
                    || !self.background_shells.is_empty()
                    || !self.background_inputs.is_empty();
                Ok(self.finish(
                    kind != "session.execution.succeeded",
                    (kind == "session.execution.failed").then(|| "OpenCode 后续执行失败".into()),
                ))
            }
            "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted" => {
                self.foreground_inbox_delivered = false;
                Ok(vec![])
            }
            "permission.asked" if self.followup || self.native_command.is_some() => {
                self.native_permission(data, string(data, "sessionID")?)
            }
            _ if self.followup || self.native_command.is_some() => {
                self.native_output(kind, data, None)
            }
            _ => Ok(vec![]),
        }
    }

    fn native_permission(&mut self, data: &Value, session: &str) -> Result<Vec<Action>> {
        let id = string(data, "id")?;
        if self.cancelling {
            return Ok(vec![self.sideband_request(
                "permission",
                id,
                json!({"sessionID":session,"requestID":id,"allow":false}),
            )?]);
        }
        if self.native_permissions.contains_key(id) {
            return Ok(vec![]);
        }
        ensure!(
            self.native_permissions.len() < 32,
            "OpenCode 后续执行审批超出限制"
        );
        let tool = string(data, "action")?;
        self.native_permissions.insert(id.into(), session.into());
        let child = self.session.as_deref() != Some(session);
        if child {
            self.child_interactions.insert(id.into());
        }
        let mut input = data["metadata"].as_object().cloned().unwrap_or_default();
        if let Some(resources) = data["resources"].as_array() {
            if tool == "shell" && !input.contains_key("command") {
                input.insert(
                    "command".into(),
                    json!(
                        resources
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    ),
                );
            }
            input.insert("resources".into(), json!(resources));
        }
        Ok(vec![Action::Approval {
            id: id.into(),
            tool_use_id: data["source"]["id"].as_str().map(|id| {
                if child {
                    format!("opencode-child:{session}:{id}")
                } else {
                    id.into()
                }
            }),
            tool: if tool == "shell" {
                "Bash".into()
            } else {
                tool.into()
            },
            input: Value::Object(input),
        }])
    }

    fn native_output(
        &mut self,
        kind: &str,
        data: &Value,
        child: Option<&str>,
    ) -> Result<Vec<Action>> {
        let update = match kind {
            "session.text.delta" => json!({
                "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":data["delta"]},
            }),
            "session.reasoning.delta" => json!({"sessionUpdate":"agent_thought_chunk"}),
            "session.tool.input.started"
            | "session.tool.called"
            | "session.tool.success"
            | "session.tool.failed" => {
                let id = string(data, "id")?;
                let id = child.map_or_else(|| id.into(), |child| format!("{child}:{id}"));
                let status = match kind {
                    "session.tool.input.started" => "pending",
                    "session.tool.called" => "in_progress",
                    "session.tool.success" => "completed",
                    _ => "failed",
                };
                let content: Vec<_> = data["content"].as_array().into_iter().flatten()
                    .filter_map(|item| {
                        if item["type"] == "text" {
                            return Some(json!({"type":"content","content":item}));
                        }
                        let (mime, image) = item["uri"].as_str()?.strip_prefix("data:")?.split_once(";base64,")?;
                        Some(json!({"type":"content","content":{"type":"image","mimeType":mime,"data":image}}))
                    }).collect();
                json!({
                    "sessionUpdate": if status == "pending" || (status == "in_progress" && data["name"].is_string()) {"tool_call"} else {"tool_call_update"},
                    "toolCallId":id,"name":data["name"],"rawInput":data["input"],"status":status,
                    "content":content,"rawOutput":{"metadata":data["metadata"],"error":data["error"]["message"]},
                })
            }
            _ => return Ok(vec![]),
        };
        self.events(&update, child)
    }

    fn generated_title(&self, value: &Value) -> Vec<Action> {
        match (self.session.as_ref(), value.as_str()) {
            (Some(session), Some(title))
                if !title.trim().is_empty() && title.chars().count() <= 200 =>
            {
                vec![Action::GeneratedTitle {
                    native_session_id: session.clone(),
                    title: title.into(),
                }]
            }
            _ => vec![],
        }
    }

    fn finish_command(&mut self, error: bool) -> Vec<Action> {
        self.native_command = None;
        self.slash_prompt = None;
        self.command_waiting_for_end = false;
        self.command_acknowledged = false;
        let failed = error || self.command_outcome.take() == Some(false);
        self.finish(failed, failed.then(|| "OpenCode 原生命令执行失败".into()))
    }

    fn finish_prompt(&mut self, failed: bool, message: Option<String>) -> Result<Vec<Action>> {
        let mut actions = self.finish(failed, message);
        self.deferred_followup_bytes = 0;
        for line in std::mem::take(&mut self.deferred_followup) {
            actions.extend(self.sideband(&line)?);
        }
        Ok(actions)
    }

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
        if self.ready
            || self.session.is_none()
            || self.commands.is_none()
            || self.request.is_some()
            || !self.sideband_ready
            || self.initial_title_pending
        {
            return Ok(vec![]);
        }
        if let Some(title) = self.initial_title.take() {
            let rename =
                self.sideband_request("rename", "initial-title", json!({"title":title}))?;
            self.initial_title_pending = true;
            return Ok(vec![rename]);
        }
        self.ready = true;
        let mut actions = vec![Action::Ready];
        if let Some(prompt) = self.prompt.take() {
            actions.extend(self.start(&prompt)?);
        }
        Ok(actions)
    }

    fn start(&mut self, text: &str) -> Result<Vec<Action>> {
        let command = self.slash_command(text);
        if let Some(name) = command
            && !self
                .commands
                .as_ref()
                .is_some_and(|list| list.iter().any(|c| c.name == name))
        {
            return Ok(vec![Action::Finished {
                failed: true,
                message: Some("此 OpenCode 命令尚不支持；消息未发送给模型".into()),
            }]);
        }
        let session = self.session_id()?.to_owned();
        if let Some(name) = command.filter(|name| *name != "compact") {
            if !self.sideband_ready {
                return Ok(vec![Action::Finished {
                    failed: true,
                    message: Some("OpenCode 原生命令通道尚未就绪".into()),
                }]);
            }
            let args = text.trim_start()[name.len() + 1..].trim();
            let id = uuid::Uuid::new_v4().to_string();
            let action = self.sideband_request(
                "command",
                &id,
                json!({"name":name,"text":args,"instructions":self.legacy_instructions}),
            )?;
            self.native_command = Some(id);
            self.slash_prompt = Some(text.trim_start().into());
            self.command_outcome = None;
            self.command_waiting_for_end = false;
            self.command_acknowledged = false;
            self.saved = true;
            self.tools.retain(|_, tool| tool.child);
            return Ok(vec![Action::NativeSession(session), action]);
        }
        self.start_prompt(if command.is_some() {
            text.trim_start()
        } else {
            text
        })
    }

    fn start_prompt(&mut self, text: &str) -> Result<Vec<Action>> {
        let session = self.session_id()?.to_owned();
        let mut blocks = vec![json!({"type":"text", "text":text})];
        if let Some(instructions) = self.legacy_instructions.take() {
            blocks.insert(
                0,
                json!({"type":"text","text":instructions,"annotations":{"audience":["assistant"]}}),
            );
        }
        let action = self.request(
            Request::Prompt,
            "session/prompt",
            json!({
                "sessionId": session, "prompt": blocks
            }),
        )?;
        self.tools.retain(|_, tool| tool.child);
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

    fn select_model(&mut self, catalog: &Value, model: String) -> Result<Vec<Action>> {
        ensure!(
            options(catalog).any(|(id, _)| id == model),
            "模型不在当前 OpenCode 可选列表中，请刷新模型列表"
        );
        self.model = Some(model.clone());
        Ok(vec![self.set_config(Request::Model, "model", &model)?])
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
                return self.finish_prompt(true, Some(rpc_error(error)));
            }
            bail!("{}", rpc_error(error));
        }
        let result = message.get("result").context("OpenCode ACP 缺少响应结果")?;
        match kind {
            Request::Initialize => {
                verify_initialize(result)?;
                let version = string(&result["agentInfo"], "version")?;
                if minor_version(version) >= 3 {
                    self.legacy_instructions = None;
                }
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
                if self.saved && self.sideband_ready {
                    let title = self.sideband_request("get", "title", json!({}))?;
                    let mut actions = self.attach_model(result)?;
                    actions.insert(0, title);
                    return Ok(actions);
                }
                self.attach_model(result)
            }
            Request::DefaultModel => {
                let probe = string(result, "sessionId")?;
                ensure!(
                    Some(probe) != self.session.as_deref(),
                    "OpenCode 模型探针返回了当前会话"
                );
                let catalog =
                    config_option(result, "model").context("OpenCode ACP 未返回默认模型")?;
                let model = string(catalog, "currentValue")?;
                ensure!(
                    options(catalog).any(|(id, _)| id == model),
                    "当前 OpenCode 默认模型不可用"
                );
                self.model = Some(model.into());
                Ok(vec![self.request(
                    Request::DeleteProbe,
                    "session/delete",
                    json!({"sessionId":probe}),
                )?])
            }
            Request::DeleteProbe => {
                let model = self.model.clone().context("OpenCode 未解析默认模型")?;
                Ok(vec![self.set_config(Request::Model, "model", &model)?])
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
                if reason == "end_turn"
                    && !self.children.values().any(|active| *active)
                    && self.background_shells.is_empty()
                    && self.background_inputs.is_empty()
                    && self.deferred_followup.is_empty()
                {
                    self.possible_followup = false;
                }
                actions.extend(self.finish_prompt(message.is_some(), message)?);
                Ok(actions)
            }
        }
    }

    fn attach_model(&mut self, result: &Value) -> Result<Vec<Action>> {
        let catalog = config_option(result, "model").context("OpenCode ACP 未返回模型配置")?;
        self.selected_model = catalog["currentValue"].as_str().map(str::to_owned);
        let available = |model: &str| options(catalog).any(|(id, _)| id == model);
        if self.fallback_model_on_open
            && !self.managed_provider
            && self.model.as_deref().is_some_and(|model| !available(model))
        {
            self.model = None;
            self.effort = None;
        }
        if let Some(model) = self.model.clone() {
            if !available(&model) || catalog["currentValue"] != model {
                return self.select_model(catalog, model);
            }
        } else if !self.selected_model.as_deref().is_some_and(available) {
            return Ok(vec![self.request(
                Request::DefaultModel,
                "session/new",
                json!({"cwd":self.cwd, "mcpServers":[]}),
            )?]);
        }
        self.apply_effort(result)
    }

    fn finish(&mut self, failed: bool, message: Option<String>) -> Vec<Action> {
        self.tools.retain(|_, tool| tool.child);
        self.context = None;
        let mut actions = Vec::new();
        if std::mem::take(&mut self.cancelling) {
            self.approvals.clear();
            self.questions.clear();
            self.native_permissions.clear();
            self.native_questions.clear();
            self.child_interactions.clear();
            self.background_inputs.clear();
            self.foreground_inbox_delivered = false;
            actions.push(Action::Interrupted);
        }
        actions.push(Action::Finished { failed, message });
        actions
    }

    fn running(&self) -> bool {
        self.native_command.is_some()
            || self
                .request
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
        if self.native_children.contains(child) {
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
                if !(self.running() || self.followup || self.possible_followup) || !status.active()
                {
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
                    agent_type: self.child_roles.get(child).cloned(),
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
                tool.child = child.is_some();
                if update["sessionUpdate"] == "tool_call" {
                    tool.name = Some(tool_label(update, None));
                }
                let status = update["status"].as_str();
                let terminal = matches!(status, Some("completed" | "failed"));
                if !tool.shown && (terminal || status == Some("in_progress")) {
                    let name = tool_label(update, tool.name.as_deref());
                    let (name, input) = named_tool(
                        name,
                        update.get("rawInput").cloned().unwrap_or_else(|| json!({})),
                    );
                    actions.push(event(EventKind::Tool {
                        id: id.into(),
                        name,
                        input,
                    }));
                    tool.shown = true;
                }
                if terminal {
                    let metadata = &update["rawOutput"]["metadata"];
                    if metadata["status"] == "running"
                        && let Some(shell) = metadata["shellID"].as_str()
                    {
                        ensure!(
                            self.background_shells.len() < MAX_TOOLS,
                            "OpenCode 后台 Shell 数量超出限制"
                        );
                        if let Some(exit) = self.shell_exits.remove(shell) {
                            actions.push(shell_result(id.into(), child.map(str::to_owned), &exit));
                            self.tools.remove(id);
                            return Ok(actions);
                        }
                        self.background_shells
                            .insert(shell.into(), (id.into(), child.map(str::to_owned)));
                        self.possible_followup = true;
                        actions.push(event(EventKind::Notice {
                            text: format!(
                                "命令已转入后台，结果待确认（工具 ID：{id}，Shell ID：{shell}）"
                            ),
                        }));
                        self.tools.remove(id);
                        return Ok(actions);
                    }
                    let mut images = super::ToolImages::default();
                    let content: Vec<_> = update["content"].as_array().into_iter().flatten()
                        .filter_map(|v| match v["type"].as_str() {
                            Some("content") if v["content"]["type"] == "text" => {
                                Some(json!({"type":"text", "text":v["content"]["text"].as_str()?}))
                            }
                            Some("content") if v["content"]["type"] == "image" => Some(images.inline(
                                v["content"]["mimeType"].as_str().unwrap_or_default(),
                                v["content"]["data"].as_str().unwrap_or_default(),
                            )),
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
        let child = tool["_meta"][CHILD_META]["id"].as_str().or_else(|| {
            tool["toolCallId"]
                .as_str()
                .and_then(|id| id.split_once(':'))
                .map(|(child, _)| child)
                .filter(|child| self.children.contains_key(*child))
        });
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
        if child.is_some() {
            self.child_interactions.insert(key.clone());
        }
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
                    if method == "elicitation/create" {
                        return self.question(id, &message["params"]);
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

    fn question(&mut self, id: &Value, params: &Value) -> Result<Vec<Action>> {
        let belongs = self
            .session
            .as_deref()
            .is_some_and(|session| params["sessionId"] == session);
        if !belongs
            || self.cancelling
            || !(self.running() || self.followup || self.has_background_work())
        {
            return Ok(vec![question_result(id, None)?]);
        }
        let Some((form, questions)) = question::Form::parse(id, params) else {
            return Ok(vec![question_result(id, None)?]);
        };
        let key = serde_json::to_string(id)?;
        ensure!(
            self.questions.len() < 32
                && !self.questions.contains_key(&key)
                && !self.approvals.contains_key(&key),
            "OpenCode 表单请求重复或数量超出限制"
        );
        self.questions.insert(key.clone(), form);
        if params["toolCallId"]
            .as_str()
            .and_then(|id| id.split_once(':'))
            .is_some_and(|(id, _)| self.children.contains_key(id))
        {
            self.child_interactions.insert(key.clone());
        }
        Ok(vec![Action::Question {
            id: key,
            tool_use_id: string(params, "toolCallId").ok().map(str::to_owned),
            input: json!({}),
            questions,
        }])
    }
}

fn tool_label(update: &Value, fallback: Option<&str>) -> String {
    // ACP "execute" covers shell as well as other tools. Only map a
    // structured command (or OpenCode's explicit shell name) to Bash.
    let name = update["name"].as_str();
    if name == Some("skill") || update["title"] == "skill" || fallback == Some("Skill") {
        return "Skill".into();
    }
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

fn named_tool(name: String, mut input: Value) -> (String, Value) {
    if name == "Skill"
        && input["skill"].is_null()
        && let Some(id) = input["id"].as_str()
    {
        input["skill"] = json!(id);
    }
    (name, input)
}

fn permission_result(id: &Value, selected: Option<&str>) -> Result<Action> {
    let outcome = selected.map_or_else(
        || json!({"outcome":"cancelled"}),
        |option_id| json!({"outcome":"selected", "optionId":option_id}),
    );
    write(json!({"jsonrpc":"2.0","id":id,"result":{"outcome":outcome}}))
}

fn question_result(id: &Value, content: Option<Value>) -> Result<Action> {
    let result = content.map_or_else(
        || json!({"action":"cancel"}),
        |content| json!({"action":"accept","content":content}),
    );
    write(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

fn shell_result(id: String, child: Option<String>, data: &Value) -> Action {
    let status = data["status"].as_str().unwrap_or("unknown");
    let code = data["exit"].as_i64();
    let is_error = status != "exited" || code != Some(0);
    let text = if let Some(code) = code {
        format!("后台命令退出，退出码 {code}")
    } else {
        format!("后台命令已结束（{status}）")
    };
    let event = EventKind::ToolResult {
        id,
        content: json!([{"type":"text","text":text}]),
        is_error,
    };
    match child {
        Some(tool_use_id) => Action::SubagentEvent { tool_use_id, event },
        None => Action::Event(event),
    }
}

impl AgentAdapter for OpenCode {
    fn can_reconfigure(&self) -> bool {
        self.can_start_turn() && !self.has_background_work()
    }

    fn can_start_turn(&self) -> bool {
        self.ready
            && !self.followup
            && self.native_command.is_none()
            && self.request.is_none()
            && self.approvals.is_empty()
            && self.questions.is_empty()
            && self.native_questions.is_empty()
            && self.native_permissions.is_empty()
            && self.background_inputs.is_empty()
    }

    fn has_background_work(&self) -> bool {
        !self.background_shells.is_empty()
            || !self.background_inputs.is_empty()
            || self.possible_followup
            || self.children.values().any(|active| *active)
    }

    fn is_child_interaction(&self, id: &str) -> bool {
        self.child_interactions.contains(id)
    }

    fn knows_subagent(&self, _native_id: &str) -> bool {
        // The request handler uses OpenCode export for known, completed children.
        false
    }

    fn set_session_title(&mut self, title: Option<String>, resuming: bool) {
        if !resuming {
            self.initial_title = title;
        }
    }

    fn command(
        &mut self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand> {
        self.cwd = cwd.into();
        self.resume = resume.map(str::to_owned);
        self.saved = self.resume.is_some();
        self.effort = config.effort;
        self.managed_provider = config.provider.is_some();
        let mut command = metadata::command(binary, Some(cwd), &config.environment);
        let directory = tempfile::Builder::new()
            .prefix("lw-oc-")
            .tempdir_in("/tmp")?;
        std::fs::write(
            directory.path().join("index.mjs"),
            include_str!("opencode/index.mjs"),
        )?;
        let listener = tokio::net::UnixListener::bind(directory.path().join("events"))?;
        let sideband = super::Sideband {
            listener,
            _directory: directory,
        };
        let instructions = crate::skills::platform_instructions(&config.settings_dir);
        let (model, settings) =
            config::configure(&mut command, config, &instructions, Some(&sideband))?;
        self.legacy_instructions = (!instructions.is_empty()).then_some(instructions);
        self.model = model;
        Ok(AgentCommand {
            command,
            _settings: settings,
            sideband: Some(sideband),
        })
    }

    fn frame_limit(&self) -> Option<usize> {
        Some(FRAME_LIMIT)
    }

    fn metadata_ready(&self) -> bool {
        self.sideband_ready
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
            Input::Open => {
                self.fallback_model_on_open = true;
                self.begin()
            }
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
            Input::Sideband(line) => self.sideband(line),
            Input::Interrupt if self.followup || self.native_command.is_some() => {
                self.cancelling = true;
                let mut actions = self.cancel_questions()?;
                let mut sessions = HashSet::from([self.session_id()?.to_owned()]);
                sessions.extend(self.native_permissions.values().cloned());
                for session in sessions {
                    actions.push(self.sideband_request(
                        "interrupt",
                        "interrupt",
                        json!({"sessionID":session}),
                    )?);
                }
                Ok(actions)
            }
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
                for (_, request) in self.questions.drain() {
                    actions.push(question_result(&request.wire_id, None)?);
                }
                actions.extend(self.cancel_questions()?);
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
                self.child_interactions.remove(id);
                if let Some(session) = self.native_permissions.remove(id) {
                    return Ok(vec![self.sideband_request(
                        "permission",
                        id,
                        json!({"sessionID":session,"requestID":id,"allow":allow && !self.cancelling}),
                    )?]);
                }
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
            Input::Queue { request_id, prompt } => {
                ensure!(
                    (self.running() || self.followup)
                        && !self.cancelling
                        && self.steering.is_none(),
                    "OpenCode 当前轮无法接收补充消息"
                );
                ensure!(
                    self.slash_command(prompt).is_none(),
                    "请在独立轮次运行 OpenCode 命令"
                );
                let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
                let action =
                    self.sideband_request("steer", &id, json!({"messageID":id,"text":prompt}))?;
                self.steering = Some((request_id.into(), id));
                Ok(vec![action])
            }
            Input::DiscoverCommands => bail!("OpenCode 通过独立 ACP 探针发现命令"),
            Input::RenameTitle { id, title } => {
                ensure!(self.rename.is_none(), "OpenCode 标题修改结果待确认");
                let action = self.sideband_request("rename", id, json!({"title":title}))?;
                self.rename = Some((id.into(), title.into()));
                Ok(vec![action])
            }
            Input::QuestionAnswer {
                id,
                questions,
                answers,
                ..
            } => {
                self.child_interactions.remove(id);
                if self.native_questions.remove(id) {
                    let answers =
                        answers.map(|answers| question::native_answers(&questions, answers));
                    return Ok(vec![self.sideband_request(
                        "answer",
                        id,
                        json!({"questionID":id,"answers":answers}),
                    )?]);
                }
                let form = self.questions.remove(id).context("OpenCode 问题已过期")?;
                let content = answers.map(|answers| form.answer(answers));
                Ok(vec![question_result(&form.wire_id, content)?])
            }
        }
    }
}
