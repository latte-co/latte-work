//! Claude Code CLI bidirectional stream-json/control protocol.
//! Compatibility source: anthropics/claude-agent-sdk-python internal query/transport.
use super::{AgentAdapter, AgentCommand, Output};
use crate::providers::LaunchConfig;
use anyhow::{Result, bail};
use latte_work_protocol::EventKind;
use serde_json::{Value, json};
use std::io::Write;
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
}
impl AgentAdapter for Claude {
    fn command(
        &self,
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
    fn decode(&mut self, m: Value) -> Result<Vec<Output>> {
        let mut output = Vec::new();
        match m["type"].as_str().unwrap_or_default() {
            "control_response" if m["response"]["request_id"] == "latte-init" => {
                if m["response"]["subtype"] != "success" {
                    bail!("Claude 初始化失败: {}", m["response"]["error"]);
                }
                output.push(Output::Initialized);
            }
            "system" if m["subtype"] == "init" => {
                if let Some(id) = m["session_id"].as_str() {
                    output.push(Output::NativeSession(id.into()));
                }
            }
            "control_request" => {
                let id = m["request_id"].as_str().unwrap_or_default().to_owned();
                let request = &m["request"];
                if request["subtype"] == "can_use_tool" {
                    if id.is_empty() || !request["input"].is_object() {
                        bail!("无效的 Claude 审批请求");
                    }
                    output.push(Output::Approval {
                        id,
                        tool: request["tool_name"].as_str().unwrap_or("Tool").into(),
                        input: request["input"].clone(),
                    });
                } else {
                    output.push(Output::Reply(json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported control request in Latte Work v0.1"}})));
                }
            }
            "stream_event" => {
                let event = &m["event"];
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "text_delta"
                    && let Some(text) = event["delta"]["text"].as_str()
                {
                    self.streamed = true;
                    output.push(Output::Event(EventKind::Text { text: text.into() }));
                }
            }
            "assistant" => {
                if let Some(blocks) = m["message"]["content"].as_array() {
                    for block in blocks {
                        match block["type"].as_str().unwrap_or_default() {
                            "text" if !self.streamed => {
                                if let Some(text) = block["text"].as_str() {
                                    output
                                        .push(Output::Event(EventKind::Text { text: text.into() }));
                                }
                            }
                            "tool_use" => {
                                output.push(Output::Event(EventKind::Tool {
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
                            output.push(Output::Event(EventKind::ToolResult {
                                id: block["tool_use_id"].as_str().unwrap_or_default().into(),
                                content: block["content"].clone(),
                                is_error: block["is_error"].as_bool().unwrap_or(false),
                            }));
                        }
                    }
                }
            }
            "result" => {
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
                output.push(Output::Finished { failed, message });
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
        assert!(matches!(
            &a.decode(json!({"type":"result","is_error":true,"result":"auth failed"}))
                .unwrap()[0],
            Output::Finished { failed: true, .. }
        ));
    }
}
