use super::*;

async fn create(client: &mut Client, root: &Path, agent: &str) -> String {
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
            agent: agent.into(),
        },
    )
    .await
    else {
        panic!("session")
    };
    session.id
}

async fn title(client: &mut Client, id: &str, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let current = ask(
            client,
            Request::Session {
                session_id: id.into(),
            },
        )
        .await;
        if matches!(&current, Response::Session { session } if session.title == expected && session.status == Status::Completed)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "title did not arrive: {current:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn codex_generated_title_process_uses_the_owning_environment() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = create(&mut client, root.path(), "codex").await;
    let environment = std::collections::BTreeMap::from([(
        "HTTP_PROXY".into(),
        "http://title-proxy.test:7890".into(),
    )]);
    std::fs::write(
        root.path().join("title-environment.json"),
        serde_json::to_vec(&environment).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::Send {
                session_id: id.clone(),
                request_id: "title-environment".into(),
                text: "native-auto-title".into(),
                model: None,
                effort: None,
                permission_mode: None,
                provider: Some(latte_work_protocol::TurnProvider::Configured {
                    provider: None,
                    environment: latte_work_protocol::AgentEnvironment(environment)
                }),
            }
        )
        .await,
        Response::Accepted { .. }
    ));
    title(&mut client, &id, "修复附件拖入失败").await;
}

#[tokio::test]
async fn automatic_titles_all_agents_persist_without_extra_turns_or_resume_generation() {
    for agent in ["claude", "traex", "codex"] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = create(&mut client, root.path(), agent).await;
        assert!(matches!(
            send(&mut client, &id, "first", "native-auto-title").await,
            Response::Accepted { .. }
        ));
        wait(&mut client, &id, Status::Completed).await;
        let expected = if agent == "claude" {
            "Friendly generated title"
        } else {
            "修复附件拖入失败"
        };
        title(&mut client, &id, expected).await;
        let Response::Events {
            session, events, ..
        } = ask(
            &mut client,
            Request::Poll {
                session_id: id.clone(),
                after: 0.0,
            },
        )
        .await
        else {
            panic!("poll")
        };
        assert!(!session.custom_title);
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            1
        );
        assert!(!events.iter().any(
            |e| matches!(&e.event, EventKind::Text { text } if text.contains("修复附件拖入失败"))
        ));
        let path = root.path().join(match agent {
            "claude" => "fixture-title-requests",
            "codex" => "codex-title-inputs",
            _ => "traex-title-inputs",
        });
        let requests = std::fs::read_to_string(&path).unwrap();
        assert_eq!(requests.lines().count(), 1);
        if agent == "codex" {
            let value: serde_json::Value = serde_json::from_str(&requests).unwrap();
            let context = value["description"].as_str().unwrap();
            assert!(context.starts_with("native-auto-title\n\nAssistant reply:\n"));
            assert!(context.len() > "native-auto-title\n\nAssistant reply:\n".len());
        } else if agent == "claude" {
            let context =
                std::fs::read_to_string(root.path().join("fixture-title-context")).unwrap();
            assert!(context.contains("Assistant reply:\n"));
        }
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
        let mut reconnect = host.client().await;
        title(&mut reconnect, &id, expected).await;
        send(&mut reconnect, &id, "followup", "followup").await;
        let events = wait(&mut reconnect, &id, Status::Completed).await;
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            2
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), requests);
        title(&mut reconnect, &id, expected).await;
    }
}

#[tokio::test]
async fn automatic_titles_app_servers_do_not_block_input_or_overwrite_manual_names() {
    for agent in ["codex", "traex"] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = create(&mut client, root.path(), agent).await;
        send(&mut client, &id, "first", "native-auto-title-held").await;
        wait(&mut client, &id, Status::Completed).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.path().join(format!("{agent}-title-inputs")).exists() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(matches!(
            send(&mut client, &id, "second", "followup").await,
            Response::Accepted { .. }
        ));
        wait(&mut client, &id, Status::Completed).await;
        assert!(
            matches!(ask(&mut client, Request::RenameSession { provider: None, session_id: id.clone(), title: "My name".into() }).await, Response::Session { session } if session.custom_title)
        );
        if agent == "codex" {
            let input: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(root.path().join("codex-title-inputs")).unwrap(),
            )
            .unwrap();
            gone(input["pid"].as_i64().unwrap() as i32).await;
        } else {
            std::fs::write(root.path().join("title-release"), "release").unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !root.path().join("title-response").exists() {
                assert!(
                    Instant::now() < deadline,
                    "{agent}: {:?}",
                    ask(
                        &mut client,
                        Request::Poll {
                            session_id: id.clone(),
                            after: 0.0
                        }
                    )
                    .await
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        title(&mut client, &id, "My name").await;
        let events = wait(&mut client, &id, Status::Completed).await;
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            2
        );
    }
}

