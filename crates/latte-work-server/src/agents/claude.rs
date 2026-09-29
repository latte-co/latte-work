//! Claude Code CLI bidirectional stream-json/control protocol.
//! Compatibility source: anthropics/claude-agent-sdk-python internal query/transport.
use super::{Action, AgentAdapter, AgentCommand, Input};
use crate::providers::LaunchConfig;
use anyhow::{Context, Result, bail};
use latte_work_protocol::{ContextUsage, EventKind, ExecutionPhase, TurnUsage};
use serde_json::{Value, json};
use std::{io::Write, path::PathBuf, process::Stdio, time::Duration};

pub const MODEL_ALIASES: &[&str] = &["sonnet", "opus", "haiku", "fable"];

/// Claude CLI/model capability policy, independent of other agent adapters.
pub fn effort_levels(model: Option<&str>) -> &'static [latte_work_protocol::Effort] {
    use latte_work_protocol::Effort::{High, Low, Max, Medium, Xhigh};
    let model = model.unwrap_or_default().to_ascii_lowercase();
    // CLI aliases can be mapped by a host or gateway. Full known model IDs allow
    // tighter choices; unknown custom IDs are delegated to the CLI/provider.
    if model == "haiku" || model.contains("claude-haiku-") {
        return &[];
    }
    if model.contains("claude-sonnet-4-6") || model.contains("claude-opus-4-6") {
        return &[Low, Medium, High, Max];
    }
    if ["claude-sonnet-4", "claude-opus-4"]
        .iter()
        .any(|prefix| model.contains(prefix))
        && !["claude-opus-4-7", "claude-opus-4-8"]
            .iter()
            .any(|prefix| model.contains(prefix))
    {
        return &[];
    }
    &[Low, Medium, High, Xhigh, Max]
}

/// Discover CLI-supported flags without starting a session or touching user settings.
pub(super) async fn permission_modes(
    binary: &str,
) -> Result<Vec<latte_work_protocol::AgentPermissionMode>> {
    use tokio::io::AsyncReadExt;
    let mut child = crate::agent_environment::command(binary)
        .arg("--help")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("无法读取 Agent 权限选项")?;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .context("Agent 未提供帮助输出")?
            .take(128 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 128 * 1024 {
            bail!("Agent 帮助输出超出限制");
        }
        if !child.wait().await?.success() {
            bail!("Agent 权限能力读取失败");
        }
        modes_from_help(std::str::from_utf8(&bytes)?)
    })
    .await
    .context("读取 Agent 权限选项超时")
    .and_then(|result| result);
    // Also reap on oversized output, protocol errors and timeout.
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

fn modes_from_help(help: &str) -> Result<Vec<latte_work_protocol::AgentPermissionMode>> {
    let option = help
        .split("--permission-mode")
        .nth(1)
        .and_then(|part| part.split("\n  --").next())
        .context("此 CLI 未公布可设置的权限模式，请更新 Agent")?;
    let choices = option
        .split("choices:")
        .nth(1)
        .and_then(|part| part.split(')').next())
        .context("此 CLI 未公布权限模式列表")?;
    let ids: Vec<_> = choices
        .split(',')
        .map(|value| value.trim().trim_matches('"').trim_matches(char::from(39)))
        .collect();
    let manual = if ids.contains(&"manual") {
        "manual"
    } else {
        "default"
    };
    let known = [
        (
            manual,
            "请求批准",
            "按 Agent 的权限规则，对需要确认的操作请求批准。",
            false,
        ),
        (
            "acceptEdits",
            "自动接受编辑",
            "自动批准文件编辑；其他操作仍按 Agent 规则确认。",
            false,
        ),
        (
            "plan",
            "计划模式",
            "分析和规划任务，不直接修改项目文件。",
            false,
        ),
        (
            "auto",
            "自动判断",
            "由 Agent 的安全检查决定是否批准；需账号和策略支持。",
            false,
        ),
        (
            "dontAsk",
            "不询问",
            "只执行已获许可的操作，拒绝其他需要批准的操作。",
            false,
        ),
        (
            "bypassPermissions",
            "完全访问权限",
            "跳过常规权限确认，可执行命令和修改文件；仍受主机策略约束。",
            true,
        ),
    ];
    let modes: Vec<_> = known
        .into_iter()
        .filter(|(id, ..)| ids.contains(id))
        .map(
            |(id, label, description, elevated)| latte_work_protocol::AgentPermissionMode {
                id: id.into(),
                label: label.into(),
                description: description.into(),
                elevated,
            },
        )
        .collect();
    if modes.is_empty() {
        bail!("此 CLI 没有已适配的权限模式");
    }
    Ok(modes)
}

// JSON counters must fit JavaScript's exact integer range on the shared wire.
fn count(value: &Value, key: &str) -> Option<f64> {
    value[key]
        .as_u64()
        .filter(|v| *v <= 9_007_199_254_740_991)
        .map(|v| v as f64)
}

