//! Local lifecycle handshake, intentionally independent of the application wire version.
//! SSH continues to use `connect`, which never replaces a running daemon.
use crate::{Service, connect_socket, db, lock};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
pub use latte_work_protocol::lifecycle::{Request, Response};
use sha2::{Digest, Sha256};
use std::{fs::OpenOptions, io::Read, path::Path, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    sync::{Notify, RwLock},
};
use tokio_util::codec::{FramedRead, LinesCodec};

pub struct Lifecycle {
    build_id: String,
    pub draining: RwLock<bool>,
    pub shutdown: Notify,
}
impl Lifecycle {
    pub fn new() -> Result<Self> {
        Ok(Self {
            build_id: executable_id()?,
            draining: RwLock::new(false),
            shutdown: Notify::new(),
        })
    }
}
fn executable_id() -> Result<String> {
    let mut file = std::fs::File::open(std::env::current_exe()?)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub async fn handle(service: &Service, request: Request) -> Response {
    match handle_inner(service, request).await {
        Ok(response) => response,
        Err(error) => Response::Error {
            code: "upgrade_blocked".into(),
            message: error.to_string(),
        },
    }
}
async fn handle_inner(service: &Service, request: Request) -> Result<Response> {
    match request {
        Request::ServerStatus => Ok(Response::ServerStatus {
            server_id: service.server_id.clone(),
            build_id: service.lifecycle.build_id.clone(),
            draining: *service.lifecycle.draining.read().await,
        }),
        Request::PrepareUpgrade { server_id } => {
            if server_id != service.server_id {
                bail!("后台实例已变化，请重新连接");
            }
            let mut draining =
                tokio::time::timeout(Duration::from_secs(2), service.lifecycle.draining.write())
                    .await
                    .context("后台正在处理请求，请稍后重新连接以更新")?;
            let running = !service
                .runs
                .lock()
                .map_err(|_| anyhow::anyhow!("run lock poisoned"))?
                .is_empty();
            let terminals = !service
                .terminals
                .lock()
                .map_err(|_| anyhow::anyhow!("终端锁异常"))?
                .is_empty();
            if running || terminals || db(&service.database, |d| d.has_active_sessions())? {
                bail!(
                    "本机后台需要更新，但仍有任务或终端；请等待任务完成并关闭终端后重新连接。当前任务不会中断"
                );
            }
            *draining = true;
            Ok(Response::UpgradeReady)
        }
    }
}
async fn exchange(stream: UnixStream, request: &Request) -> Result<Response> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let (reader, mut writer) = stream.into_split();
        let mut bytes = serde_json::to_vec(request)?;
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        let mut lines = FramedRead::new(reader, LinesCodec::new_with_max_length(4096));
        let line = lines.next().await.context("后台连接关闭")??;
        Ok::<_, anyhow::Error>(serde_json::from_str(&line)?)
    })
    .await
    .context("后台升级检查超时")?
}
const LEGACY: &str = "检测到旧版本机后台，无法安全确认其任务状态；请先在旧版应用中完成任务并关闭终端，再手动重启本机 Server，然后重新连接。仅重启桌面应用不会停止后台";

/// Serialize local coordinators, ask the owning daemon to drain atomically, then wait for
/// its singleton lock. Never kill a daemon, remove its socket, or replay application requests.
pub async fn connect_local(dir: &Path) -> Result<UnixStream> {
    tokio::time::timeout(Duration::from_secs(20), connect_local_inner(dir))
        .await
        .context("本机后台切换超时，请稍后重新连接；任务不会自动重发")?
}
async fn connect_local_inner(dir: &Path) -> Result<UnixStream> {
    let coordinator = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("upgrade.lock"))?;
    loop {
        match coordinator.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(error) => return Err(error.into()),
        }
    }
    let build_id = executable_id()?;
    let stream = connect_socket(dir).await?;
    match exchange(stream, &Request::ServerStatus)
        .await
        .context("无法确认本机后台版本，请稍后重新连接；后台未被停止")?
    {
        Response::ServerStatus {
            build_id: current,
            draining: false,
            ..
        } if current == build_id => {}
        Response::ServerStatus {
            server_id,
            draining,
            ..
        } => {
            if !draining {
                let stream = UnixStream::connect(dir.join("control.sock")).await?;
                match exchange(stream, &Request::PrepareUpgrade { server_id }).await? {
                    Response::UpgradeReady => {}
                    Response::Error { message, .. } => bail!("{message}"),
                    _ => bail!("后台升级响应不兼容，请重新连接"),
                }
            }
            // The lock is released only after the old daemon has removed its own socket.
            loop {
                if let Ok(guard) = lock(dir) {
                    drop(guard);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let stream = connect_socket(dir).await?;
            match exchange(stream, &Request::ServerStatus).await? {
                Response::ServerStatus {
                    build_id: current,
                    draining: false,
                    ..
                } if current == build_id => {}
                _ => bail!("另一个版本的后台已启动，请关闭其他版本应用后重新连接"),
            }
        }
        _ => bail!("{LEGACY}"),
    }
    // Return this exact, verified instance's socket. Recheck after reconnect because a
    // concurrent external shutdown/start may otherwise attach us to a different build.
    let mut stream = UnixStream::connect(dir.join("control.sock")).await?;
    let mut bytes = serde_json::to_vec(&Request::ServerStatus)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    let mut response = Vec::new();
    // Read exactly one line; do not buffer and discard any subsequent application bytes.
    use tokio::io::AsyncReadExt;
    loop {
        let byte = stream.read_u8().await?;
        if byte == b'\n' {
            break;
        }
        if response.len() >= 4096 {
            bail!("后台状态响应过大");
        }
        response.push(byte);
    }
    match serde_json::from_slice::<Response>(&response)? {
        Response::ServerStatus {
            build_id: current,
            draining: false,
            ..
        } if current == build_id => Ok(stream),
        _ => bail!("后台实例已变化，请重新连接"),
    }
}
