//! GUI-independent host connection. An SSH bridge is only a transport, never an agent.
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use latte_work_protocol::{MAX_FRAME, Request, Response, VERSION};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin, ChildStdout, Command},
};
use tokio_util::codec::{FramedRead, LinesCodec};

pub struct Client {
    child: Child,
    input: ChildStdin,
    output: FramedRead<ChildStdout, LinesCodec>,
    broken: bool,
}

pub enum SshAuthentication<'a> {
    OpenSsh,
    IdentityFile(&'a Path),
    Password { askpass: &'a Path, socket: &'a Path },
}

impl Client {
    pub async fn local(binary: &Path, state: Option<&Path>) -> Result<Self> {
        let mut command = Command::new(binary);
        command.arg("connect-local");
        if let Some(state) = state {
            command.arg("--state-dir").arg(state);
        }
        Self::spawn(command).await
    }
    pub async fn ssh(host: &str, binary: &str) -> Result<Self> {
        Self::ssh_with_auth(host, binary, None, SshAuthentication::OpenSsh).await
    }
    pub async fn ssh_with_auth(
        host: &str,
        binary: &str,
        port: Option<u16>,
        auth: SshAuthentication<'_>,
    ) -> Result<Self> {
        let command = ssh_command(host, binary, port, auth)?;
        Self::spawn(command)
            .await
            .context("SSH 连接失败；请确认主机指纹已在终端验证，并检查认证方式和远程 Server")
    }
    async fn spawn(mut command: Command) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("无法启动 Host 连接程序")?;
        let input = child.stdin.take().context("bridge stdin missing")?;
        let output = FramedRead::new(
            child.stdout.take().context("bridge stdout missing")?,
            LinesCodec::new_with_max_length(MAX_FRAME),
        );
        let mut client = Self {
            child,
            input,
            output,
            broken: false,
        };
        match client.request(Request::Hello { version: VERSION }).await? {
            Response::Hello {
                version: VERSION, ..
            } => Ok(client),
            Response::Error { code, message } if code == "version_mismatch" => bail!(
                "远程 Server 与客户端不兼容，请等待远程任务结束并关闭终端后，更新并重启远程 Server：{message}"
            ),
            Response::Error { message, .. } => bail!("{message}"),
            other => bail!("不兼容的 Server: {other:?}"),
        }
    }
    pub async fn request(&mut self, request: Request) -> Result<Response> {
        if self.broken {
            bail!("连接已失效，请重新连接；任务不会自动重发");
        }
        let result = tokio::time::timeout(Duration::from_secs(25), async {
            let mut data = serde_json::to_vec(&request)?;
            if data.len() > MAX_FRAME {
                bail!("请求过大");
            }
            data.push(b'\n');
            self.input.write_all(&data).await?;
            self.input.flush().await?;
            let line = self.output.next().await.context("Host 连接已关闭")??;
            Ok::<_, anyhow::Error>(serde_json::from_str::<Response>(&line)?)
        })
        .await;
        match result {
            Ok(Ok(response)) => Ok(response),
            other => {
                self.broken = true;
                let _ = self.child.start_kill();
                match other {
                    Ok(Err(error)) => Err(error),
                    _ => bail!("Host 响应超时；请求可能已执行，请重连查看状态"),
                }
            }
        }
    }
}