#[derive(Default)]
pub struct Claude {
    streamed: bool,
    emitted_text: bool,
    context: Option<ContextUsage>,
    progress: Option<ExecutionPhase>,
    stream_model: Option<String>,
    stream_usage: Value,
    live_totals: [f64; 4],
    live_steps: f64,
    phase: Phase,
}
// Gateways may return a provider-prefixed model while CLI accounting uses its
// bare name plus a context suffix. Only match that same name, never any model.
fn model_key(model: &str) -> &str {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .split('[')
        .next()
        .unwrap_or(model)
}
impl Claude {
    fn update_context(&mut self, model: &str, usage: &Value) {
        if let Some(input) = count(usage, "input_tokens") {
            let used = input
                + count(usage, "cache_read_input_tokens").unwrap_or(0.0)
                + count(usage, "cache_creation_input_tokens").unwrap_or(0.0);
            // Some gateways emit zero placeholders until message_delta.
            if used > 0.0 {
                self.context = Some(ContextUsage {
                    model: model.into(),
                    used_tokens: used,
                    window_tokens: self
                        .context
                        .as_ref()
                        .filter(|c| c.model == model)
                        .and_then(|c| c.window_tokens),
                });
            }
        }
    }
}
#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Initializing(String),
    Discovering,
    Running,
    Finished,
}

pub(super) async fn discover() -> (String, latte_work_protocol::AgentInfo) {
    let binary = binary();
    let probe = tokio::time::timeout(
        Duration::from_secs(5),
        crate::agent_environment::command(&binary)
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let (available, detail) = match probe {
        Ok(Ok(result)) if result.status.success() => (
            true,
            String::from_utf8_lossy(&result.stdout).trim().to_owned(),
        ),
        _ => (
            false,
            "未找到 Claude Code；在此 Host 安装并登录后重启 Server。".into(),
        ),
    };
    (
        binary,
        latte_work_protocol::AgentInfo {
            id: "claude".into(),
            name: "Claude Code".into(),
            available,
            provider_protocols: super::provider_protocols("claude").unwrap().to_vec(),
            detail,
        },
    )
}
fn binary() -> String {
    if let Ok(value) = std::env::var("LATTE_WORK_CLAUDE") {
        return value;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let path = PathBuf::from(home).join(".local/bin/claude");
        if path.is_file() {
            return path.to_string_lossy().into_owned();
        }
    }
    "claude".into()
}
fn write_action(value: Value) -> Result<Action> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    Ok(Action::Write(bytes))
}

