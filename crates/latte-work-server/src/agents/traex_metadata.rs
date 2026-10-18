//! Bounded metadata-only probes of the installed Traex executable. No prompt or thread.
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use latte_work_protocol::{AgentInfo, AgentPermissionMode, Effort, ModelVariant, Response};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::codec::{FramedRead, LinesCodec};

pub(super) async fn output(binary: &str, args: &[&str]) -> Result<String> {
    let child = crate::agent_environment::command(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()?;
    let pid = child.id().context("Traex PID missing")? as i32;
    let mut group = crate::runtime::Group { child, pid };
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = group
            .child
            .stdout
            .take()
            .context("Traex stdout missing")?
            .take(131073);
        let mut stderr = group
            .child
            .stderr
            .take()
            .context("Traex stderr missing")?
            .take(131073);
        tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
        if out.len() + err.len() > 131072 {
            bail!("Traex 元数据超出限制");
        }
        if !group.child.wait().await?.success() {
            bail!("Traex 元数据读取失败，请检查 CLI 安装和登录状态");
        }
        Ok(String::from_utf8(out)?)
    })
    .await
    .context("Traex 元数据读取超时")?;
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGKILL,
    );
    let _ = group.child.wait().await;
    result
}

pub(crate) async fn discover() -> (String, AgentInfo) {
    let binary = std::env::var("LATTE_WORK_TRAEX").unwrap_or_else(|_| {
        let path =
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/bin/traex");
        if path.is_file() {
            path.to_string_lossy().into_owned()
        } else {
            "traex".into()
        }
    });
    let probe = output(&binary, &["--version"]).await;
    let available = probe.is_ok();
    let detail = probe
        .map(|s| s.trim().to_owned())
        .unwrap_or_else(|_| "未找到 Traex；在此 Host 安装并登录后重启 Server。".into());
    (
        binary,
        AgentInfo {
            id: "traex".into(),
            name: "Traex".into(),
            available,
            provider_protocols: super::super::provider_protocols("traex").unwrap().to_vec(),
            detail,
        },
    )
}

pub(crate) async fn permission_modes(binary: &str) -> Result<Vec<AgentPermissionMode>> {
    let help = output(binary, &["--help"]).await?;
    let section = help
        .split("--permission-mode")
        .nth(1)
        .context("此 Traex 未公布权限模式")?
        .split("\n  -")
        .next()
        .unwrap_or_default();
    let known = [
        (
            "default",
            "请求批准",
            "在工作区内读写和执行；网络和工作区外访问请求批准。",
            false,
        ),
        (
            "bypass_permissions",
            "完全访问权限",
            "按 Traex 原生模式跳过权限确认及沙箱限制。",
            true,
        ),
    ];
    let modes: Vec<_> = known
        .into_iter()
        .filter(|(id, ..)| {
            section
                .lines()
                .any(|line| line.trim_start().starts_with(&format!("- {id}:")))
        })
        .map(|(id, label, description, elevated)| AgentPermissionMode {
            id: id.into(),
            label: label.into(),
            description: description.into(),
            elevated,
        })
        .collect();
    if modes.is_empty() {
        bail!("此 Traex 没有已适配的权限模式");
    }
    Ok(modes)
}

async fn rpc(
    input: &mut tokio::process::ChildStdin,
    id: u32,
    method: &str,
    params: Value,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))?;
    bytes.push(b'\n');
    input.write_all(&bytes).await?;
    input.flush().await?;
    Ok(())
}