/// Prepare a remote turn or model catalog from the latest host association on the local server.
/// Secrets remain in native memory and travel only on the authenticated transport.
pub async fn request_with_provider(
    local: &tokio::sync::Mutex<Client>,
    target: &tokio::sync::Mutex<Client>,
    host_id: String,
    request: Request,
) -> Result<Response> {
    let is_send = matches!(&request, Request::Send { .. });
    let agent = match &request {
        Request::Models { agent, .. } => agent.clone(),
        Request::Send { session_id, .. } => {
            match target
                .lock()
                .await
                .request(Request::Session {
                    session_id: session_id.clone(),
                })
                .await?
            {
                Response::Session { session } => session.agent,
                Response::Error { message, .. } => bail!("{message}"),
                _ => bail!("远程会话响应格式不匹配"),
            }
        }
        _ => bail!("此请求不接受本轮 Provider 配置"),
    };
    let (snapshot, configured) = match local
        .lock()
        .await
        .request(Request::ExportHostAgentProvider {
            host_id,
            agent: agent.clone(),
        })
        .await?
    {
        Response::ProviderSnapshot {
            snapshot,
            configured,
        } => (snapshot, configured),
        Response::Error { message, .. } => bail!("{message}"),
        _ => bail!("本机 Provider 响应格式不匹配"),
    };
    if snapshot.is_none() && !configured {
        match target.lock().await.request(Request::Providers).await? {
            Response::Providers { bindings, .. } if bindings.iter().any(|b| b.agent == agent) => {
                bail!(
                    "此主机仍有旧 Provider 关联，请在「连接与 Agent」中选择 Provider 或明确选择沿用 CLI 配置，再保存关联"
                );
            }
            Response::Providers { .. } => {}
            Response::Error { message, .. } => bail!("{message}"),
            _ => bail!("远程 Provider 响应格式不匹配"),
        }
    }
    let request = match request {
        Request::Models {
            agent,
            model,
            project_id,
        } => Request::ModelsForProvider {
            agent,
            model,
            project_id,
            provider: snapshot.map(|s| s.provider),
        },
        Request::Send {
            session_id,
            request_id,
            text,
            model,
            effort,
            ..
        } => Request::Send {
            session_id,
            request_id,
            text,
            model,
            effort,
            provider: Some(
                snapshot
                    .map(latte_work_protocol::TurnProvider::Snapshot)
                    .unwrap_or(latte_work_protocol::TurnProvider::Cli),
            ),
        },
        _ => unreachable!(),
    };
    let response = target.lock().await.request(request).await?;
    match response {
        Response::Models { .. } if !is_send => Ok(response),
        Response::Accepted { .. } if is_send => Ok(response),
        Response::Error { .. } => Ok(response),
        _ => bail!("远程执行响应格式不匹配"),
    }
}