impl AgentAdapter for Claude {
    fn command(
        &mut self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand> {
        let mut command = crate::agent_environment::command(binary);
        command.args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
        ]);
        if matches!(self.phase, Phase::Discovering) {
            command.arg("--no-session-persistence");
        }
        if let Some(id) = resume {
            command.arg(format!("--resume={id}"));
        }
        command.current_dir(cwd).env_remove("CLAUDECODE");
        if let Some(mode) = &config.permission_mode {
            command.arg(format!("--permission-mode={mode}"));
        }
        if let Some(level) = config.effort {
            command.env("CLAUDE_CODE_EFFORT_LEVEL", level.as_str());
            command.arg(format!("--effort={}", level.as_str()));
        }
        let mut settings = if let Some(provider) = &config.provider {
            let metadata = &provider.metadata;
            let model = config.model.as_deref().unwrap_or(&metadata.model);
            let mut env = json!({
                "ANTHROPIC_BASE_URL": metadata.base_url,
                "ANTHROPIC_MODEL": model,
                "ANTHROPIC_DEFAULT_MODEL": model,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
                "ANTHROPIC_DEFAULT_FABLE_MODEL": model,
                "ANTHROPIC_SMALL_FAST_MODEL": model,
                "CLAUDE_CODE_SUBAGENT_MODEL": model,
                "ANTHROPIC_AUTH_TOKEN": "",
                "ANTHROPIC_API_KEY": "",
                "CLAUDE_CODE_OAUTH_TOKEN": "",
                "ANTHROPIC_CUSTOM_HEADERS": "",
                "CLAUDE_CODE_USE_BEDROCK": "",
                "CLAUDE_CODE_USE_VERTEX": "",
                "CLAUDE_CODE_USE_FOUNDRY": ""
            });
            if metadata.protocol != latte_work_protocol::ProviderProtocol::AnthropicMessages {
                bail!("Claude Code 只支持 Anthropic Messages Provider");
            }
            let key = match metadata.auth {
                latte_work_protocol::ProviderAuth::Bearer => "ANTHROPIC_AUTH_TOKEN",
                latte_work_protocol::ProviderAuth::ApiKey => "ANTHROPIC_API_KEY",
            };
            env[key] = json!(provider.credential);
            for (key, value) in env.as_object().expect("env object") {
                command.env(key, value.as_str().expect("env string"));
            }
            command.arg(format!("--model={model}"));
            json!({"env":env,"model":model,"apiKeyHelper":""})
        } else {
            if let Some(model) = &config.model {
                command.arg(format!("--model={model}"));
            } else if resume.is_some() {
                command.arg("--model=default");
            }
            json!({"env":{}})
        };
        if let Some(level) = config.effort {
            settings["env"]["CLAUDE_CODE_EFFORT_LEVEL"] = json!(level.as_str());
        }
        // An absent override leaves native environment/settings resolution intact.
        // Settings env overrides inherited env. Keep turn-specific effort and
        // credentials in a private file; never change the user's CLI settings.
        let mut file = tempfile::Builder::new()
            .prefix("claude-launch-")
            .suffix(".json")
            .tempfile_in(&config.settings_dir)?;
        file.write_all(&serde_json::to_vec(&settings)?)?;
        file.flush()?;
        command.arg("--settings").arg(file.path());
        Ok(AgentCommand {
            command,
            _settings: Some(file),
        })
    }
    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>> {
        match input {
            Input::DiscoverCommands => {
                if !matches!(self.phase, Phase::Idle) {
                    bail!("Claude 已经启动");
                }
                self.phase = Phase::Discovering;
                Ok(vec![write_action(self.initialize())?])
            }

            Input::Start { prompt } => {
                if !matches!(self.phase, Phase::Idle) {
                    bail!("Claude 本轮已经启动");
                }
                self.phase = Phase::Initializing(prompt.to_owned());
                Ok(vec![write_action(self.initialize())?])
            }
            Input::Message(line) => {
                if matches!(self.phase, Phase::Idle | Phase::Finished) {
                    bail!("Claude 本轮未启动或已结束");
                }
                self.decode(serde_json::from_str(line).context("Claude 返回无效 JSON")?)
            }
            Input::Approval { id, input, allow } => {
                if !matches!(self.phase, Phase::Running) {
                    bail!("Claude 当前不可处理审批");
                }
                Ok(vec![write_action(self.approval(id, input, allow))?])
            }
        }
    }
}
impl Claude {
    fn initialize(&self) -> Value {
        json!({"type":"control_request","request_id":"latte-init","request":{"subtype":"initialize"}})
    }
    fn prompt(&self, text: &str) -> Value {
        json!({"type":"user","message":{"role":"user","content":text},"parent_tool_use_id":null,"session_id":""})
    }
    fn approval(&self, id: &str, input: Value, allow: bool) -> Value {
        let response = if allow {
            json!({"behavior":"allow","updatedInput":input})
        } else {
            json!({"behavior":"deny","message":"用户拒绝了本次工具调用"})
        };
        json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}})
    }
    fn decode(&mut self, m: Value) -> Result<Vec<Action>> {
        let mut output = Vec::new();
        match m["type"].as_str().unwrap_or_default() {
            "control_response" if m["response"]["request_id"] == "latte-init" => {
                if m["response"]["subtype"] != "success" {
                    bail!("Claude 初始化失败: {}", m["response"]["error"]);
                }
                if matches!(self.phase, Phase::Discovering) {
                    let commands = parse_commands(&m["response"]["response"]["commands"])?;
                    self.phase = Phase::Finished;
                    return Ok(vec![Action::Commands(commands)]);
                }
                if matches!(self.phase, Phase::Initializing(_)) {
                    let Phase::Initializing(prompt) =
                        std::mem::replace(&mut self.phase, Phase::Running)
                    else {
                        unreachable!()
                    };
                    if let Some(name) = prompt
                        .trim_start()
                        .strip_prefix('/')
                        .and_then(|s| s.split_whitespace().next())
                    {
                        let commands = parse_commands(&m["response"]["response"]["commands"])?;
                        let alias = m["response"]["response"]["commands"]
                            .as_array()
                            .is_some_and(|items| {
                                items.iter().any(|item| {
                                    item["aliases"].as_array().is_some_and(|aliases| {
                                        aliases.iter().any(|alias| alias.as_str() == Some(name))
                                    })
                                })
                            });
                        if !commands.iter().any(|command| command.name == name) && !alias {
                            bail!("当前 Claude 不支持命令 /{name}；输入 / 查看可用命令");
                        }
                    }
                    output.push(Action::Ready);
                    output.push(write_action(self.prompt(&prompt))?);
                }
            }
            "system" if m["subtype"] == "init" => {
                if let Some(id) = m["session_id"].as_str() {
                    output.push(Action::NativeSession(id.into()));
                }
            }
            "system" if m["subtype"] == "compact_boundary" => {
                self.context = None;
                output.push(Action::Event(EventKind::Usage {
                    context: None,
                    totals: None,
                }));
            }
            "conversation_reset" => {
                self.context = None;
                output.push(Action::Event(EventKind::Usage {
                    context: None,
                    totals: None,
                }));
            }
            "control_request" => {
                let id = m["request_id"].as_str().unwrap_or_default().to_owned();
                let request = &m["request"];
                if request["subtype"] == "can_use_tool" {
                    if id.is_empty() || !request["input"].is_object() {
                        bail!("无效的 Claude 审批请求");
                    }
                    output.push(Action::Approval {
                        id,
                        tool_use_id: request["tool_use_id"].as_str().map(str::to_owned),
                        tool: request["tool_name"].as_str().unwrap_or("Tool").into(),
                        input: request["input"].clone(),
                    });
                } else {
                    output.push(write_action(json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported control request in Latte Work v0.1"}}))?);
                }
            }
            "stream_event" => {
                let event = &m["event"];
                if m["parent_tool_use_id"].is_null() {
                    match event["type"].as_str() {
                        Some("message_start") => {
                            self.stream_model =
                                event["message"]["model"].as_str().map(str::to_owned);
                            self.stream_usage = event["message"]["usage"].clone();
                        }
                        Some("message_delta") => {
                            if let Some(model) = self.stream_model.clone()
                                && let Some(delta) = event["usage"].as_object()
                            {
                                if !self.stream_usage.is_object() {
                                    self.stream_usage = json!({});
                                }
                                self.stream_usage
                                    .as_object_mut()
                                    .unwrap()
                                    .extend(delta.clone());
                                let usage = self.stream_usage.clone();
                                self.update_context(&model, &usage);
                                let keys = [
                                    "input_tokens",
                                    "cache_read_input_tokens",
                                    "cache_creation_input_tokens",
                                    "output_tokens",
                                ];
                                let current = keys.map(|key| count(&usage, key).unwrap_or(0.0));
                                if current[0] + current[1] + current[2] > 0.0 {
                                    output.push(Action::Event(EventKind::Usage {
                                        context: self.context.clone(),
                                        totals: Some(TurnUsage {
                                            input_tokens: Some(self.live_totals[0] + current[0]),
                                            cache_read_tokens: Some(
                                                self.live_totals[1] + current[1],
                                            ),
                                            cache_write_tokens: Some(
                                                self.live_totals[2] + current[2],
                                            ),
                                            output_tokens: count(&usage, "output_tokens")
                                                .map(|v| self.live_totals[3] + v),
                                            model_time_ms: None,
                                            steps: Some(self.live_steps + 1.0),
                                        }),
                                    }));
                                }
                            }
                        }
                        Some("message_stop") if self.stream_model.take().is_some() => {
                            for (i, key) in [
                                "input_tokens",
                                "cache_read_input_tokens",
                                "cache_creation_input_tokens",
                                "output_tokens",
                            ]
                            .iter()
                            .enumerate()
                            {
                                self.live_totals[i] +=
                                    count(&self.stream_usage, key).unwrap_or(0.0);
                            }
                            self.live_steps += 1.0;
                        }
                        _ => {}
                    }
                    let phase = match event["type"].as_str() {
                        Some("content_block_start") => {
                            match event["content_block"]["type"].as_str() {
                                Some("thinking" | "redacted_thinking") => {
                                    Some(ExecutionPhase::Thinking)
                                }
                                Some("text") => Some(ExecutionPhase::Replying),
                                _ => Some(ExecutionPhase::Waiting),
                            }
                        }
                        Some("content_block_delta") => match event["delta"]["type"].as_str() {
                            Some("thinking_delta") => Some(ExecutionPhase::Thinking),
                            // Existing Text events already signal reply streaming.
                            _ => None,
                        },
                        Some("message_start" | "message_stop" | "content_block_stop") => {
                            Some(ExecutionPhase::Waiting)
                        }
                        _ => None,
                    };
                    if let Some(phase) = phase
                        && self.progress != Some(phase)
                    {
                        self.progress = Some(phase);
                        output.push(Action::Event(EventKind::Progress { phase }));
                    }
                }
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "text_delta"
                    && let Some(text) = event["delta"]["text"].as_str()
                {
                    self.progress = Some(ExecutionPhase::Replying);
                    self.streamed = true;
                    self.emitted_text = true;
                    output.push(Action::Event(EventKind::Text { text: text.into() }));
                }
            }
            "assistant" => {
                if m["parent_tool_use_id"].is_null() {
                    let message = &m["message"];
                    let usage = &message["usage"];
                    let previous = self.context.clone();
                    if let Some(model) = message["model"].as_str() {
                        self.update_context(model, usage);
                    }
                    if self.context != previous {
                        output.push(Action::Event(EventKind::Usage {
                            context: self.context.clone(),
                            totals: None,
                        }));
                    }
                }
                if let Some(blocks) = m["message"]["content"].as_array() {
                    for block in blocks {
                        match block["type"].as_str().unwrap_or_default() {
                            "text" if !self.streamed => {
                                if let Some(text) = block["text"].as_str() {
                                    self.emitted_text = true;
                                    output
                                        .push(Action::Event(EventKind::Text { text: text.into() }));
                                }
                            }
                            "tool_use" => {
                                output.push(Action::Event(EventKind::Tool {
                                    id: block["id"].as_str().unwrap_or_default().into(),
                                    name: block["name"].as_str().unwrap_or("Tool").into(),
                                    input: block["input"].clone(),
                                }));
                            }
                            _ => {}
                        }
                    }
                }
                self.streamed = false;
            }
            "user" => {
                if let Some(blocks) = m["message"]["content"].as_array() {
                    for block in blocks {
                        if block["type"] == "tool_result" {
                            output.push(Action::Event(EventKind::ToolResult {
                                id: block["tool_use_id"].as_str().unwrap_or_default().into(),
                                content: block["content"].clone(),
                                is_error: block["is_error"].as_bool().unwrap_or(false),
                            }));
                        }
                    }
                }
            }
            "result" => {
                if !matches!(self.phase, Phase::Running) {
                    bail!("Claude 在初始化完成前返回了任务结果");
                }
                self.phase = Phase::Finished;
                if let Some(context) = &mut self.context {
                    let models = m["modelUsage"].as_object();
                    let exact = m["modelUsage"].get(&context.model);
                    let matching: Vec<_> = models
                        .into_iter()
                        .flat_map(|models| models.iter())
                        .filter(|(name, _)| model_key(name) == model_key(&context.model))
                        .map(|(_, usage)| usage)
                        .collect();
                    context.window_tokens = exact
                        .or_else(|| (matching.len() == 1).then(|| matching[0]))
                        .and_then(|usage| count(usage, "contextWindow"))
                        .filter(|v| *v > 0.0);
                }
                let usage = &m["usage"];
                if self.context.is_some() || usage.is_object() {
                    output.push(Action::Event(EventKind::Usage {
                        context: self.context.clone(),
                        totals: Some(TurnUsage {
                            input_tokens: count(usage, "input_tokens"),
                            cache_read_tokens: count(usage, "cache_read_input_tokens"),
                            cache_write_tokens: count(usage, "cache_creation_input_tokens"),
                            output_tokens: count(usage, "output_tokens"),
                            model_time_ms: count(&m, "duration_api_ms"),
                            steps: count(&m, "num_turns"),
                        }),
                    }));
                }
                let failed = m["is_error"].as_bool().unwrap_or(false)
                    || m["subtype"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("error"));
                let message = if failed {
                    Some(
                        m["result"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| m["errors"].to_string()),
                    )
                } else {
                    None
                };
                // Native commands may only return their output in result, without
                // assistant text. Preserve that output without duplicating a turn.
                if !failed
                    && !self.emitted_text
                    && let Some(text) = m["result"].as_str().filter(|text| !text.is_empty())
                {
                    output.push(Action::Event(EventKind::Text { text: text.into() }));
                }
                output.push(Action::Finished { failed, message });
            }
            _ => {}
        }
        Ok(output)
    }
}
fn parse_commands(value: &Value) -> Result<Vec<latte_work_protocol::AgentSlashCommand>> {
    let entries = value
        .as_array()
        .context("此 Claude CLI 未返回命令列表，请更新 CLI 后重试")?;
    if entries.len() > 2000 {
        bail!("Agent 命令列表超出限制");
    }
    let mut names = std::collections::HashSet::new();
    let mut result = Vec::new();
    for entry in entries {
        let name = entry["name"].as_str().context("无效的 Agent 命令名称")?;
        if name.is_empty()
            || name.len() > 256
            || name
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '/')
        {
            bail!("无效的 Agent 命令名称");
        }
        if !names.insert(name.to_owned()) {
            continue;
        }
        let description = entry["description"].as_str().unwrap_or_default();
        let argument_hint = entry["argumentHint"].as_str().unwrap_or_default();
        result.push(latte_work_protocol::AgentSlashCommand {
            name: name.into(),
            display_name: ["displayName", "display_name", "title"]
                .iter()
                .filter_map(|key| entry[key].as_str())
                .map(str::trim)
                .find(|value| {
                    !value.is_empty()
                        && value.chars().count() <= 80
                        && !value.chars().any(char::is_control)
                })
                .map(str::to_owned),
            description: description.chars().take(2048).collect(),
            argument_hint: argument_hint.chars().take(512).collect(),
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn thinking_status_is_deduplicated_and_never_carries_reasoning_text() {
        use super::*;
        let mut agent = Claude::default();
        let thinking = json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private reasoning"}}});
        let actions = agent.decode(thinking.clone()).unwrap();
        assert!(matches!(
            &actions[..],
            [Action::Event(EventKind::Progress {
                phase: ExecutionPhase::Thinking
            })]
        ));
        assert!(agent.decode(thinking.clone()).unwrap().is_empty());
        let mut child = thinking;
        child["parent_tool_use_id"] = json!("child");
        assert!(agent.decode(child).unwrap().is_empty());
        let stopped = agent
            .decode(json!({"type":"stream_event","event":{"type":"content_block_stop"}}))
            .unwrap();
        assert!(matches!(
            &stopped[..],
            [Action::Event(EventKind::Progress {
                phase: ExecutionPhase::Waiting
            })]
        ));
        let reply = agent.decode(json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}})).unwrap();
        assert!(matches!(
            &reply[..],
            [Action::Event(EventKind::Progress {
                phase: ExecutionPhase::Replying
            })]
        ));
    }

    #[test]
    fn usage_is_request_snapshot_not_cumulative_and_excludes_subagents() {
        use super::*;
        let mut agent = Claude {
            phase: Phase::Running,
            ..Default::default()
        };
        let message = json!({"type":"assistant", "message":{"model":"m", "usage":{
            "input_tokens":100,"cache_read_input_tokens":600,"cache_creation_input_tokens":300,"output_tokens":1
        },"content":[]}});
        let first = agent.decode(message.clone()).unwrap();
        assert!(
            matches!(&first[0], Action::Event(EventKind::Usage { context:Some(c), .. }) if c.used_tokens == 1000.0)
        );
        assert!(agent.decode(message.clone()).unwrap().is_empty());
        let mut child = message.clone();
        child["parent_tool_use_id"] = json!("child");
        child["message"]["usage"]["input_tokens"] = json!(9000);
        assert!(agent.decode(child).unwrap().is_empty());
        let result = agent.decode(json!({"type":"result","modelUsage":{"m":{"contextWindow":200000,"inputTokens":9999999}},"usage":{"input_tokens":200,"cache_read_input_tokens":1200,"cache_creation_input_tokens":600,"output_tokens":80},"duration_api_ms":52500,"num_turns":3})).unwrap();
        assert!(
            matches!(&result[0], Action::Event(EventKind::Usage {context:Some(c),totals:Some(t)}) if c.used_tokens == 1000.0 && c.window_tokens == Some(200000.0) && t.output_tokens == Some(80.0) && t.steps == Some(3.0))
        );
        agent
            .decode(json!({"type":"system","subtype":"compact_boundary"}))
            .unwrap();
        assert!(agent.context.is_none());
    }
    #[test]
    fn usage_reads_gateway_delta_and_matches_accounting_model() {
        use super::*;
        let mut agent = Claude {
            phase: Phase::Running,
            ..Default::default()
        };
        let start = json!({"type":"stream_event","event":{"type":"message_start","message":{"model":"ark/seed-evolving","usage":{"input_tokens":0,"output_tokens":0}}}});
        agent.decode(start.clone()).unwrap();
        agent.decode(json!({"type":"assistant","message":{"model":"ark/seed-evolving","usage":{"input_tokens":0,"output_tokens":0},"content":[]}})).unwrap();
        assert!(agent.context.is_none());
        let delta = json!({"type":"stream_event","event":{"type":"message_delta","usage":{"input_tokens":1784,"cache_read_input_tokens":72504,"output_tokens":1100}}});
        for _ in 0..2 {
            let events = agent.decode(delta.clone()).unwrap();
            assert!(events.iter().any(|e| matches!(e, Action::Event(EventKind::Usage {context:Some(c),totals:Some(t)}) if c.used_tokens == 74288.0 && t.input_tokens == Some(1784.0) && t.steps == Some(1.0))));
        }
        agent
            .decode(json!({"type":"stream_event","event":{"type":"message_stop"}}))
            .unwrap();
        agent.decode(start).unwrap();
        let events = agent.decode(delta).unwrap();
        assert!(events.iter().any(|e| matches!(e, Action::Event(EventKind::Usage {context:Some(c),totals:Some(t)}) if c.used_tokens == 74288.0 && t.input_tokens == Some(3568.0) && t.steps == Some(2.0))));
        let result = agent.decode(json!({"type":"result","modelUsage":{"seed-evolving[1m]":{"contextWindow":1000000}},"usage":{"input_tokens":3568,"cache_read_input_tokens":145008,"cache_creation_input_tokens":0,"output_tokens":2200},"duration_api_ms":84356,"num_turns":2})).unwrap();
        assert!(
            matches!(&result[0],Action::Event(EventKind::Usage {context:Some(c),totals:Some(t)}) if c.window_tokens == Some(1000000.0) && c.used_tokens == 74288.0 && t.model_time_ms == Some(84356.0))
        );
    }

    #[test]
    fn usage_missing_capacity_and_invalid_counters_are_not_guessed() {
        use super::*;
        assert_eq!(count(&json!({"n":-1}), "n"), None);
        assert_eq!(count(&json!({"n":9007199254740992_u64}), "n"), None);
        let mut agent = Claude {
            phase: Phase::Running,
            ..Default::default()
        };
        agent
            .decode(json!({"type":"assistant","message":{"model":"m","usage":{"input_tokens":12}}}))
            .unwrap();
        let result = agent
            .decode(json!({"type":"result","modelUsage":{"other":{"contextWindow":1000000}}}))
            .unwrap();
        assert!(
            matches!(&result[0],Action::Event(EventKind::Usage {context:Some(c),..}) if c.window_tokens.is_none())
        );
    }

    #[test]
    fn usage_does_not_use_subagent_deltas_or_ambiguous_capacity() {
        use super::*;
        let mut agent = Claude {
            phase: Phase::Running,
            ..Default::default()
        };
        agent
            .decode(
                json!({"type":"assistant","message":{"model":"ark/m","usage":{"input_tokens":12}}}),
            )
            .unwrap();
        for event in [
            json!({"type":"message_start","message":{"model":"child","usage":{"input_tokens":999}}}),
            json!({"type":"message_delta","usage":{"input_tokens":999}}),
            json!({"type":"message_stop"}),
        ] {
            agent
                .decode(json!({"type":"stream_event","parent_tool_use_id":"child","event":event}))
                .unwrap();
        }
        assert_eq!(agent.context.as_ref().unwrap().used_tokens, 12.0);
        assert_eq!(agent.live_steps, 0.0);
        let result = agent.decode(json!({"type":"result","modelUsage":{"m[1m]":{"contextWindow":1000000},"m":{"contextWindow":200000}}})).unwrap();
        assert!(
            matches!(&result[0], Action::Event(EventKind::Usage {context:Some(c),..}) if c.window_tokens.is_none())
        );
    }

    #[test]
    fn permission_choices_follow_installed_cli_and_do_not_invent_modes() {
        let modes = super::modes_from_help(
            "--permission-mode <mode> (choices: \"default\", \"plan\")\n  --other auto",
        )
        .unwrap();
        assert_eq!(
            modes.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["default", "plan"]
        );
        let modern = super::modes_from_help("--permission-mode <mode>\n (choices: \"manual\", \"auto\",\n \"bypassPermissions\", \"future-mode\")").unwrap();
        assert_eq!(
            modern.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["manual", "auto", "bypassPermissions"]
        );
        assert!(modern.last().unwrap().elevated);
        assert!(super::modes_from_help("--other (choices: \"auto\")").is_err());
        assert!(
            super::modes_from_help("--permission-mode <mode>\n  --other (choices: \"auto\")")
                .is_err()
        );
        assert!(
            super::modes_from_help("--permission-mode <mode> (choices: \"future-mode\")").is_err()
        );
    }

    #[test]
    fn permission_launch_omits_inheritance_and_passes_explicit_modes_on_resume() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::providers::LaunchConfig {
            provider: None,
            model: None,
            effort: None,
            permission_mode: None,
            settings_dir: dir.path().into(),
        };
        for mode in [None, Some("plan"), Some("bypassPermissions"), None] {
            config.permission_mode = mode.map(str::to_owned);
            let mut adapter = super::Claude::default();
            let launch = super::AgentAdapter::command(
                &mut adapter,
                "claude",
                "/tmp",
                Some("native"),
                &config,
            )
            .unwrap();
            let args: Vec<_> = launch
                .command
                .as_std()
                .get_args()
                .map(|v| v.to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                args.iter()
                    .find(|a| a.starts_with("--permission-mode="))
                    .cloned(),
                mode.map(|m| format!("--permission-mode={m}"))
            );
            assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"
                || a == "--allow-dangerously-skip-permissions"));
        }
    }

    #[test]
    fn discovers_native_commands_without_sending_a_prompt() {
        let mut adapter = Claude::default();
        assert_eq!(
            encoded(&adapter.advance(Input::DiscoverCommands).unwrap())[0]["request"]["subtype"],
            "initialize"
        );
        let response = json!({"type":"control_response","response":{"request_id":"latte-init","subtype":"success","response":{"commands":[{"name":"compact","displayName":"Compact conversation","description":"Compact history","argumentHint":"[instructions]"},{"name":"project:check","description":"Project command"}]}}});
        let actions = message(&mut adapter, response).unwrap();
        assert!(encoded(&actions).is_empty());
        assert!(
            matches!(&actions[0], Action::Commands(commands) if commands.len() == 2 && commands[0].argument_hint == "[instructions]" && commands[0].display_name.as_deref() == Some("Compact conversation"))
        );
        assert!(parse_commands(&json!(null)).is_err());
        assert!(parse_commands(&json!([{"name":"bad name"}])).is_err());
    }
    #[test]
    fn dispatches_native_commands_verbatim_and_rejects_unknown_commands() {
        let response = json!({"type":"control_response","response":{"request_id":"latte-init","subtype":"success","response":{"commands":[{"name":"compact"}]}}});
        let mut adapter = Claude::default();
        adapter
            .advance(Input::Start {
                prompt: "/compact 保留关键结论",
            })
            .unwrap();
        let actions = message(&mut adapter, response.clone()).unwrap();
        assert_eq!(
            encoded(&actions)[0]["message"]["content"],
            "/compact 保留关键结论"
        );
        let result = message(
            &mut adapter,
            json!({"type":"result","is_error":false,"result":"Not enough messages to compact."}),
        )
        .unwrap();
        assert!(
            matches!(&result[0], Action::Event(EventKind::Text { text }) if text == "Not enough messages to compact.")
        );
        let mut adapter = Claude::default();
        adapter
            .advance(Input::Start {
                prompt: "/not-supported",
            })
            .unwrap();
        assert!(message(&mut adapter, response).is_err());
    }

    #[test]
    fn effort_choices_follow_claude_model_capabilities() {
        use latte_work_protocol::Effort::{High, Low, Max, Medium, Xhigh};
        for model in ["haiku", "claude-haiku-4-5", "claude-sonnet-4-5"] {
            assert!(super::effort_levels(Some(model)).is_empty());
        }
        assert_eq!(
            super::effort_levels(Some("claude-sonnet-4-6")),
            &[Low, Medium, High, Max]
        );
        assert_eq!(
            super::effort_levels(Some("claude-opus-4-7")),
            &[Low, Medium, High, Xhigh, Max]
        );
    }

    use super::*;
    #[test]
    fn provider_settings_are_private_ephemeral_and_default_is_unchanged() {
        use crate::providers::ResolvedProvider;
        use latte_work_protocol::{Provider, ProviderAuth, ProviderProtocol};
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut config = LaunchConfig {
            provider: None,
            model: None,
            effort: None,
            permission_mode: None,
            settings_dir: dir.path().into(),
        };
        let default = Claude::default()
            .command("claude", "/tmp", None, &config)
            .unwrap();
        let settings: Value = serde_json::from_slice(
            &std::fs::read(default._settings.as_ref().unwrap().path()).unwrap(),
        )
        .unwrap();
        assert_eq!(settings, json!({"env":{}}));
        assert!(
            !default
                .command
                .as_std()
                .get_envs()
                .any(|(key, _)| key == "CLAUDE_CODE_EFFORT_LEVEL")
        );
        config.provider = Some(ResolvedProvider {
            metadata: Provider {
                id: "one".into(),
                name: "Team".into(),
                protocol: ProviderProtocol::AnthropicMessages,
                base_url: "https://example.test".into(),
                model: "my-model".into(),
                models: vec![],
                auth: ProviderAuth::Bearer,
                has_credential: true,
                revision: "test".into(),
            },
            credential: "only-in-private-settings".into(),
        });
        let prepared = Claude::default()
            .command("claude", "/tmp", Some("native-session"), &config)
            .unwrap();
        let path = prepared._settings.as_ref().unwrap().path().to_owned();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let settings: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            settings["env"]["ANTHROPIC_AUTH_TOKEN"],
            "only-in-private-settings"
        );
        assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "");
        assert_eq!(
            settings["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
            "my-model"
        );
        let args = prepared
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy())
            .collect::<Vec<_>>();
        assert!(args.contains(&"--model=my-model".into()));
        assert!(args.contains(&"--resume=native-session".into()));
        assert!(!args.iter().any(|a| a.contains("only-in-private-settings")));
        drop(prepared);
        assert!(!path.exists());
    }
    fn message(adapter: &mut dyn AgentAdapter, value: Value) -> Result<Vec<Action>> {
        adapter.advance(Input::Message(&value.to_string()))
    }
    fn encoded(actions: &[Action]) -> Vec<Value> {
        actions
            .iter()
            .filter_map(|action| match action {
                Action::Write(bytes) => {
                    assert_eq!(bytes.last(), Some(&b'\n'));
                    Some(serde_json::from_slice(bytes).unwrap())
                }
                _ => None,
            })
            .collect()
    }
    fn initialized() -> Value {
        json!({"type":"control_response","response":{"request_id":"latte-init","subtype":"success"}})
    }
    #[test]
    fn adapter_owns_handshake_and_sends_prompt_exactly_once() {
        let mut adapter = super::super::create("claude").unwrap();
        let start = adapter
            .advance(Input::Start {
                prompt: "hello\n你好",
            })
            .unwrap();
        assert!(!start.iter().any(|a| matches!(a, Action::Ready)));
        let outgoing = encoded(&start);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0]["request"]["subtype"], "initialize");
        let unrelated = message(adapter.as_mut(), json!({"type":"control_response","response":{"request_id":"another","subtype":"success"}})).unwrap();
        assert!(unrelated.is_empty());
        let ready = message(adapter.as_mut(), initialized()).unwrap();
        assert!(matches!(ready[0], Action::Ready));
        let outgoing = encoded(&ready);
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0]["message"]["content"], "hello\n你好");
        assert!(message(adapter.as_mut(), initialized()).unwrap().is_empty());
        assert!(
            adapter
                .advance(Input::Start {
                    prompt: "must not replay"
                })
                .is_err()
        );
    }
    #[test]
    fn adapter_rejects_failed_handshake_malformed_input_and_premature_completion() {
        let mut adapter = Claude::default();
        assert!(message(&mut adapter, initialized()).is_err());
        adapter
            .advance(Input::Start {
                prompt: "must not send",
            })
            .unwrap();
        assert!(
            adapter
                .advance(Input::Approval {
                    id: "r",
                    input: json!({}),
                    allow: true
                })
                .is_err()
        );
        assert!(message(&mut adapter, json!({"type":"control_response","response":{"request_id":"latte-init","subtype":"error","error":"denied"}})).is_err());
        assert!(adapter.advance(Input::Message("invalid JSON")).is_err());
        assert!(message(&mut adapter, json!({"type":"result","is_error":false})).is_err());
    }
    #[test]
    fn adapter_encodes_approval_and_finishes_only_on_native_result() {
        let mut adapter = Claude::default();
        adapter.advance(Input::Start { prompt: "approve" }).unwrap();
        message(&mut adapter, initialized()).unwrap();
        let approval = message(&mut adapter, json!({"type":"control_request","request_id":"native-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a.txt"}}})).unwrap();
        assert!(matches!(&approval[0], Action::Approval {id, ..} if id == "native-1"));
        assert!(encoded(&approval).is_empty());
        let replies = adapter
            .advance(Input::Approval {
                id: "native-1",
                input: json!({"file_path":"a.txt"}),
                allow: true,
            })
            .unwrap();
        let wire = encoded(&replies);
        assert_eq!(wire[0]["response"]["request_id"], "native-1");
        assert_eq!(
            wire[0]["response"]["response"]["updatedInput"]["file_path"],
            "a.txt"
        );
        let text = message(
            &mut adapter,
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}),
        )
        .unwrap();
        assert!(
            !text
                .iter()
                .any(|action| matches!(action, Action::Finished { .. }))
        );
        let result = message(&mut adapter, json!({"type":"result","is_error":false})).unwrap();
        assert!(matches!(result[0], Action::Finished { failed: false, .. }));
        assert!(message(&mut adapter, initialized()).is_err());
        assert!(
            adapter
                .advance(Input::Approval {
                    id: "native-1",
                    input: json!({}),
                    allow: true
                })
                .is_err()
        );
    }
    #[test]
    fn streams_without_duplicating_final_message() {
        let mut a = Claude::default();
        assert_eq!(a.decode(json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}})).unwrap().len(),1);
        assert!(
            a.decode(
                json!({"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}})
            )
            .unwrap()
            .is_empty()
        );
    }
    #[test]
    fn approvals_are_explicit_and_native_errors_fail() {
        let mut a = Claude::default();
        let response = a.approval("r", json!({"command":"pwd"}), true);
        assert_eq!(
            response["response"]["response"]["updatedInput"]["command"],
            "pwd"
        );
        assert_eq!(
            a.approval("r", json!({}), false)["response"]["response"]["behavior"],
            "deny"
        );
        assert!(a.decode(json!({"type":"control_response","response":{"request_id":"latte-init","subtype":"error","error":"bad"}})).is_err());
        a.phase = Phase::Running;
        assert!(matches!(
            &a.decode(json!({"type":"result","is_error":true,"result":"auth failed"}))
                .unwrap()[0],
            Action::Finished { failed: true, .. }
        ));
    }
}
