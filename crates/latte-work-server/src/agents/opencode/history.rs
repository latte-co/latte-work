//! Bounded, prompt-free recovery of a known child's native transcript.
use crate::{
    agents::{ChildHistoryCursor, ChildHistoryPage},
    providers::LaunchConfig,
    runtime::Group,
};
use anyhow::{Context, Result, ensure};
use latte_work_protocol::{Event, EventKind};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

const LIMIT: u64 = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 8;

pub(in crate::agents) async fn read(
    binary: &str,
    cwd: &Path,
    parent: &str,
    child: &str,
    known_children: &HashSet<String>,
    session_id: &str,
    config: &LaunchConfig,
) -> Result<Option<ChildHistoryPage>> {
    if parent == child {
        return Ok(None);
    }
    tokio::time::timeout(Duration::from_secs(6), async {
        let Some(document) = export(binary, cwd, child, config).await? else {
            return Ok(None);
        };
        let mut current = &document;
        let mut ancestor;
        let mut seen = HashSet::from([child.to_owned()]);
        for depth in 1..=MAX_DEPTH {
            let Some(id) = current["info"]["parentID"].as_str() else {
                break;
            };
            if id == parent {
                return history(&document, child, session_id, config);
            }
            if depth == MAX_DEPTH || !known_children.contains(id) || !seen.insert(id.to_owned()) {
                break;
            }
            let Some(next) = export(binary, cwd, id, config).await? else {
                break;
            };
            ancestor = next;
            current = &ancestor;
        }
        Ok(None)
    })
    .await
    .context("读取 OpenCode 子任务历史超时")?
}

async fn export(
    binary: &str,
    cwd: &Path,
    id: &str,
    config: &LaunchConfig,
) -> Result<Option<Value>> {
    if !id.starts_with("ses_")
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Ok(None);
    }
    let process = crate::agent_environment::command(binary)
        .envs(&config.environment.0)
        .current_dir(cwd)
        .args(["session", "export", "--standalone", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()?;
    let pid = process.id().context("OpenCode export PID missing")? as i32;
    let mut group = Group {
        child: process,
        pid,
    };
    let stdout = group
        .child
        .stdout
        .take()
        .context("OpenCode export stdout missing")?;
    let bytes = bounded(stdout).await?;
    if !group.child.wait().await?.success() {
        return Ok(None);
    }
    let mut document: Value = serde_json::from_slice(&bytes).context("无效的 OpenCode 导出")?;
    if let Some(data) = document.get_mut("data") {
        document = data.take();
    }
    let info = &document["info"];
    let directory = info["location"]["directory"].as_str().map(Path::new);
    Ok((info["id"] == id && directory == Some(cwd)).then_some(document))
}

fn history(
    document: &Value,
    child: &str,
    session_id: &str,
    config: &LaunchConfig,
) -> Result<Option<ChildHistoryPage>> {
    let messages = document["messages"]
        .as_array()
        .context("OpenCode 导出缺少消息")?;
    let mut events = Vec::new();
    let mut pending_tail = false;
    let redactor = config.redactor();
    let mut bytes = 0;
    for message in messages {
        let at = message["time"]["created"].as_f64().unwrap_or_default();
        for event in message_events(message, &mut pending_tail) {
            let event = redactor.event(event);
            bytes += serde_json::to_vec(&event)?.len();
            ensure!(
                bytes <= LIMIT as usize && events.len() < 4096,
                "OpenCode 子任务历史超出限制"
            );
            events.push(Event {
                seq: (events.len() + 1) as f64,
                session_id: session_id.into(),
                at,
                event,
                content_size: None,
            });
        }
    }
    if events.is_empty() {
        return Ok(None);
    }
    let cursor = ChildHistoryCursor {
        identity: child.into(),
        offset: events.len() as u64,
        pending_tail,
        ..Default::default()
    };
    Ok(Some(ChildHistoryPage {
        events,
        cursor,
        has_more: false,
    }))
}

async fn bounded(stdout: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stdout.take(LIMIT + 1).read_to_end(&mut bytes).await?;
    ensure!(bytes.len() as u64 <= LIMIT, "OpenCode 导出超出读取范围");
    Ok(bytes)
}

fn message_events(message: &Value, pending_tail: &mut bool) -> Vec<EventKind> {
    let mut events = Vec::new();
    if message["type"] == "user" {
        if let (Some(text), Some(id)) = (message["text"].as_str(), message["id"].as_str()) {
            events.push(EventKind::User {
                text: text.into(),
                request_id: id.into(),
            });
        }
    } else if message["type"] == "assistant" {
        for part in message["content"].as_array().into_iter().flatten() {
            if let Some(text) = part["text"].as_str().filter(|_| part["type"] == "text") {
                events.push(EventKind::Text { text: text.into() });
            } else if part["type"] == "tool"
                && let (Some(id), Some(name)) = (part["id"].as_str(), part["name"].as_str())
            {
                let state = &part["state"];
                let is_error = state["status"] == "error";
                let input = state["input"].clone();
                let (name, input) = super::named_tool(
                    super::tool_label(&json!({"name":name,"rawInput":input}), None),
                    input,
                );
                events.push(EventKind::Tool {
                    id: id.into(),
                    name,
                    input,
                });
                if !is_error && state["status"] != "completed" {
                    *pending_tail = true;
                    continue;
                }
                let mut images = super::super::ToolImages::default();
                let mut content: Vec<_> = state["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| {
                        if part["type"] == "text" {
                            return Some(json!({"type":"text","text":part["text"].as_str()?}));
                        }
                        let (mime, data) = part["uri"]
                            .as_str()?
                            .strip_prefix("data:")?
                            .split_once(";base64,")?;
                        Some(images.inline(mime, data))
                    })
                    .collect();
                if is_error
                    && let Some(message) = state["error"]["message"].as_str()
                    && !content.iter().any(|item| item["text"] == message)
                {
                    content.push(json!({"type":"text","text":message}));
                }
                events.push(EventKind::ToolResult {
                    id: id.into(),
                    content: json!(content),
                    is_error,
                });
            }
        }
    }
    events
}
