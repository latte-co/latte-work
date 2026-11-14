//! Process-local OpenCode settings. Native files and the inherited config path stay intact.
use crate::{
    agent_environment,
    providers::{LaunchConfig, ResolvedProvider},
};
use anyhow::{Context, Result, ensure};
use jsonc_parser::{
    ParseOptions,
    cst::{CstInputValue, CstRootNode},
    json,
};
use latte_work_protocol::{ProviderAuth, ProviderProtocol};
use std::io::Write;
use tempfile::NamedTempFile;
use tokio::process::Command;

const CONTENT: &str = "OPENCODE_CONFIG_CONTENT";

pub(super) fn configure(
    command: &mut Command,
    config: &LaunchConfig,
    instructions: &str,
    sideband: Option<(&super::super::Sideband, &str)>,
) -> Result<(Option<String>, Option<NamedTempFile>)> {
    let inherited = agent_environment::configured_variable(CONTENT, &config.environment);
    let inherited = inherited
        .as_ref()
        .map(|value| value.to_str().context("OpenCode 内联配置不是 UTF-8"))
        .transpose()?;
    let inherited = inherited
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("{}");
    ensure!(inherited.len() <= 96 * 1024, "OpenCode 内联配置超出限制");
    let root = CstRootNode::parse(inherited, &ParseOptions::default())
        .map_err(|_| anyhow::anyhow!("无法合并 OpenCode 内联配置"))?;
    let overlay = root.object_value().context("OpenCode 内联配置必须是对象")?;
    let file = if instructions.is_empty() {
        None
    } else {
        let mut file = tempfile::Builder::new()
            .prefix("opencode-instructions-")
            .suffix(".md")
            .tempfile_in(&config.settings_dir)?;
        file.write_all(instructions.as_bytes())?;
        overlay
            .array_value_or_create("instructions")
            .context("OpenCode instructions 必须是数组")?
            .append(
                file.path()
                    .to_str()
                    .context("OpenCode 指令路径不是 UTF-8")?
                    .into(),
            );
        Some(file)
    };
    if let Some((sideband, prompt_tag)) = sideband {
        ensure!(
            matches!(
                config.permission_mode.as_deref(),
                None | Some("default" | "bypass_permissions")
            ),
            "无效的 OpenCode 权限模式"
        );
        let directory = sideband._directory.path();
        let instructions = file
            .as_ref()
            .map(|file| file.path().to_str().context("OpenCode 指令路径不是 UTF-8"))
            .transpose()?;
        overlay.array_value_or_create("plugins")
            .context("OpenCode plugins 必须是数组")?
            .append(jsonc_parser::json!({
                "package": (directory.to_str().context("OpenCode 插件路径不是 UTF-8")?),
                "options": {
                    "socket": (directory.join("events").to_str().context("OpenCode Socket 路径不是 UTF-8")?),
                    "permissionMode": (config.permission_mode.as_deref().unwrap_or_default()),
                    "promptTag": (prompt_tag),
                    "instructions": (instructions.unwrap_or_default())
                }
            }));
    }

    let mut model = config.model.clone();
    if let Some(provider) = &config.provider {
        let id = format!("latte-work-{}", uuid::Uuid::new_v4().simple());
        let selected = model.as_deref().unwrap_or(&provider.metadata.model);
        ensure!(
            selected == provider.metadata.model
                || provider.metadata.models.iter().any(|id| id == selected),
            "模型不在当前 Provider 的可选列表中"
        );
        let token = format!(
            "LATTE_WORK_OPENCODE_{}_TOKEN",
            id.replace('-', "_").to_ascii_uppercase()
        );
        overlay
            .object_value_or_create("providers")
            .context("OpenCode providers 必须是对象")?
            .append(&id, provider_settings(command, provider, &token)?);
        let selected = format!("{id}/{selected}");
        if let Some(entry) = overlay.get("model") {
            entry.set_value(selected.clone().into());
        } else {
            overlay.append("model", selected.clone().into());
        }
        model = Some(selected);
    }
    let overlay = root.to_string();
    ensure!(
        overlay.len() <= 120 * 1024,
        "OpenCode 合并后的内联配置超出限制"
    );
    command.env(CONTENT, overlay);
    Ok((model, file))
}

fn provider_settings(
    command: &mut Command,
    provider: &ResolvedProvider,
    token: &str,
) -> Result<CstInputValue> {
    let p = &provider.metadata;
    let package = match p.protocol {
        ProviderProtocol::AnthropicMessages => "@opencode/ai/providers/anthropic",
        ProviderProtocol::OpenaiChat => "@opencode/ai/providers/openai-compatible",
        ProviderProtocol::OpenaiResponses => "@opencode/ai/providers/openai/responses",
    };
    let mut base = url::Url::parse(&p.base_url)?;
    if p.protocol == ProviderProtocol::AnthropicMessages && base.path().trim_matches('/').is_empty()
    {
        base.set_path("/v1");
    }
    let mut settings = vec![(
        "baseURL".to_owned(),
        base.as_str().trim_end_matches('/').into(),
    )];
    let mut headers = Vec::new();
    if p.auth != ProviderAuth::None {
        // OpenCode substitutes env references into JSONC before parsing it.
        // Escape the value as a JSON fragment and neutralize its file-reference syntax.
        let escaped = serde_json::to_string(&provider.credential)?;
        command.env(token, escaped[1..escaped.len() - 1].replace('{', "\\u007b"));
        let reference = format!("{{env:{token}}}");
        match (&p.protocol, &p.auth) {
            (ProviderProtocol::AnthropicMessages, ProviderAuth::Bearer) => {
                settings.push(("authToken".into(), reference.into()));
            }
            (
                ProviderProtocol::OpenaiChat | ProviderProtocol::OpenaiResponses,
                ProviderAuth::ApiKey,
            ) => {
                headers.push(("x-api-key".into(), reference.into()));
            }
            _ => settings.push(("apiKey".into(), reference.into())),
        }
    }
    let models = std::iter::once(&p.model)
        .chain(p.models.iter())
        .map(|id| {
            let name = p
                .model_labels
                .get(id)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            (
                id.clone(),
                jsonc_parser::json!({
                    "name": (name.as_str()),
                    "capabilities": {"tools": true, "input": ["text"], "output": ["text"]}
                }),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>()
        .into_iter()
        .collect::<Vec<_>>();
    Ok(jsonc_parser::json!({
        "name": "Latte Work",
        "package": (package),
        "settings": (settings),
        "headers": (headers),
        "models": (models)
    }))
}
