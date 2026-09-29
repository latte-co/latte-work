//! Graceful App exit: cancel owned Agent turns, never kill a shared host daemon.
use crate::Connections;
use latte_work_protocol::{Request, Response, Status};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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
    state.clients.lock().await.clear();
    state.passwords.lock().await.clear();
    Ok(())
}
pub fn quit(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Connections>();
        let result = tokio::time::timeout(Duration::from_secs(30), stop_owned(&state))
            .await
            .unwrap_or_else(|_| {
                Err("停止任务超时，App 尚未退出。请检查主机连接和任务状态后重试".into())
            });
        match result {
            Ok(()) => {
                state.exit_ready.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            Err(error) => {
                state.quitting.store(false, Ordering::SeqCst);
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
