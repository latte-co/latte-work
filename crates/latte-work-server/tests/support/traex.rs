use super::*;
use latte_work_protocol::{Effort, TurnProvider};

async fn pending_entry(
    client: &mut Client,
    id: &str,
    request: &str,
    revision: u32,
) -> latte_work_protocol::QueuedMessage {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Response::MessageQueue { entries, .. } = ask(
            client,
            Request::MessageQueue {
                session_id: id.into(),
            },
        )
        .await
            && let Some(entry) = entries
                .into_iter()
                .find(|e| e.request_id == request && e.revision == revision)
        {
            return entry;
        }
        assert!(Instant::now() < deadline, "pending queue entry");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn session(client: &mut Client, root: &Path) -> String {
    let Response::Project { project } = ask(
        client,
        Request::AddProject {
            path: root.to_string_lossy().into_owned(),
            name: None,
        },
    )
    .await
    else {
        panic!("project")
    };
    let Response::Session { session } = ask(
        client,
        Request::CreateSession {
            project_id: project.id,
            agent: "traex".into(),
        },
    )
    .await
    else {
        panic!("session")
    };
    session.id
}
async fn send(client: &mut Client, id: &str, request: &str, text: &str) -> Response {
    let response = ask(
        client,
        Request::SendQueued {
            session_id: id.into(),
            request_id: request.into(),
            text: text.into(),
            model: Some("seed-test".into()),
            effort: Some(Effort::High),
            permission_mode: Some("default".into()),
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    assert!(!matches!(response, Response::Error { .. }), "{response:?}");
    response
}
async fn until(
    client: &mut Client,
    id: &str,
    status: Status,
) -> (
    latte_work_protocol::Session,
    Vec<latte_work_protocol::Event>,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Response::Events {
            session, events, ..
        } = ask(
            client,
            Request::Poll {
                session_id: id.into(),
                after: 0.0,
            },
        )
        .await
        else {
            panic!("poll")
        };
        if session.status == status {
            return (session, events);
        }
        assert!(
            Instant::now() < deadline,
            "expected {status:?}, got {:?}: {events:?}",
            session.status
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn until_text(client: &mut Client, id: &str, text: &str) -> Vec<latte_work_protocol::Event> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Response::Events {
            session, events, ..
        } = ask(
            client,
            Request::Poll {
                session_id: id.into(),
                after: 0.0,
            },
        )
        .await
        else {
            panic!("poll")
        };
        if events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text: seen } if seen == text))
        {
            return events;
        }
        assert!(
            Instant::now() < deadline,
            "expected text {text:?}, got {:?}: {events:?}",
            session.status
        );
        assert!(
            session.status.active(),
            "the session ended before text {text:?} arrived: {:?}",
            session.status
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
#[tokio::test]
async fn traex_backgrounded_commands_keep_native_process_and_confirm_only_explicit_exits() {
    for failed in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = session(&mut client, root.path()).await;
        send(&mut client, &id, "background", "background").await;
        let (_, events) = until(&mut client, &id, Status::Completed).await;
        assert!(events.iter().any(|e| matches!(&e.event, EventKind::Notice {text} if text.contains("47462") && text.contains("partial regression output") && text.contains("结果待确认"))));
        assert!(!events.iter().any(
            |e| matches!(&e.event, EventKind::ToolResult {id, ..} if id == "background-start")
        ));
        assert!(events.iter().any(
            |e| matches!(&e.event, EventKind::TurnChanges {changes} if changes.background_pending)
        ));
        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: id.clone(),
                    only_if_idle: Some(true)
                }
            )
            .await,
            Response::Error { .. }
        ));
        // Reconnecting reads durable evidence without reopening/replaying work.
        drop(client);
        let mut client = host.client().await;
        let (_, restored) = until(&mut client, &id, Status::Completed).await;
        assert_eq!(events.len(), restored.len());
        assert!(
            matches!(
                ask(
                    &mut client,
                    Request::SendQueued {
                        session_id: id.clone(),
                        request_id: "reconfigure".into(),
                        text: "must not dispatch".into(),
                        model: Some("gpt-test".into()),
                        effort: Some(Effort::High),
                        permission_mode: Some("default".into()),
                        provider: Some(TurnProvider::Cli)
                    }
                )
                .await,
                Response::Error { .. }
            ),
            "changing configuration must preserve the live background process"
        );
        let prompt = if failed {
            "background-poll-failure"
        } else {
            "background-poll-success"
        };
        send(&mut client, &id, "poll", prompt).await;
        let (_, events) = until(&mut client, &id, Status::Completed).await;
        assert!(events.iter().any(|e| matches!(&e.event, EventKind::ToolResult {id, is_error, content} if id == "background-poll" && *is_error == failed && content == "final regression output")));
        assert!(!events.iter().any(|e| matches!(
            &e.event,
            EventKind::State {
                status: Status::Failed,
                ..
            }
        )));
        let inputs = std::fs::read_to_string(root.path().join("traex-inputs"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(inputs.len(), 2, "reconnect must not replay a prompt");
        assert_eq!(
            inputs[0]["pid"], inputs[1]["pid"],
            "background work must retain its owning process"
        );
        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: id.clone(),
                    only_if_idle: Some(true)
                }
            )
            .await,
            Response::Ok
        ));
    }
}
#[tokio::test]
async fn traex_background_work_alive_at_turn_start_keeps_the_next_turn_undo_fenced() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let project = root.path().canonicalize().unwrap();
    assert!(
        Command::new("git")
            .current_dir(&project)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(project.join(".gitignore"), "fixture-agent-pid\n").unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, &project).await;
    // Turn 1 backgrounds a command and ends while the work is still alive.
    send(&mut client, &id, "background", "background").await;
    until(&mut client, &id, Status::Completed).await;
    // Turn 2 starts while that work is alive; the background command then
    // writes a file and exits during this turn, so the adapter's tracking
    // clears before the turn ends.
    send(&mut client, &id, "turn-2", "background-write").await;
    let (_, events) = until(&mut client, &id, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text == "BACKGROUND_WROTE"))
    );
    let Response::TurnChanges { changes } = ask(
        &mut client,
        Request::TurnChangeSummary {
            path: None,
            offset: None,
            session_id: id.clone(),
            request_id: "turn-2".into(),
        },
    )
    .await
    else {
        panic!("turn changes")
    };
    assert!(
        changes.background_pending,
        "a turn that started with live background work must stay undo-fenced"
    );
    assert!(
        changes
            .summary
            .entries
            .iter()
            .any(|e| e.path == "background-late.txt"),
        "the late background write belongs to this turn's diff"
    );
    assert!(
        matches!(
            ask(
                &mut client,
                Request::UndoTurnChanges {
                    session_id: id.clone(),
                    request_id: "turn-2".into(),
                }
            )
            .await,
            Response::Error { .. }
        ),
        "undo must stay fenced even after the background work finished"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("background-late.txt")).unwrap(),
        "written by background command\n",
        "undoing the later turn must not revert background work"
    );
}
#[tokio::test]
async fn traex_background_late_writes_survive_abnormal_turn_endings() {
    for eof in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let project = root.path().canonicalize().unwrap();
        assert!(
            Command::new("git")
                .current_dir(&project)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
        std::fs::write(project.join(".gitignore"), "fixture-agent-pid\n").unwrap();
        let mut client = host.client().await;
        let id = session(&mut client, &project).await;
        // Turn 1 backgrounds a command and ends while the work is still alive.
        send(&mut client, &id, "background", "background").await;
        until(&mut client, &id, Status::Completed).await;
        // Turn 2 starts while that work is alive; the background command then
        // writes a file and exits during this turn, and the turn itself ends
        // abnormally (agent EOF or a forced session cancel).
        send(
            &mut client,
            &id,
            "turn-2",
            if eof {
                "background-write-eof"
            } else {
                "background-write-hold"
            },
        )
        .await;
        if eof {
            let (_, events) = until(&mut client, &id, Status::Failed).await;
            assert!(
                events.iter().any(
                    |e| matches!(&e.event, EventKind::Text { text } if text == "BACKGROUND_LATE")
                ),
                "the late write must land before the abnormal ending"
            );
        } else {
            // Let the background write land first: the forced close kills the
            // native process, so waiting afterwards would race its final
            // output. A forced close (only_if_idle unset) must reach the
            // runtime even while the turn is still active; a plain cancel
            // would only interrupt through the normal interrupt path.
            until_text(&mut client, &id, "BACKGROUND_LATE").await;
            assert!(matches!(
                ask(
                    &mut client,
                    Request::CloseAgentSession {
                        session_id: id.clone(),
                        only_if_idle: None,
                    }
                )
                .await,
                Response::Ok
            ));
            until(&mut client, &id, Status::Stopped).await;
        }
        let Response::TurnChanges { changes } = ask(
            &mut client,
            Request::TurnChangeSummary {
                path: None,
                offset: None,
                session_id: id.clone(),
                request_id: "turn-2".into(),
            },
        )
        .await
        else {
            panic!("turn changes must survive an abnormal ending")
        };
        assert!(
            changes.background_pending,
            "a turn that started with live background work must stay undo-fenced across abnormal endings"
        );
        assert!(
            matches!(
                ask(
                    &mut client,
                    Request::UndoTurnChanges {
                        session_id: id.clone(),
                        request_id: "turn-2".into(),
                    }
                )
                .await,
                Response::Error { .. }
            ),
            "undoing the aborted turn must be rejected"
        );
        assert_eq!(
            std::fs::read_to_string(project.join("background-late.txt")).unwrap(),
            "written by background command\n",
            "undoing the aborted turn must not revert background work"
        );
    }
}
#[tokio::test]
async fn traex_backgrounded_commands_stay_unconfirmed_after_stop_or_eof() {
    for eof in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = session(&mut client, root.path()).await;
        send(
            &mut client,
            &id,
            "background",
            if eof { "background" } else { "background-wait" },
        )
        .await;
        if eof {
            until(&mut client, &id, Status::Completed).await;
            send(&mut client, &id, "eof", "eof").await;
        } else {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let (_, events) = until(&mut client, &id, Status::Running).await;
                if events.iter().any(
                    |e| matches!(&e.event, EventKind::Text {text} if text == "BACKGROUND_WAITING"),
                ) {
                    break;
                }
                assert!(Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(matches!(
                ask(
                    &mut client,
                    Request::Cancel {
                        session_id: id.clone()
                    }
                )
                .await,
                Response::Ok
            ));
        }
        let (_, events) = until(
            &mut client,
            &id,
            if eof { Status::Failed } else { Status::Stopped },
        )
        .await;
        assert!(!events.iter().any(
            |e| matches!(&e.event, EventKind::ToolResult {id, ..} if id == "background-start")
        ));
        if !eof {
            // Stop pauses the durable queue. Explicit resume must drain a poll
            // through the existing process even with unfinished background work.
            send(&mut client, &id, "poll", "background-poll-success").await;
            assert!(matches!(
                ask(
                    &mut client,
                    Request::ResumeMessageQueue {
                        session_id: id.clone(),
                        provider: Some(TurnProvider::Cli)
                    }
                )
                .await,
                Response::MessageQueue { .. }
            ));
            let (_, events) = until(&mut client, &id, Status::Completed).await;
            assert!(events.iter().any(|e| matches!(&e.event, EventKind::ToolResult {id,is_error:false,..} if id == "background-poll")));
        }
        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: id.clone(),
                    only_if_idle: None
                }
            )
            .await,
            Response::Ok
        ));
    }
}
#[tokio::test]
async fn traex_completed_items_and_early_completions_settle_without_duplicate_text() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "completed", "complete-only").await;
    let (_, events) = until(&mut client, &id, Status::Completed).await;
    let text = events
        .iter()
        .filter_map(|e| match &e.event {
            EventKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(text, "ONCE");
    send(&mut client, &id, "early", "early-complete").await;
    let (saved, _) = until(&mut client, &id, Status::Completed).await;
    assert_eq!(saved.native_id.as_deref(), Some("traex-native-thread"));
    send(&mut client, &id, "following", "following").await;
    let (_, events) = until(&mut client, &id, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text {text} if text == "TRAE:following"))
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("traex-inputs"))
            .unwrap()
            .lines()
            .count(),
        3
    );
}
#[tokio::test]
async fn traex_late_interrupt_error_keeps_stopped_state_and_same_process_for_followup() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "waiting", "wait-interrupt-race").await;
    until(&mut client, &id, Status::Running).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::Cancel {
                session_id: id.clone()
            }
        )
        .await,
        Response::Ok
    ));
    until(&mut client, &id, Status::Stopped).await;
    send(&mut client, &id, "following", "following").await;
    assert!(matches!(
        ask(
            &mut client,
            Request::ResumeMessageQueue {
                session_id: id.clone(),
                provider: Some(TurnProvider::Cli)
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    let (_, events) = until(&mut client, &id, Status::Completed).await;
    assert!(
        !events.iter().any(|e| matches!(
            &e.event,
            EventKind::State {
                status: Status::Failed,
                ..
            }
        )),
        "a completed turn's late interrupt error must not overwrite Stopped"
    );
    let inputs = std::fs::read_to_string(root.path().join("traex-inputs"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 2);
    assert_eq!(
        inputs[0]["pid"], inputs[1]["pid"],
        "the native process must remain usable after the stop race"
    );
}
#[tokio::test]
async fn traex_discovery_open_stream_reconnect_resume_and_queue_use_the_selected_adapter() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let Response::Hello { agents, .. } =
        ask(&mut client, Request::Hello { version: VERSION }).await
    else {
        panic!()
    };
    assert_eq!(
        agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
        ["claude", "traex"]
    );
    assert!(agents[1].available);
    assert_eq!(agents[1].provider_protocols.len(), 3);
    let id = session(&mut client, root.path()).await;
    let Response::Models {
        models,
        model_labels,
        effort_levels,
        ..
    } = ask(
        &mut client,
        Request::ModelsForProvider {
            agent: "traex".into(),
            model: Some("seed-test".into()),
            project_id: None,
            provider: None,
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(models, ["seed-test", "gpt-test", "backend-large"]);
    assert_eq!(model_labels["seed-test"], "Seed Test");
    assert_eq!(effort_levels, [Effort::High]);
    let Response::AgentPermissions { modes } = ask(
        &mut client,
        Request::AgentPermissions {
            agent: "traex".into(),
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(
        modes.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["default", "bypass_permissions"]
    );
    assert!(matches!(
        ask(
            &mut client,
            Request::OpenAgentSession {
                session_id: id.clone(),
                provider: Some(TurnProvider::Cli)
            }
        )
        .await,
        Response::Ok
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.path().join("traex-opens").exists() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !root.path().join("traex-inputs").exists(),
        "Open must not send a prompt"
    );
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: id.clone(),
                only_if_idle: Some(true),
            }
        )
        .await,
        Response::Ok
    ));
    assert!(matches!(
        ask(
            &mut client,
            Request::OpenAgentSession {
                session_id: id.clone(),
                provider: Some(TurnProvider::Cli)
            }
        )
        .await,
        Response::Ok
    ));
    let opens = std::fs::read_to_string(root.path().join("traex-opens")).unwrap();
    assert_eq!(opens.lines().count(), 2);
    assert!(
        !opens.contains("thread/resume"),
        "empty threads have no durable native rollout to resume"
    );
    assert!(
        !root.path().join("traex-inputs").exists(),
        "close/reopen must remain prompt-free"
    );
    assert!(matches!(
        send(&mut client, &id, "one", "hello").await,
        Response::MessageQueued { .. } | Response::Accepted { duplicate: false }
    ));
    let (saved, events) = until(&mut client, &id, Status::Completed).await;
    assert_eq!(saved.native_id.as_deref(), Some("traex-native-thread"));
    assert_eq!(
        events
            .iter()
            .filter_map(|e| if let EventKind::Text { text } = &e.event {
                Some(text.as_str())
            } else {
                None
            })
            .collect::<String>(),
        "TRAE:hello"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event,EventKind::Tool {name,..} if name=="Bash"))
    );
    assert!(events.iter().any(|e| matches!(
        &e.event,
        EventKind::ToolResult {
            is_error: false,
            ..
        }
    )));
    assert!(matches!(
        send(&mut client, &id, "one", "hello").await,
        Response::MessageQueued {
            duplicate: true,
            ..
        } | Response::Accepted { duplicate: true }
    ));
    drop(client);
    let mut client = host.client().await;
    assert!(matches!(
        send(&mut client, &id, "two", "again").await,
        Response::MessageQueued { .. } | Response::Accepted { duplicate: false }
    ));
    until(&mut client, &id, Status::Completed).await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("traex-inputs"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: id.clone(),
                only_if_idle: Some(true)
            }
        )
        .await,
        Response::Ok
    ));
    assert!(matches!(
        send(&mut client, &id, "three", "resumed").await,
        Response::MessageQueued { .. } | Response::Accepted { duplicate: false }
    ));
    until(&mut client, &id, Status::Completed).await;
    let opens = std::fs::read_to_string(root.path().join("traex-opens")).unwrap();
    assert!(opens.contains("thread/resume"));
    assert!(matches!(
        send(&mut client, &id, "wait", "wait").await,
        Response::MessageQueued { .. } | Response::Accepted { duplicate: false }
    ));
    until(&mut client, &id, Status::Running).await;
    assert!(matches!(
        send(&mut client, &id, "queued", "reject-steer").await,
        Response::MessageQueued { .. } | Response::Accepted { duplicate: false }
    ));
    let Response::MessageQueue { entries, .. } = ask(
        &mut client,
        Request::MessageQueue {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!()
    };
    let entry = entries.iter().find(|e| e.request_id == "queued").unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::DispatchQueuedMessage {
                session_id: id.clone(),
                request_id: entry.request_id.clone(),
                revision: entry.revision,
                interrupt: false,
                provider: Some(TurnProvider::Cli)
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    let restored = pending_entry(&mut client, &id, "queued", 1).await;
    assert_eq!(restored.text, "reject-steer");
    // Check rejection before Cancel can independently pause the queue.
    let Response::MessageQueue { paused, reason, .. } = ask(
        &mut client,
        Request::MessageQueue {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!("queue after native rejection")
    };
    assert!(paused);
    assert_eq!(
        reason.as_deref(),
        Some(
            "消息未被 Agent 接收，已退回队列：Traex 未接收消息：current turn cannot accept steering"
        )
    );
    assert!(
        !root.path().join("traex-interrupted").exists(),
        "rejecting one input must not stop the active turn"
    );
    assert!(matches!(
        ask(
            &mut client,
            Request::Cancel {
                session_id: id.clone()
            }
        )
        .await,
        Response::Ok
    ));
    until(&mut client, &id, Status::Stopped).await;
    let Response::MessageQueue {
        entries, paused, ..
    } = ask(
        &mut client,
        Request::MessageQueue {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!()
    };
    assert!(paused);
    assert_eq!(entries.len(), 1);
    assert!(matches!(
        ask(
            &mut client,
            Request::ResumeMessageQueue {
                session_id: id.clone(),
                provider: Some(TurnProvider::Cli)
            }
        )
        .await,
        Response::MessageQueue { .. }
    ));
    until(&mut client, &id, Status::Completed).await;
}
#[tokio::test]
async fn traex_queue_steers_waiting_thinking_replying_and_approval_without_interrupt() {
    let host = Host::start().await;
    let mut client = host.client().await;
    for (index, phase) in ["wait", "wait-think", "wait-reply", "approval"]
        .into_iter()
        .enumerate()
    {
        let root = tempfile::tempdir().unwrap();
        let id = session(&mut client, root.path()).await;
        send(&mut client, &id, &format!("head-{index}"), phase).await;
        let deadline = Instant::now() + Duration::from_secs(10);
        let approvals = loop {
            let Response::Events { events, .. } = ask(
                &mut client,
                Request::Poll {
                    session_id: id.clone(),
                    after: 0.0,
                },
            )
            .await
            else {
                panic!("events");
            };
            if events.iter().any(|e| {
                matches!(&e.event,EventKind::Text{text} if text=="WAITING")
                    || matches!(e.event, EventKind::Approval { .. })
            }) {
                break events;
            }
            assert!(Instant::now() < deadline, "native turn ready");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let queued = format!("extra-{index}");
        send(
            &mut client,
            &id,
            &queued,
            if phase == "approval" {
                "hold-steer"
            } else {
                "extra message"
            },
        )
        .await;
        let entry = pending_entry(&mut client, &id, &queued, 0).await;
        assert!(matches!(
            ask(
                &mut client,
                Request::DispatchQueuedMessage {
                    session_id: id.clone(),
                    request_id: queued.clone(),
                    revision: entry.revision,
                    interrupt: false,
                    provider: Some(TurnProvider::Cli)
                }
            )
            .await,
            Response::MessageQueue { .. }
        ));
        if phase == "approval" {
            let request_id = approvals
                .iter()
                .find_map(|e| match &e.event {
                    EventKind::Approval { request_id, .. } => Some(request_id.clone()),
                    _ => None,
                })
                .unwrap();
            assert!(matches!(
                ask(
                    &mut client,
                    Request::Approve {
                        session_id: id.clone(),
                        request_id,
                        allow: true
                    }
                )
                .await,
                Response::Ok
            ));
        }
        let (_, events) = until(&mut client, &id, Status::Completed).await;
        assert_eq!(events.iter().filter(|e|matches!(&e.event,EventKind::QueuedMessageSent{request_id,..} if request_id==&queued)).count(),1);
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            1,
            "steering stays in the same native turn"
        );
        assert!(!root.path().join("traex-interrupted").exists());
        let original: serde_json::Value = serde_json::from_str(
            std::fs::read_to_string(root.path().join("traex-inputs"))
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        let steers = std::fs::read_to_string(root.path().join("traex-steers")).unwrap();
        assert_eq!(steers.lines().count(), 1);
        let steer: serde_json::Value =
            serde_json::from_str(steers.lines().next().unwrap()).unwrap();
        assert_eq!(original["pid"], steer["pid"]);
        let database =
            rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
        assert_eq!(
            database
                .query_row(
                    "SELECT status FROM message_queue WHERE request_id=?1",
                    [&queued],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "dispatched"
        );
    }
}

#[tokio::test]
async fn traex_approvals_questions_eof_and_failed_turns_keep_native_evidence() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    let other = session(&mut client, root.path()).await;
    send(&mut client, &id, "approval", "approval").await;
    let (_, events) = until(&mut client, &id, Status::Waiting).await;
    let approval = events
        .iter()
        .find_map(|e| {
            if let EventKind::Approval { request_id, .. } = &e.event {
                Some(request_id.clone())
            } else {
                None
            }
        })
        .unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: other,
                request_id: approval.clone(),
                allow: true
            }
        )
        .await,
        Response::Error { .. }
    ));
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: approval.clone(),
                allow: false
            }
        )
        .await,
        Response::Ok
    ));
    until(&mut client, &id, Status::Completed).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: approval,
                allow: true
            }
        )
        .await,
        Response::Error { .. }
    ));
    send(&mut client, &id, "approval-accept", "approval").await;
    let (_, events) = until(&mut client, &id, Status::Waiting).await;
    let approval = events
        .iter()
        .rev()
        .find_map(|e| match &e.event {
            EventKind::Approval { request_id, .. } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: approval,
                allow: true
            }
        )
        .await,
        Response::Ok
    ));
    let (_, events) = until(&mut client, &id, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text {text} if text == "APPROVED"))
    );
    send(&mut client, &id, "question", "question").await;
    let (_, events) = until(&mut client, &id, Status::Waiting).await;
    let question = events
        .iter()
        .find_map(|e| {
            if let EventKind::Question { request_id, .. } = &e.event {
                Some(request_id.clone())
            } else {
                None
            }
        })
        .unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::AnswerQuestion {
                session_id: id.clone(),
                request_id: question,
                answers: Some(vec![latte_work_protocol::QuestionAnswer {
                    question_id: "q".into(),
                    option_indices: vec![1],
                    text: None
                }])
            }
        )
        .await,
        Response::Ok
    ));
    let (_, events) = until(&mut client, &id, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event,EventKind::Text{text} if text.contains('B')))
    );
    send(&mut client, &id, "failed", "failed").await;
    until(&mut client, &id, Status::Failed).await;
    send(&mut client, &id, "eof", "eof").await;
    until(&mut client, &id, Status::Failed).await;
    let inputs = std::fs::read_to_string(root.path().join("traex-inputs")).unwrap();
    assert_eq!(inputs.lines().count(), 5);
    drop(client);
    let mut client = host.client().await;
    let Response::Session { session } = ask(
        &mut client,
        Request::Session {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(session.status, Status::Failed);
    assert_eq!(
        std::fs::read_to_string(root.path().join("traex-inputs")).unwrap(),
        inputs
    );
}

#[tokio::test]
async fn traex_queue_metadata_survives_restart_without_an_installed_cli() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "wait", "wait").await;
    until(&mut client, &id, Status::Running).await;
    send(&mut client, &id, "pending", "keep me").await;
    ask(
        &mut client,
        Request::Cancel {
            session_id: id.clone(),
        },
    )
    .await;
    drop(client);
    kill(Pid::from_raw(host.process.id() as i32), Signal::SIGINT).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while host.process.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    host.process = Command::new(env!("CARGO_BIN_EXE_latte-work-server"))
        .args(["serve", "--state-dir"])
        .arg(host.directory.path())
        .env("LATTE_WORK_AGENT_ENV", "inherit")
        .env(
            "LATTE_WORK_CLAUDE",
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude.py"),
        )
        .env("LATTE_WORK_TRAEX", root.path().join("not-installed"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !host.directory.path().join("control.sock").exists() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut client = host.client().await;
    let Response::Hello { agents, .. } =
        ask(&mut client, Request::Hello { version: VERSION }).await
    else {
        panic!()
    };
    assert!(!agents.iter().find(|a| a.id == "traex").unwrap().available);
    assert!(matches!(
        ask(
            &mut client,
            Request::ResumeMessageQueue {
                session_id: id.clone(),
                provider: Some(TurnProvider::Cli)
            }
        )
        .await,
        Response::Error { .. }
    ));
    let Response::MessageQueue { entries, .. } = ask(
        &mut client,
        Request::MessageQueue {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!()
    };
    assert_eq!(entries.len(), 1);
    assert!(matches!(
        ask(
            &mut client,
            Request::TakeQueuedMessage {
                session_id: id,
                request_id: entries[0].request_id.clone(),
                revision: entries[0].revision
            }
        )
        .await,
        Response::QueuedMessageTaken { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(root.path().join("traex-inputs"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[tokio::test]
async fn traex_provider_snapshots_drive_catalog_resume_redaction_and_cli_restoration() {
    use latte_work_protocol::{Provider, ProviderSnapshot};
    let host = Host::start().await;
    let mut client = host.client().await;
    let root = tempfile::tempdir().unwrap();
    let id = session(&mut client, root.path()).await;
    let mut native = None;
    for (index, protocol) in ["anthropic_messages", "openai_chat", "openai_responses"]
        .into_iter()
        .enumerate()
    {
        let metadata: Provider = serde_json::from_value(serde_json::json!({
            "id":"p","name":"Fixture","revision":index.to_string(),"protocol":protocol,
            "base_url":"http://localhost:8000/v1","model":"provider-model","models":["another-model"],
            "model_labels":{"provider-model":"Friendly"},"auth":"bearer","has_credential":true
        })).unwrap();
        let Response::Models {
            models,
            provider,
            effort_levels,
            model_labels,
            ..
        } = ask(
            &mut client,
            Request::ModelsForProvider {
                agent: "traex".into(),
                model: None,
                project_id: None,
                provider: Some(metadata.clone()),
            },
        )
        .await
        else {
            panic!("provider catalog")
        };
        assert_eq!(models, ["provider-model", "another-model"]);
        assert_eq!(provider.as_deref(), Some("Fixture"));
        assert!(effort_levels.is_empty());
        assert_eq!(model_labels["provider-model"], "Friendly");
        let snapshot = TurnProvider::Snapshot(Box::new(ProviderSnapshot {
            provider: metadata,
            credential: "traex-provider-test-secret".into(),
        }));
        let request = format!("provider-{index}");
        let send = |effort, provider| Request::SendQueued {
            session_id: id.clone(),
            request_id: request.clone(),
            text: "credential".into(),
            model: Some("another-model".into()),
            effort,
            permission_mode: None,
            provider: Some(provider),
        };
        assert!(matches!(
            ask(&mut client, send(Some(Effort::High), snapshot.clone())).await,
            Response::Error { .. }
        ));
        assert!(matches!(
            ask(&mut client, send(None, snapshot.clone())).await,
            Response::Accepted { .. }
        ));
        let (s, events) = until(&mut client, &id, Status::Completed).await;
        assert!(native.is_none() || native == s.native_id);
        native = s.native_id;
        assert!(
            events
                .iter()
                .any(|e| matches!(&e.event,EventKind::Text{text} if text.contains("[redacted]")))
        );
        assert!(
            !serde_json::to_string(&events)
                .unwrap()
                .contains("traex-provider-test-secret")
        );
        assert!(matches!(
            ask(&mut client, send(None, TurnProvider::Cli)).await,
            Response::Error { .. }
        ));
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: id.clone(),
                only_if_idle: Some(true),
            },
        )
        .await;
    }
    send(&mut client, &id, "back-to-cli", "hello").await;
    until(&mut client, &id, Status::Completed).await;
    let records = std::fs::read_to_string(root.path().join("traex-opens")).unwrap();
    let rows: Vec<serde_json::Value> = records
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(rows.len(), 4);
    for row in &rows[..3] {
        assert!(
            row["params"]["modelProvider"]
                .as_str()
                .unwrap()
                .starts_with("latte-work-")
        );
        assert_eq!(row["params"]["model"], "another-model");
    }
    assert_eq!(rows[3]["params"]["modelProvider"], "fixture-native");
    assert!(rows[3]["provider_config"].as_object().unwrap().is_empty());
    assert!(!records.contains("traex-provider-test-secret"));
}

#[tokio::test]
async fn traex_model_change_resumes_large_history_after_stop_without_replaying_it() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "waiting", "wait").await;
    until(&mut client, &id, Status::Running).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::Cancel {
                session_id: id.clone()
            }
        )
        .await,
        Response::Ok
    ));
    let (stopped, _) = until(&mut client, &id, Status::Stopped).await;
    std::fs::write(
        root.path().join("traex-resume-bytes"),
        (3 * 1024 * 1024).to_string(),
    )
    .unwrap();
    let response = ask(
        &mut client,
        Request::SendQueued {
            session_id: id.clone(),
            request_id: "new-model".into(),
            text: "new-model".into(),
            model: Some("gpt-test".into()),
            effort: Some(Effort::High),
            permission_mode: Some("default".into()),
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    assert!(!matches!(response, Response::Error { .. }), "{response:?}");
    ask(
        &mut client,
        Request::ResumeMessageQueue {
            session_id: id.clone(),
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    let (completed, events) = until(&mut client, &id, Status::Completed).await;
    assert_eq!(completed.native_id, stopped.native_id);
    assert_eq!(completed.model.as_deref(), Some("gpt-test"));
    assert!(
        events
            .iter()
            .any(|event| matches!(&event.event,EventKind::Text {text} if text=="TRAE:new-model"))
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("HISTORY_ONLY_MARKER")
    );
    let inputs = std::fs::read_to_string(root.path().join("traex-inputs")).unwrap();
    let inputs: Vec<serde_json::Value> = inputs
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(inputs.len(), 2);
    assert_ne!(inputs[0]["pid"], inputs[1]["pid"]);
    assert_eq!(inputs[1]["prompt"], "new-model");
    assert_eq!(inputs[1]["params"]["model"], "gpt-test");

    // Keep an explicit bound: over-limit recovery fails without starting the new prompt.
    std::fs::write(
        root.path().join("traex-resume-bytes"),
        (16 * 1024 * 1024 + 1).to_string(),
    )
    .unwrap();
    send(&mut client, &id, "oversized", "must-not-replay").await;
    let (failed, events) = until(&mut client, &id, Status::Failed).await;
    assert_eq!(failed.native_id, completed.native_id);
    assert!(events.iter().any(|event| matches!(&event.event, EventKind::State { status:Status::Failed,message:Some(message)} if message.contains("16 MiB") && message.contains("会话历史已保留"))));
    assert_eq!(
        std::fs::read_to_string(root.path().join("traex-inputs"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}
#[tokio::test]
async fn traex_model_variants_are_native_and_survive_close_resume_and_queue() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    let send_variant = |model: &str, effort, key: &str, text: &str| Request::SendQueued {
        session_id: id.clone(),
        request_id: key.into(),
        text: text.into(),
        model: Some(model.into()),
        effort: Some(effort),
        permission_mode: Some("default".into()),
        provider: Some(TurnProvider::Cli),
    };
    assert!(matches!(
        ask(
            &mut client,
            send_variant("backend-large", Effort::High, "invalid", "bad")
        )
        .await,
        Response::Error { .. }
    ));
    assert!(!root.path().join("traex-inputs").exists());
    for (model, effort, key) in [
        ("backend-large", Effort::Low, "max"),
        ("gpt-test", Effort::High, "standard"),
    ] {
        let response = ask(&mut client, send_variant(model, effort, key, key)).await;
        assert!(!matches!(response, Response::Error { .. }), "{response:?}");
        let (saved, _) = until(&mut client, &id, Status::Completed).await;
        assert_eq!(saved.model.as_deref(), Some(model));
        assert_eq!(saved.effort, Some(effort));
        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: id.clone(),
                    only_if_idle: Some(true)
                }
            )
            .await,
            Response::Ok
        ));
        assert!(matches!(
            ask(
                &mut client,
                Request::OpenAgentSession {
                    session_id: id.clone(),
                    provider: Some(TurnProvider::Cli)
                }
            )
            .await,
            Response::Ok
        ));
    }
    let response = ask(
        &mut client,
        send_variant("backend-large", Effort::Low, "wait-max", "wait"),
    )
    .await;
    assert!(!matches!(response, Response::Error { .. }), "{response:?}");
    until(&mut client, &id, Status::Running).await;
    assert!(matches!(
        ask(
            &mut client,
            send_variant("gpt-test", Effort::High, "queued-standard", "queued")
        )
        .await,
        Response::MessageQueued { .. }
    ));
    assert!(matches!(
        ask(
            &mut client,
            Request::Cancel {
                session_id: id.clone()
            }
        )
        .await,
        Response::Ok
    ));
    until(&mut client, &id, Status::Stopped).await;
    let response = ask(
        &mut client,
        Request::ResumeMessageQueue {
            session_id: id.clone(),
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    assert!(!matches!(response, Response::Error { .. }), "{response:?}");
    let (saved, _) = until(&mut client, &id, Status::Completed).await;
    assert_eq!(saved.model.as_deref(), Some("gpt-test"));
    let records: Vec<serde_json::Value> = std::fs::read_to_string(root.path().join("traex-inputs"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(records.len(), 4);
    for (entry, variant) in records.iter().zip(["max", "standard", "max", "standard"]) {
        assert_eq!(entry["params"]["model"], "gpt-test");
        assert_eq!(entry["params"]["modelBackendVariant"], variant);
    }
    let opens: Vec<serde_json::Value> = std::fs::read_to_string(root.path().join("traex-opens"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    for variant in ["max", "standard"] {
        assert!(opens.iter().any(|entry| entry["method"] == "thread/resume"
            && entry["params"]["config"]["model_backend_variant"] == variant));
    }
}

#[tokio::test]
async fn traex_platform_instructions_preserve_native_text_on_start_resume_and_disable() {
    use latte_work_protocol::SkillState;
    let home = tempfile::tempdir().unwrap();
    let host = Host::start_with_environment(&[("HOME", home.path().as_os_str())]).await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    for (request, text) in [("first", "first"), ("resumed", "resumed")] {
        send(&mut client, &id, request, text).await;
        until(&mut client, &id, Status::Completed).await;
        assert!(matches!(
            ask(
                &mut client,
                Request::CloseAgentSession {
                    session_id: id.clone(),
                    only_if_idle: Some(true)
                }
            )
            .await,
            Response::Ok
        ));
    }
    let opens: Vec<serde_json::Value> = std::fs::read_to_string(root.path().join("traex-opens"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(opens.iter().any(|v| v["method"] == "thread/start"));
    assert!(opens.iter().any(|v| v["method"] == "thread/resume"));
    for open in &opens {
        let instructions = open["params"]["developerInstructions"].as_str().unwrap();
        assert!(instructions.starts_with("FIXTURE_NATIVE_DEVELOPER_INSTRUCTIONS\n\nLatte Work"));
        assert!(!instructions.contains("description:"));
    }
    assert!(matches!(
        ask(
            &mut client,
            Request::SetSkillState {
                project_id: None,
                id: "platform:latte-work-context".into(),
                state: SkillState::Disabled,
                expected_state: SkillState::Enabled
            }
        )
        .await,
        Response::Skills { .. }
    ));
    send(&mut client, &id, "disabled", "disabled").await;
    until(&mut client, &id, Status::Completed).await;
    let last: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(root.path().join("traex-opens"))
            .unwrap()
            .lines()
            .last()
            .unwrap(),
    )
    .unwrap();
    assert!(last["params"].get("developerInstructions").is_none());
    assert!(
        !home
            .path()
            .join(".agents/skills/latte-work-context")
            .exists()
    );
}
