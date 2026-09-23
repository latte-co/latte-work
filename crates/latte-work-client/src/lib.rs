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
impl Client {
    pub async fn local(binary: &Path, state: Option<&Path>) -> Result<Self> {
        let mut command = Command::new(binary);
        command.arg("connect");
        if let Some(state) = state {
            command.arg("--state-dir").arg(state);
        }
        Self::spawn(command).await
    }
    pub async fn ssh(host: &str, binary: &str) -> Result<Self> {
        validate_host(host)?;
        if !binary.starts_with('/') || binary.contains(['\n', '\r', '\0']) {
            bail!("远程 Server 必须是绝对路径");
        }
        let mut command = Command::new("ssh");
        command.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "--",
            host,
        ]);
        command.arg(format!("exec {} connect", shell_quote(binary)));
        Self::spawn(command)
            .await
            .context("SSH 连接失败；请先在终端完成该 Host 的首次连接，并确认远程 Server 已安装")
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
}