/// Return native model IDs, labels and only the efforts reported for the selected model.
pub(crate) async fn models(
    binary: &str,
    path: Option<&str>,
    selected: Option<&str>,
) -> Result<Response> {
    let mut command = crate::agent_environment::command(binary);
    command.args(["app-server", "--stdio"]);
    if let Some(path) = path {
        command.current_dir(path);
    }
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()?;
    let pid = child.id().context("Traex PID missing")? as i32;
    let mut group = crate::runtime::Group { child, pid };
    let mut input = group.child.stdin.take().context("Traex stdin missing")?;
    let mut output = FramedRead::new(
        group.child.stdout.take().context("Traex stdout missing")?,
        LinesCodec::new_with_max_length(1024 * 1024),
    );
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        rpc(
            &mut input,
            1,
            "initialize",
            json!({"clientInfo":{"name":"latte-work","version":"0.1.0"}}),
        )
        .await?;
        let mut expected = 1u32;
        let mut entries = Vec::new();
        let mut bytes = 0usize;
        for _ in 0..128 {
            let line = output
                .next()
                .await
                .context("Traex 在返回模型列表前退出")??;
            bytes += line.len();
            if bytes > 1024 * 1024 {
                bail!("Traex 模型列表超出限制");
            }
            let message: Value = serde_json::from_str(&line)?;
            if message.get("method").is_some() && message.get("id").is_some() {
                bail!("Traex 元数据读取期间请求执行操作");
            }
            if message["id"].as_u64() != Some(u64::from(expected)) {
                continue;
            }
            if message.get("error").is_some() {
                bail!("Traex 模型读取失败，请检查 CLI 版本和登录状态");
            }
            if expected == 1 {
                input.write_all(b"{\"method\":\"initialized\"}\n").await?;
                rpc(&mut input, 2, "model/list", json!({"limit":100})).await?;
                expected = 2;
                continue;
            }
            let result = &message["result"];
            entries.extend(
                result["data"]
                    .as_array()
                    .context("Traex 未返回有效模型列表")?
                    .iter()
                    .cloned(),
            );
            if entries.len() > 256 {
                bail!("Traex 模型数量超出限制");
            }
            if result["nextCursor"].is_null() {
                return catalog(&entries, selected);
            }
            if expected >= 6 {
                bail!("Traex 模型分页超出限制");
            }
            expected += 1;
            rpc(
                &mut input,
                expected,
                "model/list",
                json!({"limit":100,"cursor":result["nextCursor"]}),
            )
            .await?;
        }
        bail!("Traex 元数据消息超出限制")
    })
    .await
    .context("读取 Traex 模型超时")?;
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGKILL,
    );
    let _ = group.child.wait().await;
    result
}
fn native_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
}
fn variants(entry: &Value) -> Vec<ModelVariant> {
    let metadata = &entry["businessMetadata"]["variants"];
    let Some(max) = native_id(&metadata["max_key"]) else {
        return vec![];
    };
    let Some(id) = native_id(&entry["id"]) else {
        return vec![];
    };
    if native_id(&metadata["standard_key"]).is_none() || max == id {
        return vec![];
    }
    [
        (id, "Standard", "standard_context_window"),
        (max, "Max", "max_context_window"),
    ]
    .into_iter()
    .map(|(model, label, window)| ModelVariant {
        model: model.into(),
        label: label.into(),
        context_window: metadata[window].as_f64().filter(|n| *n > 0.0),
    })
    .collect()
}
fn catalog(entries: &[Value], selected: Option<&str>) -> Result<Response> {
    let mut models = Vec::new();
    let mut labels = BTreeMap::new();
    let mut model_variants = BTreeMap::new();
    let mut default_model = None;
    let mut effort_levels = Vec::new();
    for entry in entries.iter().filter(|v| v["hidden"] != true) {
        let id = native_id(&entry["id"]).context("Traex 模型 ID 无效")?;
        if models.iter().any(|v| v == id) {
            bail!("Traex 模型 ID 重复");
        }
        models.push(id.to_owned());
        let label = entry["displayName"]
            .as_str()
            .filter(|s| s.len() <= 256)
            .unwrap_or(id);
        labels.insert(id.into(), label.into());
        if entry["isDefault"] == true {
            default_model = Some(id.to_owned());
        }
        let options = variants(entry);
        if let Some(max) = options.get(1) {
            if models.contains(&max.model)
                || entries.iter().any(|v| v["id"].as_str() == Some(&max.model))
            {
                bail!("Traex 模式 ID 与模型重复");
            }
            models.push(max.model.clone());
            labels.insert(max.model.clone(), format!("{label} / Max"));
            model_variants.insert(id.into(), options.clone());
        }
        let selected = selected.or_else(|| (entry["isDefault"] == true).then_some(id));
        let max = options
            .get(1)
            .is_some_and(|v| Some(v.model.as_str()) == selected);
        if selected == Some(id) || max {
            let key = if max {
                "max_supported_reasoning_levels"
            } else {
                "standard_supported_reasoning_levels"
            };
            let native = entry["businessMetadata"]["variants"][key].as_array();
            let efforts = native.or_else(|| entry["supportedReasoningEfforts"].as_array());
            for effort in efforts.into_iter().flatten() {
                let value = if native.is_some() {
                    &effort["effort"]
                } else {
                    &effort["reasoningEffort"]
                };
                if let Ok(level) = serde_json::from_value::<Effort>(value.clone())
                    && !effort_levels.contains(&level)
                {
                    effort_levels.push(level);
                }
            }
        }
    }
    Ok(Response::Models {
        models,
        provider: None,
        default_model,
        effort_levels,
        model_labels: labels,
        model_variants: (!model_variants.is_empty()).then_some(model_variants),
    })
}

