//! Claude Code CLI bidirectional stream-json/control protocol.
//! Compatibility source: anthropics/claude-agent-sdk-python internal query/transport.
use super::{Action, AgentAdapter, AgentCommand, Input};
use crate::providers::LaunchConfig;
use anyhow::{Context, Result, bail};
use latte_work_protocol::EventKind;
use serde_json::{Value, json};
use std::{io::Write, path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

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

#[derive(Default)]
pub struct Claude {
    streamed: bool,
    phase: Phase,
}
#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Initializing(String),
    Running,
    Finished,
}

pub(super) async fn discover() -> (String, latte_work_protocol::AgentInfo) {
    let binary = binary();
    let probe = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(&binary)
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
        let mut command = Command::new(binary);
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
        if let Some(id) = resume {
            command.arg(format!("--resume={id}"));
        }
        command.current_dir(cwd).env_remove("CLAUDECODE");
        let effort = config
            .effort
            .map_or("auto", latte_work_protocol::Effort::as_str);
        command.env("CLAUDE_CODE_EFFORT_LEVEL", effort);
        if let Some(level) = config.effort {
            command.arg(format!("--effort={}", level.as_str()));
        }
        let settings = if let Some(provider) = &config.provider {
            let metadata = &provider.metadata;
            let model = config.model.as_deref().unwrap_or(&metadata.model);
            let mut env = json!({
                "CLAUDE_CODE_EFFORT_LEVEL": effort,
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
            json!({"env":{"CLAUDE_CODE_EFFORT_LEVEL":effort}})
        };
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
                if matches!(self.phase, Phase::Initializing(_)) {
                    let Phase::Initializing(prompt) =
                        std::mem::replace(&mut self.phase, Phase::Running)
                    else {
                        unreachable!()
                    };
                    output.push(Action::Ready);
                    output.push(write_action(self.prompt(&prompt))?);
                }
            }
            "system" if m["subtype"] == "init" => {
                if let Some(id) = m["session_id"].as_str() {
                    output.push(Action::NativeSession(id.into()));
                }
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
                        tool: request["tool_name"].as_str().unwrap_or("Tool").into(),
                        input: request["input"].clone(),
                    });
                } else {
                    output.push(write_action(json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported control request in Latte Work v0.1"}}))?);
                }
            }
            "stream_event" => {
                let event = &m["event"];
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "text_delta"
                    && let Some(text) = event["delta"]["text"].as_str()
                {
                    self.streamed = true;
                    output.push(Action::Event(EventKind::Text { text: text.into() }));
                }
            }
            "assistant" => {
                if let Some(blocks) = m["message"]["content"].as_array() {
                    for block in blocks {
                        match block["type"].as_str().unwrap_or_default() {
                            "text" if !self.streamed => {
                                if let Some(text) = block["text"].as_str() {
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
                output.push(Action::Finished { failed, message });
            }
            _ => {}
        }
        Ok(output)
    }
}
#[cfg(test)]
mod tests {
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
            settings_dir: dir.path().into(),
        };
        let default = Claude::default()
            .command("claude", "/tmp", None, &config)
            .unwrap();
        let settings: Value = serde_json::from_slice(
            &std::fs::read(default._settings.as_ref().unwrap().path()).unwrap(),
        )
        .unwrap();
        assert_eq!(settings, json!({"env":{"CLAUDE_CODE_EFFORT_LEVEL":"auto"}}));
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