fn ssh_command(
    host: &str,
    binary: &str,
    port: Option<u16>,
    auth: SshAuthentication<'_>,
) -> Result<Command> {
    validate_host(host)?;
    if (!binary.is_empty() && !binary.starts_with('/')) || binary.contains(['\n', '\r', '\0']) {
        bail!("远程 Server 必须是绝对路径");
    }
    let mut command = Command::new("ssh");
    command.arg("-T");
    if let Some(port) = port {
        if port == 0 {
            bail!("SSH 端口必须是 1–65535");
        }
        command.arg("-p").arg(port.to_string());
    }
    match auth {
        SshAuthentication::OpenSsh => {
            command.args(["-o", "BatchMode=yes"]);
        }
        SshAuthentication::IdentityFile(path) => {
            validate_identity_file(path)?;
            command.args(["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]);
            command.arg("-i").arg(path);
        }
        SshAuthentication::Password { askpass, socket } => {
            if !askpass.is_absolute() || !socket.is_absolute() {
                bail!("SSH 密码交互程序不可用");
            }
            command.args([
                "-o",
                "BatchMode=no",
                "-o",
                "PreferredAuthentications=password,keyboard-interactive",
                "-o",
                "PasswordAuthentication=yes",
                "-o",
                "KbdInteractiveAuthentication=yes",
                "-o",
                "PubkeyAuthentication=no",
                "-o",
                "NumberOfPasswordPrompts=1",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "SendEnv=-LATTE_WORK_SSH_*",
            ]);
            command.env("SSH_ASKPASS", askpass);
            command.env("SSH_ASKPASS_REQUIRE", "force");
            command.env("DISPLAY", "latte-work");
            command.env("LATTE_WORK_SSH_ASKPASS", "1");
            command.env("LATTE_WORK_SSH_ASKPASS_SOCKET", socket);
        }
    }
    command.args([
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "--",
        host,
    ]);
    let remote_command = if binary.is_empty() {
        // Noninteractive SSH often omits ~/.local/bin from PATH.
        let discover = r#"if [ -x "$HOME/.local/bin/latte-work-server" ]; then
  exec "$HOME/.local/bin/latte-work-server" connect
fi
candidate=$(command -v latte-work-server 2>/dev/null || true)
if [ -n "$candidate" ] && [ -x "$candidate" ]; then
  exec "$candidate" connect
fi
printf '%s\n' '{"kind":"error","code":"server_not_found","message":"远程未找到 latte-work-server；请先安装或填写绝对路径"}'"#;
        format!("exec /bin/sh -c {}", shell_quote(discover))
    } else {
        format!("exec {} connect", shell_quote(binary))
    };
    command.arg(remote_command);
    Ok(command)
}
pub fn validate_identity_file(path: &Path) -> Result<()> {
    if !path.is_absolute() || !path.is_file() {
        bail!("身份文件必须是本机现有文件的绝对路径");
    }
    Ok(())
}
pub fn validate_host(host: &str) -> Result<()> {
    if host.is_empty()
        || host.len() > 255
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-@:".contains(&b))
    {
        bail!("请输入有效的 SSH Host 别名或 user@hostname");
    }
    Ok(())
}
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prevents_ssh_options_and_shell_injection() {
        for host in ["-oProxyCommand=bad", "a;touch x", "$(id)", "a b", ""] {
            assert!(validate_host(host).is_err());
        }
        assert!(validate_host("user@devbox").is_ok());
        assert_eq!(shell_quote("/a'b/server"), "'/a'\\''b/server'");
    }
    #[test]
    fn ssh_auth_modes_keep_password_out_of_arguments() {
        let key = std::env::current_exe().unwrap();
        let args = |command: Command| {
            command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let normal =
            args(ssh_command("user@devbox", "/server", None, SshAuthentication::OpenSsh).unwrap());
        assert!(normal.contains(&"BatchMode=yes".to_owned()));
        let identity = args(
            ssh_command(
                "devbox",
                "/server",
                Some(2222),
                SshAuthentication::IdentityFile(&key),
            )
            .unwrap(),
        );
        assert!(identity.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(
            identity
                .windows(2)
                .any(|pair| pair == ["-i", key.to_str().unwrap()])
        );
        assert!(identity.contains(&"IdentitiesOnly=yes".to_owned()));
        let command = ssh_command(
            "devbox",
            "/server",
            None,
            SshAuthentication::Password {
                askpass: &key,
                socket: &key,
            },
        )
        .unwrap();
        let env = command
            .as_std()
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(env.contains(&"LATTE_WORK_SSH_ASKPASS_SOCKET".to_owned()));
        assert!(!env.contains(&"LATTE_WORK_SSH_PASSWORD".to_owned()));
        let password_args = args(command);
        assert!(password_args.contains(&"StrictHostKeyChecking=yes".to_owned()));
        assert!(password_args.contains(&"NumberOfPasswordPrompts=1".to_owned()));
        assert!(password_args.contains(&"SendEnv=-LATTE_WORK_SSH_*".to_owned()));
        assert!(!password_args.iter().any(|arg| arg.contains("secret-value")));
        assert!(ssh_command("devbox", "/server", Some(0), SshAuthentication::OpenSsh).is_err());
        assert!(
            ssh_command(
                "devbox",
                "/server",
                None,
                SshAuthentication::IdentityFile(Path::new("relative"))
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn empty_server_path_discovers_standard_remote_locations() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command as StdCommand;

        let command = ssh_command("devbox", "", None, SshAuthentication::OpenSsh).unwrap();
        let remote = command.as_std().get_args().last().unwrap();
        let root = std::env::temp_dir().join(format!(
            "latte-work-ssh-discovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let local_bin = root.join(".local/bin");
        let path_bin = root.join("path-bin");
        std::fs::create_dir_all(&local_bin).unwrap();
        std::fs::create_dir(&path_bin).unwrap();
        let run = || {
            StdCommand::new("/bin/sh")
                .arg("-c")
                .arg(remote)
                .env("HOME", &root)
                .env("PATH", format!("{}:/usr/bin:/bin", path_bin.display()))
                .output()
                .unwrap()
        };
        let make_binary = |path: &Path, label: &str| {
            std::fs::write(
                path,
                format!("#!/bin/sh\nprintf '%s:%s\\n' '{label}' \"$1\"\n"),
            )
            .unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        };
        let local = local_bin.join("latte-work-server");
        let fallback = path_bin.join("latte-work-server");
        make_binary(&local, "local");
        make_binary(&fallback, "path");
        assert_eq!(run().stdout, b"local:connect\n");
        std::fs::remove_file(&local).unwrap();
        assert_eq!(run().stdout, b"path:connect\n");
        std::fs::remove_file(&fallback).unwrap();
        let missing = run();
        let response: serde_json::Value = serde_json::from_slice(&missing.stdout).unwrap();
        assert_eq!(response["code"], "server_not_found");
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            ssh_command(
                "devbox",
                "relative/server",
                None,
                SshAuthentication::OpenSsh
            )
            .is_err()
        );
    }
}