async fn gone(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while nix::sys::signal::kill(Pid::from_raw(pid), None).is_ok() {
        assert!(Instant::now() < deadline, "title worker {pid} still alive");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn manual_names_release_both_title_permits_for_the_next_session() {
    let host = Host::start().await;
    let roots = [
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    ];
    let mut client = host.client().await;
    let mut held = Vec::new();
    for root in &roots[..2] {
        let id = create(&mut client, root.path(), "codex").await;
        send(
            &mut client,
            &id,
            &format!("held-{id}"),
            "native-auto-title-held",
        )
        .await;
        wait(&mut client, &id, Status::Completed).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        let record = root.path().join("codex-title-inputs");
        while !record.exists() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let input: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(record).unwrap()).unwrap();
        held.push((id, input["pid"].as_i64().unwrap() as i32));
    }
    for (id, pid) in &held {
        assert!(
            matches!(ask(&mut client, Request::RenameSession { provider: None, session_id: id.clone(), title: "Manual".into() }).await, Response::Session { session } if session.custom_title)
        );
        gone(*pid).await;
    }
    let id = create(&mut client, roots[2].path(), "codex").await;
    send(&mut client, &id, "next", "native-auto-title").await;
    title(&mut client, &id, "修复附件拖入失败").await;
}

#[tokio::test]
async fn codex_titles_pin_native_provider_and_forward_selected_effort() {
    use latte_work_protocol::{Effort, TurnProvider};
    let host = Host::start().await;
    let mut client = host.client().await;
    for prompt in [
        "native-provider-selection-drift",
        "native-provider-endpoint-drift",
        "native-provider-openai-base-url-drift",
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut config = serde_json::json!({
            "model_provider":"first", "model":"codex-test", "model_reasoning_effort":"high",
            "developer_instructions":"NATIVE_CODEX_INSTRUCTIONS",
            "model_providers":{"first":{"name":"First","base_url":"http://localhost:8000/v1"},"second":{"name":"Second","base_url":"http://localhost:9000/v1"}},
            "notify":["side-effect"], "features":{"stable_environment_tools":true,"sleep_tool":{"enabled":true,"mode":"always_on"}}
        });
        if prompt == "native-provider-openai-base-url-drift" {
            config["model_provider"] = serde_json::json!("openai");
            config["openai_base_url"] = serde_json::json!("http://localhost:8000/v1");
            config.as_object_mut().unwrap().remove("model_providers");
        }
        std::fs::write(
            root.path().join("codex-native-config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let id = create(&mut client, root.path(), "codex").await;
        assert!(matches!(
            ask(
                &mut client,
                Request::SendQueued {
                    session_id: id.clone(),
                    request_id: format!("first-{prompt}"),
                    text: prompt.into(),
                    model: Some("codex-test".into()),
                    effort: Some(Effort::Low),
                    permission_mode: None,
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Accepted { .. }
        ));
        wait(&mut client, &id, Status::Completed).await;
        let main: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("codex-inputs")).unwrap(),
        )
        .unwrap();
        assert_eq!(main["params"]["effort"], "low");
        if prompt.ends_with("selection-drift") {
            title(&mut client, &id, "修复附件拖入失败").await;
            let input: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(root.path().join("codex-title-inputs")).unwrap(),
            )
            .unwrap();
            assert_eq!(input["provider"], "first");
            assert_eq!(input["effort"], "low");
        } else {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let events = wait(&mut client, &id, Status::Completed).await;
                if events.iter().any(|e| matches!(&e.event, EventKind::Notice { text } if text.contains("Provider 配置已变化"))) { break; }
                assert!(Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(!root.path().join("codex-title-inputs").exists());
            title(&mut client, &id, prompt).await;
        }
    }
}

#[tokio::test]
async fn native_title_refresh_preserves_redaction_before_callback_and_after_reopen() {
    use latte_work_protocol::{ProviderSnapshot, TurnProvider};
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = create(&mut client, root.path(), "claude").await;
    let snapshot: ProviderSnapshot = serde_json::from_value(serde_json::json!({"provider":{"id":"fixture","name":"Fixture","protocol":"anthropic_messages","base_url":"http://localhost:8000","model":"sonnet","auth":"bearer","has_credential":true},"credential":"fixture-title-private-key"})).unwrap();
    ask(
        &mut client,
        Request::SendQueued {
            session_id: id.clone(),
            request_id: "first".into(),
            text: "native-auto-title-credential".into(),
            model: None,
            effort: None,
            permission_mode: None,
            provider: Some(TurnProvider::Snapshot(Box::new(snapshot))),
        },
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.path().join("fixture-title-raw").exists() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!root.path().join("fixture-title-response").exists());
    // Expire the shared refresh debounce while the callback is fenced out.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let response = ask(
            &mut client,
            Request::Poll {
                session_id: id.clone(),
                after: 0.0,
            },
        )
        .await;
        assert!(
            !serde_json::to_string(&response)
                .unwrap()
                .contains("fixture-title-private-key")
        );
        if matches!(response, Response::Events { session, .. } if session.title == "Fix [redacted]" && session.status == Status::Completed)
        {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    std::fs::write(root.path().join("title-callback-release"), "release").unwrap();
    title(&mut client, &id, "Fix [redacted]").await;
    ask(
        &mut client,
        Request::CloseAgentSession {
            session_id: id.clone(),
            only_if_idle: Some(true),
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let mut reconnect = host.client().await;
    title(&mut reconnect, &id, "Fix [redacted]").await;
    send(&mut reconnect, &id, "resume", "followup").await;
    title(&mut reconnect, &id, "Fix [redacted]").await;
    let connection =
        rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    for table in ["sessions", "events"] {
        let data: String = connection
            .query_row(
                &format!("SELECT group_concat(data) FROM {table}"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!data.contains("fixture-title-private-key"));
    }
}

#[tokio::test]
async fn automatic_titles_app_servers_fail_without_failing_or_replaying_the_turn() {
    for agent in ["codex", "traex"] {
        for prompt in ["native-auto-title-failed", "native-auto-title-empty"] {
            let host = Host::start().await;
            let root = tempfile::tempdir().unwrap();
            let mut client = host.client().await;
            let id = create(&mut client, root.path(), agent).await;
            send(&mut client, &id, "first", prompt).await;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let events = wait(&mut client, &id, Status::Completed).await;
                if events.iter().any(
                    |e| matches!(&e.event, EventKind::Notice { text } if text.contains("自动命名")),
                ) {
                    break;
                }
                assert!(Instant::now() < deadline, "missing title failure notice");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            title(&mut client, &id, prompt).await;
            send(&mut client, &id, "second", "followup").await;
            let events = wait(&mut client, &id, Status::Completed).await;
            assert_eq!(
                events
                    .iter()
                    .filter(|e| matches!(e.event, EventKind::User { .. }))
                    .count(),
                2
            );
            assert_eq!(
                std::fs::read_to_string(root.path().join(format!("{agent}-title-inputs")))
                    .unwrap()
                    .lines()
                    .count(),
                1
            );
        }
    }
}

#[tokio::test]
async fn codex_title_handles_early_completion_and_close_cancels_pending_generation() {
    for prompt in ["native-auto-title-early", "native-auto-title-held"] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = create(&mut client, root.path(), "codex").await;
        send(&mut client, &id, "first", prompt).await;
        wait(&mut client, &id, Status::Completed).await;
        if prompt.ends_with("early") {
            title(&mut client, &id, "修复附件拖入失败").await;
            continue;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.path().join("codex-title-inputs").exists() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("codex-title-inputs")).unwrap(),
        )
        .unwrap();
        let pid = value["pid"].as_i64().unwrap() as i32;
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
        while nix::sys::signal::kill(Pid::from_raw(pid), None).is_ok() {
            assert!(
                Instant::now() < deadline,
                "title worker still alive after close"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        title(&mut client, &id, prompt).await;
    }
}

/// Stop the host process; the state directory stays intact for inspection.
async fn stop(host: &mut Host) {
    host.process.kill().unwrap();
    host.process.wait().unwrap();
}

/// Relaunch the host against the same state directory; the fixture env mirrors
/// `environment_e2e`'s restart pattern.
async fn relaunch(host: &mut Host) {
    host.process = Command::new(env!("CARGO_BIN_EXE_latte-work-server"))
        .args(["serve", "--state-dir"])
        .arg(host.directory.path())
        .env("LATTE_WORK_AGENT_ENV", "inherit")
        .env(
            "LATTE_WORK_CLAUDE",
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude.py"),
        )
        .env(
            "CLAUDE_CONFIG_DIR",
            host.directory.path().join("claude-config"),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !host.directory.path().join("control.sock").exists() {
        assert!(Instant::now() < deadline, "server readiness timeout");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn title_requests_persist_across_server_restart_without_regeneration() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = create(&mut client, root.path(), "claude").await;
    send(&mut client, &id, "first", "native-auto-title").await;
    wait(&mut client, &id, Status::Completed).await;
    title(&mut client, &id, "Friendly generated title").await;
    let requests = root.path().join("fixture-title-requests");
    let recorded = std::fs::read_to_string(&requests).unwrap();
    assert_eq!(recorded.lines().count(), 1);
    stop(&mut host).await;
    relaunch(&mut host).await;
    let mut reconnect = host.client().await;
    title(&mut reconnect, &id, "Friendly generated title").await;
    send(&mut reconnect, &id, "followup", "native-auto-title").await;
    let events = wait(&mut reconnect, &id, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text.starts_with("resumed:"))),
        "the followup must run on a resumed native session"
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e.event, EventKind::User { .. }))
            .count(),
        2
    );
    assert_eq!(
        std::fs::read_to_string(&requests).unwrap(),
        recorded,
        "a recorded request must never re-fire after a restart"
    );
    title(&mut reconnect, &id, "Friendly generated title").await;
}

#[tokio::test]
async fn legacy_sessions_without_the_flag_self_heal_exactly_once() {
    let mut host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = create(&mut client, root.path(), "claude").await;
    send(&mut client, &id, "first", "native-auto-title").await;
    wait(&mut client, &id, Status::Completed).await;
    title(&mut client, &id, "Friendly generated title").await;
    let requests = root.path().join("fixture-title-requests");
    assert_eq!(
        std::fs::read_to_string(&requests).unwrap().lines().count(),
        1
    );
    // Downgrade the row to its pre-marker shape: prefix title, no flag.
    stop(&mut host).await;
    let connection =
        rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    let data: String = connection
        .query_row("SELECT data FROM sessions WHERE id=?1", [&id], |row| {
            row.get(0)
        })
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&data).unwrap();
    value["title_requested"] = serde_json::json!(false);
    value["title"] = serde_json::json!("native-auto-title");
    let updated = serde_json::to_string(&value).unwrap();
    connection
        .execute(
            "UPDATE sessions SET data=?2 WHERE id=?1",
            rusqlite::params![id, updated],
        )
        .unwrap();
    drop(connection);
    relaunch(&mut host).await;
    let mut reconnect = host.client().await;
    let Response::Session { session } = ask(
        &mut reconnect,
        Request::Session {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!("downgraded session")
    };
    assert!(
        !session.title_requested,
        "downgraded row must surface on the wire (title={:?})",
        session.title
    );
    send(&mut reconnect, &id, "followup", "native-auto-title").await;
    wait(&mut reconnect, &id, Status::Completed).await;
    title(&mut reconnect, &id, "Friendly generated title").await;
    assert_eq!(
        std::fs::read_to_string(&requests).unwrap().lines().count(),
        2,
        "the legacy session self-heals with exactly one more request"
    );
    send(&mut reconnect, &id, "third", "native-auto-title").await;
    wait(&mut reconnect, &id, Status::Completed).await;
    assert_eq!(
        std::fs::read_to_string(&requests).unwrap().lines().count(),
        2,
        "after healing, later turns stay inert"
    );
}
