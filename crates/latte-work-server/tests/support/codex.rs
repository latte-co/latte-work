use super::*;
use latte_work_protocol::{Effort, TurnProvider};

#[tokio::test]
async fn codex_provider_boundary_rejects_unsupported_protocols_and_redacts_credentials() {
    use latte_work_protocol::{Provider, ProviderSnapshot};
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    let provider: Provider = serde_json::from_value(serde_json::json!({"id":"codex-fixture","name":"Fixture","protocol":"openai_responses","base_url":"http://localhost:8000/v1","model":"custom-codex","auth":"bearer","has_credential":true})).unwrap();
    for protocol in ["anthropic_messages", "openai_chat"] {
        let mut incompatible = serde_json::to_value(&provider).unwrap();
        incompatible["protocol"] = protocol.into();
        assert!(matches!(
            ask(
                &mut client,
                Request::ModelsForProvider {
                    agent: "codex".into(),
                    model: None,
                    project_id: None,
                    provider: Some(serde_json::from_value(incompatible).unwrap())
                }
            )
            .await,
            Response::Error { .. }
        ));
    }
    assert!(!root.path().join("codex-opens").exists());
    let turn = |effort| Request::SendQueued {
        session_id: id.clone(),
        request_id: "provider".into(),
        text: "credential".into(),
        model: None,
        effort,
        permission_mode: Some("default".into()),
        provider: Some(TurnProvider::Snapshot(Box::new(ProviderSnapshot {
            provider: provider.clone(),
            credential: "codex-fixture-private-credential".into(),
        }))),
    };
    assert!(matches!(
        ask(&mut client, turn(Some(Effort::High))).await,
        Response::Error { .. }
    ));
    assert!(matches!(
        ask(&mut client, turn(None)).await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text.contains("[redacted]")))
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("codex-fixture-private-credential")
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
    send(&mut client, &id, "native", "native").await;
    wait(&mut client, &id, Status::Completed).await;
    let opens = std::fs::read_to_string(root.path().join("codex-opens")).unwrap();
    let restored: serde_json::Value = serde_json::from_str(opens.lines().last().unwrap()).unwrap();
    assert_eq!(restored["params"]["modelProvider"], "openai");
    assert_eq!(restored["params"]["model"], "codex-test");
    assert_eq!(restored["method"], "thread/resume");
}