/// Resolved only from the current native catalog, never inferred from a name suffix.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ModelSelection {
    pub model: String,
    pub backend_variant: String,
}
pub(crate) async fn validate_selection(
    binary: &str,
    path: Option<&str>,
    selected: Option<&str>,
    effort: Option<Effort>,
) -> Result<Option<ModelSelection>> {
    let Response::Models {
        models,
        effort_levels,
        model_variants,
        ..
    } = models(binary, path, selected).await?
    else {
        unreachable!()
    };
    if selected.is_some_and(|id| !models.iter().any(|m| m == id)) {
        bail!("模型不在当前 Traex 可选列表中，请刷新模型列表");
    }
    if effort.is_some_and(|level| !effort_levels.contains(&level)) {
        bail!("此 Traex 模型不支持所选思考强度");
    }
    Ok(model_variants
        .into_iter()
        .flatten()
        .find_map(|(model, variants)| {
            variants
                .into_iter()
                .find(|v| Some(v.model.as_str()) == selected)
                .map(|v| ModelSelection {
                    model,
                    backend_variant: if v.label == "Max" { "max" } else { "standard" }.into(),
                })
        })
        .or_else(|| {
            selected.map(|model| ModelSelection {
                model: model.into(),
                backend_variant: "standard".into(),
            })
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_catalog_preserves_ids_and_per_model_efforts_without_claude_fallback() {
        let entries = vec![
            json!({"id":"seed-config","displayName":"Seed","isDefault":true,"supportedReasoningEfforts":[]}),
            json!({"id":"other","displayName":"Other","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"ultra"}]}),
            json!({"id":"hidden","hidden":true}),
        ];
        let Response::Models {
            models,
            effort_levels,
            default_model,
            model_labels,
            ..
        } = catalog(&entries, None).unwrap()
        else {
            panic!()
        };
        assert_eq!(models, ["seed-config", "other"]);
        assert!(effort_levels.is_empty());
        assert_eq!(default_model.as_deref(), Some("seed-config"));
        assert_eq!(model_labels["seed-config"], "Seed");
        let Response::Models { effort_levels, .. } = catalog(&entries, Some("other")).unwrap()
        else {
            panic!()
        };
        assert_eq!(effort_levels, [Effort::Low]);
    }
    #[test]
    fn variants_keep_native_keys_context_and_independent_efforts() {
        let entries = vec![
            json!({"id":"gpt","displayName":"GPT", "supportedReasoningEfforts":[{"reasoningEffort":"high"}],
            "businessMetadata":{"variants":{"standard_key":"small","max_key":"large",
            "standard_context_window":475000,"max_context_window":800000,
            "standard_supported_reasoning_levels":[{"effort":"high"}],
            "max_supported_reasoning_levels":[{"effort":"low"}]}}}),
        ];
        let Response::Models {
            models,
            model_labels,
            model_variants: Some(variants),
            effort_levels,
            ..
        } = catalog(&entries, Some("large")).unwrap()
        else {
            panic!()
        };
        assert_eq!(models, ["gpt", "large"]);
        assert_eq!(model_labels["large"], "GPT / Max");
        assert_eq!(effort_levels, [Effort::Low]);
        assert_eq!(variants["gpt"][0].model, "gpt");
        assert_eq!(variants["gpt"][1].model, "large");
        assert_eq!(variants["gpt"][1].context_window, Some(800000.0));
        let Response::Models { effort_levels, .. } = catalog(&entries, Some("gpt")).unwrap() else {
            panic!()
        };
        assert_eq!(effort_levels, [Effort::High]);
    }
}
