//! Prompt-free ACP probes. A disposable native session is deleted on completion.
use super::{
    config_option, frame, initialize, options, parse_commands, verify_initialize, version_2,
};
use crate::runtime::Group;
use anyhow::{Context, Result, bail, ensure};
use futures_util::StreamExt;
use latte_work_protocol::{AgentEnvironment, AgentInfo, AgentSlashCommand, Effort, Response};
use serde_json::{Value, json};
use std::{collections::BTreeMap, process::Stdio, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    process::{ChildStdin, ChildStdout, Command},
};
use tokio_util::codec::{FramedRead, LinesCodec};

pub(super) fn command(binary: &str, cwd: Option<&str>, environment: &AgentEnvironment) -> Command {
    let mut command = crate::agent_environment::command(binary);
    command.arg("acp").envs(&environment.0);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command
}

pub(in crate::agents) async fn discover() -> (String, AgentInfo) {
    let binary = std::env::var("LATTE_WORK_OPENCODE").unwrap_or_else(|_| "opencode".into());
    let probe = crate::agents::traex::output(&binary, &["--version"]).await;
    let (available, detail) = match probe {
        Ok(version) if version_2(&version) => (true, version.trim().into()),
        Ok(_) => (
            false,
            "需要 OpenCode 2.x；请在此 Host 更新 CLI 后重启 Server。".into(),
        ),
        Err(_) => (
            false,
            "未找到 OpenCode 2.x；请在此 Host 安装后重启 Server。".into(),
        ),
    };
    (
        binary,
        AgentInfo {
            id: "opencode".into(),
            name: "OpenCode".into(),
            available,
            detail,
            provider_protocols: vec![],
        },
    )
}

struct Probe {
    input: ChildStdin,
    output: FramedRead<ChildStdout, LinesCodec>,
    _group: Group,
    next_id: u64,
    frames_left: usize,
    commands: Option<(String, Vec<AgentSlashCommand>)>,
}

