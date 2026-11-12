//! Codex CLI capabilities. Contract checked against codex-cli 0.162.0's schema.
//! <https://learn.chatgpt.com/docs/app-server>
use anyhow::{Result, bail};
use latte_work_protocol::{
    AgentInfo, AgentPermissionMode, Effort, ProviderAuth, ProviderProtocol, Response,
};
use tokio::process::Command;

pub(super) async fn discover() -> (String, AgentInfo) {
    let binary = std::env::var("LATTE_WORK_CODEX").unwrap_or_else(|_| "codex".into());
    let probe = super::traex::output(&binary, &["--version"]).await;
    let available = probe.is_ok();
    let detail = probe
        .map(|s| s.trim().to_owned())
        .unwrap_or_else(|_| "未找到 Codex；在此 Host 安装并登录后重启 Server。".into());
    (
        binary,
        AgentInfo {
            id: "codex".into(),
            name: "Codex".into(),
            available,
            detail,
            provider_protocols: super::provider_protocols("codex")
                .expect("registered adapter")
                .to_vec(),
        },
    )
}

pub(super) async fn permission_modes(binary: &str) -> Result<Vec<AgentPermissionMode>> {
    let help = super::traex::output(binary, &["--help"]).await?;
    if !help.contains("--sandbox")
        || !help.contains("--ask-for-approval")
        || !help.contains("danger-full-access")
    {
        bail!("此 Codex 未公布已适配的沙箱和审批模式");
    }
    Ok(vec![
        AgentPermissionMode {
            id: "default".into(),
            label: "请求批准".into(),
            description: "在工作区内读写和执行；网络和工作区外访问请求批准。".into(),
            elevated: false,
        },
        AgentPermissionMode {
            id: "bypass_permissions".into(),
            label: "完全访问权限".into(),
            description: "使用 Codex 原生完全访问模式，跳过权限确认及沙箱限制。".into(),
            elevated: true,
        },
    ])
}

pub(crate) async fn models(
    binary: &str,
    path: Option<&str>,
    selected: Option<&str>,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<Response> {
    super::traex::models_for_agent(binary, path, selected, true, environment).await
}

pub(crate) async fn validate_selection(
    binary: &str,
    path: Option<&str>,
    selected: Option<&str>,
    effort: Option<Effort>,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<()> {
    let Response::Models {
        models,
        effort_levels,
        ..
    } = models(binary, path, selected, environment).await?
    else {
        unreachable!()
    };
    if selected.is_some_and(|id| !models.iter().any(|m| m == id)) {
        bail!("模型不在当前 Codex 可选列表中，请刷新模型列表");
    }
    if effort.is_some_and(|level| !effort_levels.contains(&level)) {
        bail!("此 Codex 模型不支持所选思考强度");
    }
    Ok(())
}

/// Native Responses providers only. No secrets in argv, RPC, or user config.
pub(super) fn configure_provider(
    command: &mut Command,
    provider: &crate::providers::ResolvedProvider,
    id: &str,
) -> Result<()> {
    let p = &provider.metadata;
    if p.protocol != ProviderProtocol::OpenaiResponses {
        bail!("Codex 仅支持 OpenAI Responses Provider");
    }
    let mut fields = vec![
        "name=\"Latte Work\"".to_owned(),
        format!("base_url={}", serde_json::to_string(&p.base_url)?),
        "wire_api=\"responses\"".into(),
        "requires_openai_auth=false".into(),
        "supports_websockets=false".into(),
    ];
    const TOKEN: &str = "LATTE_WORK_CODEX_PROVIDER_TOKEN";
    command.env_remove(TOKEN);
    match p.auth {
        ProviderAuth::None => {}
        ProviderAuth::Bearer => {
            command.env(TOKEN, &provider.credential);
            fields.push(format!("env_key=\"{TOKEN}\""));
        }
        ProviderAuth::ApiKey => {
            command.env(TOKEN, &provider.credential);
            fields.push(format!("env_http_headers={{\"x-api-key\"=\"{TOKEN}\"}}"));
        }
    }
    command.args([
        "-c",
        &format!("model_providers.{id}={{{}}}", fields.join(",")),
        "-c",
        &format!("model_provider=\"{id}\""),
    ]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_provider_uses_native_auth_fields_without_exposing_secrets() {
        for auth in ["none", "bearer", "api_key"] {
            let provider = crate::providers::ResolvedProvider {
                metadata: serde_json::from_value(serde_json::json!({"id":"fixture","name":"Fixture","protocol":"openai_responses","base_url":"http://localhost:8000/v1","model":"custom-codex","auth":auth,"has_credential":auth!="none"})).unwrap(),
                credential: "codex-test-private-credential".into(),
            };
            let mut command = Command::new("codex");
            configure_provider(&mut command, &provider, "latte-fixture").unwrap();
            let args = command
                .as_std()
                .get_args()
                .map(|s| s.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            assert!(!args.contains(&provider.credential));
            assert!(!args.contains("auth_header_name") && !args.contains("auth_token_style"));
            assert!(args.contains("responses"));
            assert_eq!(args.contains("env_key="), auth == "bearer");
            assert_eq!(args.contains("env_http_headers="), auth == "api_key");
            let token = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == "LATTE_WORK_CODEX_PROVIDER_TOKEN")
                .unwrap()
                .1;
            assert_eq!(token.is_some(), auth != "none");
        }
    }
}
