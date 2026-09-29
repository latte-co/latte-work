//! Graceful App exit: stop owned turns/terminals, then drain an idle local daemon.
use crate::Connections;
use latte_work_protocol::{Request, Response, Status};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub(crate) type CloseAck = (String, tokio::sync::oneshot::Sender<Result<(), String>>);

pub(crate) fn settled(status: &Status) -> bool {
    matches!(
        status,
        Status::Ready | Status::Completed | Status::Failed | Status::Stopped
    )
}
async fn stop_owned(state: &Connections) -> Result<(), String> {
    // Wait for in-flight sends to reconcile before inspecting their sessions.
    let _admission = state.admission.write().await;
    let turns: Vec<_> = state.turns.lock().await.keys().cloned().collect();
    for (host, session_id) in turns {
        let client = state
            .clients
            .lock()
            .await
            .get(&host)
            .cloned()
            .ok_or_else(|| format!("{host} 未连接，无法确认任务已停止；请重连后再退出"))?;
        let mut client = client.lock().await;
        let mut cancelled = false;
        loop {
            let response = client
                .request(Request::Poll {
                    session_id: session_id.clone(),
                    after: f64::MAX,
                })
                .await
                .map_err(|e| format!("{host}：{e:#}"))?;
            match response {
                Response::Events { session, .. } if settled(&session.status) => break,
                Response::Events { session, .. }
                    if matches!(session.status, Status::Running | Status::Waiting) => {}
                Response::Events { .. } => {
                    return Err(format!("{host}：任务状态待确认，不能确认 Agent 已停止"));
                }
                other => return Err(format!("{host}：无法确认任务状态：{other:?}")),
            }
            if !cancelled {
                match client
                    .request(Request::Cancel {
                        session_id: session_id.clone(),
                    })
                    .await
                    .map_err(|e| format!("{host}：{e:#}"))?
                {
                    Response::Ok => cancelled = true,
                    other => return Err(format!("{host}：停止任务失败：{other:?}")),
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        state.turns.lock().await.remove(&(host, session_id));
    }
    let terminals: Vec<_> = state.terminals.lock().await.iter().cloned().collect();
    for (host, terminal_id) in terminals {
        let client = state
            .clients
            .lock()
            .await
            .get(&host)
            .cloned()
            .ok_or_else(|| format!("{host} 未连接，无法确认终端已关闭；请重连后再退出"))?;
        let response = client
            .lock()
            .await
            .request(Request::CloseTerminal {
                terminal_id: terminal_id.clone(),
            })
            .await
            .map_err(|e| format!("{host}：{e:#}"))?;
        if !matches!(response, Response::Ok) {
            return Err(format!("{host}：关闭终端失败：{response:?}"));
        }
        state.terminals.lock().await.remove(&(host, terminal_id));
    }
    // Owned resources are settled. A shared busy daemon must remain alive;
    // failure of this optional idle shutdown never kills it or blocks App exit.
    if let Some(local) = state.clients.lock().await.get("local").cloned() {
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            local.lock().await.shutdown_if_idle().await
        })
        .await;
    }
    state.clients.lock().await.clear();
    state.passwords.lock().await.clear();
    Ok(())
}
#[tauri::command]
pub async fn app_close_ready(
    state: State<'_, Connections>,
    request_id: String,
    error: Option<String>,
) -> Result<(), String> {
    finish_close(&state, &request_id, error).await;
    Ok(())
}
async fn finish_close(state: &Connections, request_id: &str, error: Option<String>) {
    let mut pending = state.close_ack.lock().await;
    if pending.as_ref().is_some_and(|(id, _)| id == request_id)
        && let Some((_, reply)) = pending.take()
    {
        let _ = reply.send(error.map_or(Ok(()), Err));
    }
}
async fn close_tabs(app: &tauri::AppHandle, state: &Connections) -> Result<(), String> {
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos()
        .to_string();
    let (reply, result) = tokio::sync::oneshot::channel();
    *state.close_ack.lock().await = Some((id.clone(), reply));
    app.emit_to("main", "app-close-requested", &id)
        .map_err(|e| e.to_string())?;
    result
        .await
        .map_err(|_| "Tab 清理确认通道已关闭".to_string())?
}
pub fn quit(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Connections>();
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            close_tabs(&app, &state).await?;
            stop_owned(&state).await
        })
        .await
        .unwrap_or_else(|_| Err("清理任务或终端超时，App 尚未退出。请检查主机连接后重试".into()));
        state.close_ack.lock().await.take();
        match result {
            Ok(()) => {
                state.exit_ready.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            Err(error) => {
                state.quitting.store(false, Ordering::SeqCst);
                let _ = app.emit_to("main", "app-close-cancelled", ());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                app.dialog().message(error).title("退出未完成").show(|_| {});
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn only_current_tab_cleanup_ack_can_finish_exit() {
        let state = Connections::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        *state.close_ack.lock().await = Some(("current".into(), tx));
        finish_close(&state, "old", None).await;
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        finish_close(&state, "current", Some("terminal offline".into())).await;
        assert_eq!(rx.await.unwrap(), Err("terminal offline".into()));
    }
    #[tokio::test]
    async fn disconnected_owned_terminal_blocks_exit_and_keeps_ownership() {
        let state = Connections::default();
        state
            .terminals
            .lock()
            .await
            .insert(("remote".into(), "terminal".into()));
        assert!(stop_owned(&state).await.unwrap_err().contains("终端"));
        assert_eq!(state.terminals.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn disconnected_owned_turn_blocks_exit_without_forgetting_it() {
        let state = Connections::default();
        state
            .turns
            .lock()
            .await
            .insert(("remote".into(), "session".into()), "request".into());
        assert!(stop_owned(&state).await.unwrap_err().contains("未连接"));
        assert_eq!(state.turns.lock().await.len(), 1);
        assert!(!state.exit_ready.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn quit_waits_for_inflight_admission_before_completing() {
        let state = Connections::default();
        let pending_send = state.admission.read().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), stop_owned(&state))
                .await
                .is_err()
        );
        drop(pending_send);
        assert!(stop_owned(&state).await.is_ok());
    }
    #[test]
    fn quit_requires_confirmed_terminal_state() {
        for status in [
            Status::Ready,
            Status::Completed,
            Status::Failed,
            Status::Stopped,
        ] {
            assert!(settled(&status));
        }
        for status in [Status::Running, Status::Waiting, Status::Unknown] {
            assert!(!settled(&status));
        }
    }
}