async fn session(client: &mut Client, path: &Path) -> String {
    let Response::Project { project } = ask(
        client,
        Request::AddProject {
            path: path.to_string_lossy().into_owned(),
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
            agent: "codex".into(),
        },
    )
    .await
    else {
        panic!("session")
    };
    session.id
}
async fn send(client: &mut Client, id: &str, request: &str, text: &str) -> Response {
    let result = ask(
        client,
        Request::SendQueued {
            session_id: id.into(),
            request_id: request.into(),
            text: text.into(),
            model: Some("codex-test".into()),
            effort: Some(Effort::High),
            permission_mode: Some("default".into()),
            provider: Some(TurnProvider::Cli),
        },
    )
    .await;
    assert!(!matches!(result, Response::Error { .. }), "{result:?}");
    result
}
async fn ready(client: &mut Client, id: &str) -> latte_work_protocol::Session {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Response::Session { session } = ask(
            client,
            Request::Session {
                session_id: id.into(),
            },
        )
        .await
        else {
            panic!("session")
        };
        if session.agent_session_open == Some(true) {
            return session;
        }
        assert!(Instant::now() < deadline, "native open: {session:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn codex_catalog_prompt_free_open_stream_resume_and_reconnect_preserve_identity() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let Response::Hello { agents, .. } =
        ask(&mut client, Request::Hello { version: VERSION }).await
    else {
        panic!("hello")
    };
    let codex = agents.iter().find(|a| a.id == "codex").unwrap();
    assert!(codex.available);
    assert_eq!(
        codex.provider_protocols,
        [latte_work_protocol::ProviderProtocol::OpenaiResponses]
    );
    assert!(
        matches!(ask(&mut client, Request::Models { agent: "codex".into(), model: Some("codex-test".into()), project_id: None }).await,
        Response::Models { models, effort_levels, model_labels, .. } if models == ["codex-test"] && effort_levels == [Effort::Low, Effort::High] && model_labels["codex-test"] == "Codex Test")
    );
    assert!(
        matches!(ask(&mut client, Request::AgentPermissions { agent: "codex".into() }).await, Response::AgentPermissions { modes } if modes.len() == 2 && modes[1].elevated)
    );
    let id = session(&mut client, root.path()).await;
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
    assert!(ready(&mut client, &id).await.native_id.is_none());
    assert!(!root.path().join("codex-inputs").exists());
    assert!(
        matches!(ask(&mut client, Request::Poll { session_id: id.clone(), after: 0.0 }).await, Response::Events { events, .. } if events.is_empty())
    );
    send(&mut client, &id, "one", "first").await;
    let events = wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(&e.event, EventKind::Text { text } if text == "CODEX:first"))
            .count(),
        1
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("DO_NOT_PERSIST_REASONING")
    );
    assert!(events.iter().any(|e| matches!(
        &e.event,
        EventKind::ToolResult {
            is_error: false,
            ..
        }
    )));
    drop(client);
    let mut client = host.client().await;
    assert!(matches!(
        send(&mut client, &id, "one", "first").await,
        Response::Accepted { duplicate: true }
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
    assert_eq!(
        ready(&mut client, &id).await.native_id.as_deref(),
        Some("codex-native-thread")
    );
    send(&mut client, &id, "two", "second").await;
    wait(&mut client, &id, Status::Completed).await;
    let inputs = std::fs::read_to_string(root.path().join("codex-inputs")).unwrap();
    assert_eq!(inputs.lines().count(), 2);
    let opens = std::fs::read_to_string(root.path().join("codex-opens")).unwrap();
    assert!(opens.contains("thread/resume"));
    assert!(opens.contains("NATIVE_CODEX_INSTRUCTIONS\\n\\nLatte Work"));
}

#[tokio::test]
async fn codex_approval_is_single_use_session_bound_and_questions_are_separate() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    let other = session(&mut client, root.path()).await;
    for allow in [false, true] {
        send(
            &mut client,
            &id,
            if allow { "allow" } else { "deny" },
            "approval",
        )
        .await;
        let events = wait(&mut client, &id, Status::Waiting).await;
        let request_id = events
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
                    session_id: other.clone(),
                    request_id: request_id.clone(),
                    allow
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
                    request_id: request_id.clone(),
                    allow
                }
            )
            .await,
            Response::Ok
        ));
        let events = wait(&mut client, &id, Status::Completed).await;
        assert!(events.iter().any(|e| matches!(&e.event, EventKind::Text { text } if text == if allow { "APPROVED" } else { "DENIED" })));
        assert!(matches!(
            ask(
                &mut client,
                Request::Approve {
                    session_id: id.clone(),
                    request_id,
                    allow
                }
            )
            .await,
            Response::Error { .. }
        ));
    }
    send(&mut client, &id, "question", "question").await;
    let events = wait(&mut client, &id, Status::Waiting).await;
    let request_id = events
        .iter()
        .rev()
        .find_map(|e| match &e.event {
            EventKind::Question { request_id, .. } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::AnswerQuestion {
                session_id: id.clone(),
                request_id,
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
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::Text { text } if text.contains("ANSWER:") && text.contains('B'))));
}

#[tokio::test]
async fn codex_steering_stop_failures_and_eof_do_not_replay_input() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "wait", "wait").await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Response::Events { events, .. } = ask(
            &mut client,
            Request::Poll {
                session_id: id.clone(),
                after: 0.0,
            },
        )
        .await
        else {
            panic!()
        };
        if events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text == "WAITING"))
        {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(matches!(
        send(&mut client, &id, "steer", "supplement").await,
        Response::MessageQueued { .. }
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
    let entry = entries.iter().find(|e| e.request_id == "steer").unwrap();
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
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text == "STEER:supplement"))
    );
    send(&mut client, &id, "stop", "wait").await;
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
    wait(&mut client, &id, Status::Stopped).await;
    for prompt in ["failed", "eof"] {
        send(&mut client, &id, prompt, prompt).await;
        wait(&mut client, &id, Status::Failed).await;
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("codex-inputs"))
            .unwrap()
            .lines()
            .count(),
        4
    );
}

#[tokio::test]
async fn codex_interrupted_subagent_tool_is_stopped_not_failed() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    send(&mut client, &id, "subtask", "subtask").await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Response::Events { events, .. } = ask(
            &mut client,
            Request::Poll {
                session_id: id.clone(),
                after: 0.0,
            },
        )
        .await
        else {
            panic!()
        };
        if events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text == "SUBTASK_RUNNING"))
        {
            break;
        }
        assert!(Instant::now() < deadline, "subtask did not start");
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
    let events = wait(&mut client, &id, Status::Stopped).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::ToolResult { is_error: true, .. })),
        "interrupted sub-agent tool must be reported as an error result"
    );
}
