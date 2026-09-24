//! Protocol adapters translate native agent messages; they do not own storage or UI.
mod adapter;
mod claude;
mod claude_models;
pub use adapter::{Action, AgentAdapter, AgentCommand, Input};
use anyhow::{Result, bail};

/// Concrete adapters are constructed only here; unsupported IDs never fall back.
pub fn create(agent: &str) -> Result<Box<dyn AgentAdapter>> {
    match agent {
        "claude" => Ok(Box::<claude::Claude>::default()),
        _ => bail!("此 Agent 尚未实现：{agent}"),
    }
}

/// The registry currently contains one implementation. Discovery stays implementation-owned.
pub async fn discover() -> (String, latte_work_protocol::AgentInfo) {
    claude::discover().await
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
            assert!(super::create(agent).is_err());
            assert!(super::effort_levels(agent, Some("opus")).is_empty());
            assert!(super::effort_levels(agent, None).is_empty());
        }
        assert!(!super::effort_levels("claude", Some("opus")).is_empty());
    }
}