impl Probe {
    fn spawn(binary: &str, cwd: &str, environment: &AgentEnvironment) -> Result<Self> {
        let child = command(binary, Some(cwd), environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .context("无法启动 OpenCode ACP 探针")?;
        let pid = child.id().context("OpenCode ACP PID missing")? as i32;
        let mut group = Group { child, pid };
        let input = group
            .child
            .stdin
            .take()
            .context("OpenCode ACP stdin missing")?;
        let stdout = group
            .child
            .stdout
            .take()
            .context("OpenCode ACP stdout missing")?;
        Ok(Self {
            input,
            output: FramedRead::new(stdout, LinesCodec::new_with_max_length(super::FRAME_LIMIT)),
            _group: group,
            next_id: 0,
            frames_left: 128,
            commands: None,
        })
    }

    async fn write(&mut self, message: Value) -> Result<()> {
        self.input.write_all(&frame(message)?).await?;
        Ok(())
    }

    async fn read(&mut self) -> Result<Value> {
        ensure!(self.frames_left > 0, "OpenCode ACP 探针消息超出限制");
        self.frames_left -= 1;
        let line = self
            .output
            .next()
            .await
            .context("OpenCode ACP 探针在返回结果前退出")??;
        let message: Value = serde_json::from_str(&line).context("无效的 OpenCode ACP 探针消息")?;
        ensure!(message["jsonrpc"] == "2.0", "无效的 OpenCode ACP 协议版本");
        if message["method"].is_string()
            && let Some(id) = message.get("id")
        {
            self.write(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Metadata probe"}}),
            )
            .await?;
        } else if message["method"] == "session/update"
            && let params = &message["params"]
            && params["update"]["sessionUpdate"] == "available_commands_update"
        {
            self.commands = Some((
                super::string(params, "sessionId")?.into(),
                parse_commands(&params["update"])?,
            ));
        }
        Ok(message)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        loop {
            let message = self.read().await?;
            if message.get("method").is_none() && message["id"].as_u64() == Some(id) {
                if let Some(error) = message.get("error") {
                    if error["code"] == -32000 {
                        bail!("OpenCode 需要认证；请在执行主机运行 opencode auth login");
                    }
                    // Probe errors are returned directly to the client, outside
                    // the actor's credential redactor. Never return raw payloads.
                    bail!("OpenCode ACP 元数据请求失败：{method}");
                }
                return message
                    .get("result")
                    .cloned()
                    .context("OpenCode ACP 缺少响应结果");
            }
        }
    }

    async fn attach(&mut self, cwd: &str) -> Result<(String, Value)> {
        verify_initialize(&self.request("initialize", initialize()).await?)?;
        let result = self
            .request("session/new", json!({"cwd":cwd,"mcpServers":[]}))
            .await?;
        Ok((super::string(&result, "sessionId")?.into(), result))
    }

    async fn close(&mut self, session_id: &str) -> Result<()> {
        // 2.0 kept empty sessions on close. Delete only the ID this probe created.
        self.request("session/delete", json!({"sessionId":session_id}))
            .await?;
        Ok(())
    }

    async fn command_catalog(&mut self, session_id: &str) -> Result<Vec<AgentSlashCommand>> {
        loop {
            if let Some((id, commands)) = self.commands.take()
                && id == session_id
            {
                return Ok(commands);
            }
            self.read().await?;
        }
    }

    async fn model_catalog(
        &mut self,
        session_id: &str,
        result: Value,
        selected: Option<&str>,
    ) -> Result<Response> {
        let model = config_option(&result, "model").context("OpenCode ACP 未返回模型列表")?;
        let default_model = model["currentValue"].as_str().filter(|id| !id.is_empty());
        let mut models = Vec::new();
        let mut model_labels = BTreeMap::new();
        for (id, entry) in options(model) {
            if !id.contains('/') || model_labels.contains_key(id) {
                continue;
            }
            ensure!(models.len() < 1000, "OpenCode 模型列表超出限制");
            models.push(id.to_owned());
            let label: String = entry["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .unwrap_or(id)
                .chars()
                .take(180)
                .collect();
            model_labels.insert(id.into(), label);
        }
        let default_model = default_model
            .filter(|id| model_labels.contains_key(*id))
            .map(str::to_owned);
        let effort_catalog = match selected {
            Some(id) if model_labels.contains_key(id) && Some(id) != default_model.as_deref() => {
                self.request(
                    "session/set_config_option",
                    json!({"sessionId":session_id,"configId":"model","value":id}),
                )
                .await?
            }
            Some(id) if !model_labels.contains_key(id) => Value::Null,
            _ => result,
        };
        let effort_levels = config_option(&effort_catalog, "effort").map_or_else(Vec::new, |opt| {
            [
                Effort::Low,
                Effort::Medium,
                Effort::High,
                Effort::Xhigh,
                Effort::Max,
            ]
            .into_iter()
            .filter(|level| options(opt).any(|(value, _)| value == level.as_str()))
            .collect()
        });
        Ok(Response::Models {
            models,
            provider: None,
            default_model,
            effort_levels,
            model_labels,
            model_variants: None,
        })
    }
}

pub(crate) async fn commands(
    binary: &str,
    cwd: &str,
    environment: &AgentEnvironment,
) -> Result<Vec<AgentSlashCommand>> {
    tokio::time::timeout(Duration::from_secs(12), async {
        let mut probe = Probe::spawn(binary, cwd, environment)?;
        let (id, _) = probe.attach(cwd).await?;
        let result = tokio::time::timeout(Duration::from_secs(5), probe.command_catalog(&id)).await;
        let closed = probe.close(&id).await;
        let mut commands = result.context("读取 OpenCode 命令列表超时")??;
        closed?;
        // Custom commands may return end_turn after enqueueing native work.
        // Only expose the native compaction whose ACP result fences execution.
        commands.retain(|command| command.name == "compact");
        Ok(commands)
    })
    .await
    .context("读取 OpenCode 命令列表超时")?
}

pub(in crate::agents) async fn models(
    binary: &str,
    cwd: Option<&str>,
    selected: Option<&str>,
    environment: &AgentEnvironment,
) -> Result<Response> {
    let directory;
    let cwd = match cwd {
        Some(cwd) => cwd,
        None => {
            directory = crate::agent_environment::variable("HOME")
                .map(std::path::PathBuf::from)
                .filter(|p| p.is_absolute() && p.is_dir())
                .unwrap_or(std::env::current_dir()?);
            directory.to_str().context("OpenCode ACP 目录不是 UTF-8")?
        }
    };
    tokio::time::timeout(Duration::from_secs(12), async {
        let mut probe = Probe::spawn(binary, cwd, environment)?;
        let (id, result) = probe.attach(cwd).await?;
        let catalog = tokio::time::timeout(
            Duration::from_secs(5),
            probe.model_catalog(&id, result, selected),
        )
        .await;
        let closed = probe.close(&id).await;
        let catalog = catalog.context("读取 OpenCode 模型列表超时")??;
        closed?;
        Ok(catalog)
    })
    .await
    .context("读取 OpenCode 模型列表超时")?
}
