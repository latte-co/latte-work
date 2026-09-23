//! Protocol adapters translate native agent messages; they do not own storage or UI.
pub mod claude;
mod claude_models;
use crate::providers::LaunchConfig;
use anyhow::Result;
use latte_work_protocol::EventKind;
use serde_json::Value;
use tokio::process::Command;

pub struct AgentCommand {
    pub command: Command,
    /// Keep private launch files alive until the agent exits, including spawn errors.
    pub _settings: Option<tempfile::NamedTempFile>,
}

pub enum Output {
    Event(EventKind),
    NativeSession(String),
    Initialized,
    Approval {
        id: String,
        tool: String,
        input: Value,
    },
    Reply(Value),
    Finished {
        failed: bool,
        message: Option<String>,
    },
}
pub trait AgentAdapter: Send {
    fn command(
        &self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand>;
    fn initialize(&self) -> Value;
    fn prompt(&self, text: &str) -> Value;
    fn approval(&self, id: &str, input: Value, allow: bool) -> Value;
    fn decode(&mut self, message: Value) -> Result<Vec<Output>>;
}

/// Protocol compatibility belongs to the adapter registry, never to presentation code.
pub fn provider_protocols(agent: &str) -> Option<&'static [latte_work_protocol::ProviderProtocol]> {
    match agent {
        "claude" => Some(&[latte_work_protocol::ProviderProtocol::AnthropicMessages]),
        _ => None,
    }
}

/// Built-in choices when an agent has no custom Provider binding.
pub fn model_aliases(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude" => claude::MODEL_ALIASES,
        _ => &[],
    }
}

/// Only the selected adapter defines valid levels. Never share a fallback scale.
pub fn effort_levels(agent: &str, model: Option<&str>) -> &'static [latte_work_protocol::Effort] {
    match agent {
        "claude" => claude::effort_levels(model),
        _ => &[],
    }
}

/// Return display-only model names from the selected Host's native Agent settings.
pub fn model_labels(
    agent: &str,
    project: Option<&std::path::Path>,
) -> std::collections::BTreeMap<String, String> {
    match agent {
        "claude" => claude_models::labels(project),
        _ => std::collections::BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn unimplemented_agents_do_not_inherit_claude_effort() {
        for agent in ["codex", "opencode", "unknown", ""] {
            assert!(super::effort_levels(agent, Some("opus")).is_empty());
            assert!(super::effort_levels(agent, None).is_empty());
        }
        assert!(!super::effort_levels("claude", Some("opus")).is_empty());
    }
}
