//! Ephemeral Traex provider overrides. Credentials never enter argv or JSON-RPC.
use crate::providers::ResolvedProvider;
use anyhow::Result;
use latte_work_protocol::{ProviderAuth, ProviderProtocol};
use tokio::process::Command;

pub(super) fn id() -> String {
    format!("latte-work-{}", uuid::Uuid::new_v4().simple())
}
const TOKEN: &str = "LATTE_WORK_TRAEX_PROVIDER_TOKEN";

pub(super) fn configure(
    command: &mut Command,
    provider: &ResolvedProvider,
    id: &str,
) -> Result<()> {
    let p = &provider.metadata;
    let wire = match p.protocol {
        ProviderProtocol::AnthropicMessages => "anthropic_messages",
        ProviderProtocol::OpenaiChat => "chat_completions",
        ProviderProtocol::OpenaiResponses => "responses",
    };
    let mut base = url::Url::parse(&p.base_url)?;
    if p.protocol == ProviderProtocol::AnthropicMessages && base.path().trim_matches('/').is_empty()
    {
        // App Anthropic providers commonly store an origin (Claude appends /v1).
        // Traex appends only /messages, so complete a bare origin here.
        base.set_path("/v1");
    }
    // JSON string literals are also TOML basic string literals. Set the entire
    // table under a fresh process-owned ID: native config merges tables, so
    // a fixed ID could inherit user-defined headers or authentication.
    let mut fields = vec![
        "name=\"Latte Work\"".to_owned(),
        format!("base_url={}", serde_json::to_string(base.as_str())?),
        format!("wire_api=\"{wire}\""),
        "requires_openai_auth=false".into(),
        "supports_websockets=false".into(),
    ];
    command.env_remove(TOKEN);
    match p.auth {
        ProviderAuth::None => {}
        ProviderAuth::Bearer | ProviderAuth::ApiKey => {
            command.env(TOKEN, &provider.credential);
            fields.push(format!("env_key=\"{TOKEN}\""));
            let (header, style) = if p.auth == ProviderAuth::Bearer {
                ("Authorization", "bearer")
            } else {
                ("x-api-key", "raw")
            };
            fields.push(format!("auth_header_name=\"{header}\""));
            fields.push(format!("auth_token_style=\"{style}\""));
        }
    }
    command.args([
        "-c",
        &format!("model_providers.{id}={{{}}}", fields.join(",")),
    ]);
    command.args(["-c", &format!("model_provider=\"{id}\"")]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_credentials_are_environment_only_and_each_protocol_is_native() {
        for (protocol, wire) in [
            ("anthropic_messages", "anthropic_messages"),
            ("openai_chat", "chat_completions"),
            ("openai_responses", "responses"),
        ] {
            for auth in ["none", "bearer", "api_key"] {
                let provider = ResolvedProvider {
                    metadata: serde_json::from_value(serde_json::json!({"id":"fixture","name":"Fixture","protocol":protocol,"base_url":"http://localhost:8000/v1","model":"custom-model","auth":auth,"has_credential":auth!="none"})).unwrap(),
                    credential: if auth == "none" {String::new()} else {"private-fixture-credential".into()},
                };
                let mut command = Command::new("traex");
                configure(&mut command, &provider, &id()).unwrap();
                let args: Vec<_> = command
                    .as_std()
                    .get_args()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect();
                assert!(args.join(" ").contains(wire));
                assert!(!args.join(" ").contains("private-fixture-credential"));
                let token = command
                    .as_std()
                    .get_envs()
                    .find(|(k, _)| *k == TOKEN)
                    .unwrap()
                    .1;
                assert_eq!(token.is_some(), auth != "none");
                if auth == "none" {
                    assert!(!args.join(" ").contains("env_key"));
                }
            }
        }
    }
}
