use super::*;
use latte_work_client::request_with_app_agent_config;
use latte_work_config::ProviderStore;
use latte_work_protocol::AgentEnvironment;
use std::collections::BTreeMap;
use tokio::sync::Mutex;

fn text_content(events: &[latte_work_protocol::Event]) -> String {
    events
        .iter()
        .filter_map(|e| match &e.event {
            EventKind::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn stored_content(host: &Host, table: &str, id: &str) -> Vec<EventKind> {
    assert!(matches!(table, "events" | "subagent_history"));
    let database = rusqlite::Connection::open_with_flags(
        host.directory.path().join("state.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    database
        .prepare(&format!(
            "SELECT data FROM {table} WHERE session_id=?1 ORDER BY seq"
        ))
        .unwrap()
        .query_map([id], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
        .collect()
}

#[tokio::test]
async fn closed_environment_session_rename_uses_verified_directory_without_default_fallback() {
    for duplicate in [false, true] {
        let host = Host::start().await;
        let project = tempfile::tempdir().unwrap();
        let native = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let environment = AgentEnvironment(BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            native.path().to_string_lossy().into_owned(),
        )]));
        ProviderStore::open(app.path(), None)
            .unwrap()
            .save_environment("target", "claude", environment.clone())
            .unwrap();
        let mut client = host.client().await;
        let id = session(&mut client, project.path()).await;
        assert!(matches!(
            ask(
                &mut client,
                Request::Send {
                    session_id: id.clone(),
                    request_id: "original-context".into(),
                    text: "native-title".into(),
                    model: None,
                    effort: None,
                    permission_mode: None,
                    provider: Some(latte_work_protocol::TurnProvider::Configured {
                        provider: None,
                        environment
                    }),
                }
            )
            .await,
            Response::Accepted { .. }
        ));
        wait(&mut client, &id, Status::Completed).await;
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
        let folder: String = project
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect();
        let relative = PathBuf::from("projects")
            .join(folder)
            .join("11111111-1111-4111-8111-111111111111.jsonl");
        let original = native.path().join(&relative);
        let default = host.directory.path().join("claude-config").join(&relative);
        let before = std::fs::read(&original).unwrap();
        if duplicate {
            std::fs::create_dir_all(default.parent().unwrap()).unwrap();
            std::fs::write(&default, &before).unwrap();
        }
        let rename = || Request::RenameSession {
            session_id: id.clone(),
            title: "Closed configured title".into(),
            provider: None,
        };
        // Omitted and changed snapshots cannot write a same-UUID default copy.
        assert!(matches!(
            ask(&mut client, rename()).await,
            Response::Error { .. }
        ));
        let target = Mutex::new(client);
        let app_path = app.path();
        let resolve = |agent: String| async move {
            ProviderStore::open(app_path, None)?.launch_for_host("target", &agent)
        };
        ProviderStore::open(app.path(), None)
            .unwrap()
            .save_environment(
                "target",
                "claude",
                AgentEnvironment(BTreeMap::from([(
                    "CLAUDE_CONFIG_DIR".into(),
                    host.directory
                        .path()
                        .join("claude-config")
                        .to_string_lossy()
                        .into_owned(),
                )])),
            )
            .unwrap();
        assert!(matches!(
            request_with_app_agent_config(&target, rename(), resolve)
                .await
                .unwrap(),
            Response::Error { .. }
        ));
        assert_eq!(std::fs::read(&original).unwrap(), before);
        if duplicate {
            assert_eq!(std::fs::read(&default).unwrap(), before);
        } else {
            assert!(!default.exists());
        }
        ProviderStore::open(app.path(), None)
            .unwrap()
            .save_environment(
                "target",
                "claude",
                AgentEnvironment(BTreeMap::from([(
                    "CLAUDE_CONFIG_DIR".into(),
                    native.path().to_string_lossy().into_owned(),
                )])),
            )
            .unwrap();
        assert!(
            matches!(request_with_app_agent_config(&target, rename(), resolve).await.unwrap(), Response::Session { session } if session.title == "Closed configured title" && session.custom_title && session.agent_session_open == Some(false))
        );
        assert!(
            std::fs::read_to_string(&original)
                .unwrap()
                .contains("Closed configured title")
        );
        if duplicate {
            assert_eq!(std::fs::read(&default).unwrap(), before);
        } else {
            assert!(!default.exists());
        }
    }
}

#[tokio::test]
async fn native_environment_history_and_titles_remain_redacted_after_restart() {
    let mut host = Host::start().await;
    let mut client = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let native = tempfile::tempdir().unwrap();
    let id = session(&mut client, project.path()).await;
    let secret = "fixture-environment-secret";
    let provider = latte_work_protocol::TurnProvider::Configured {
        provider: None,
        environment: AgentEnvironment(BTreeMap::from([
            ("LATTE_TEST_SECRET".into(), secret.into()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                native.path().to_string_lossy().into(),
            ),
        ])),
    };
    assert!(matches!(
        ask(
            &mut client,
            Request::Send {
                session_id: id.clone(),
                request_id: "native-secrets".into(),
                text: "custom-environment-native".into(),
                model: None,
                effort: None,
                permission_mode: None,
                provider: Some(provider.clone()),
            }
        )
        .await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Completed).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Response::Session { session } = ask(
            &mut client,
            Request::Session {
                session_id: id.clone(),
            },
        )
        .await
        else {
            panic!("session")
        };
        assert!(!session.title.contains(secret));
        if session.title == "Native [redacted] title" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "configured native title was not refreshed"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let Response::Subagents { tasks, .. } = ask(
        &mut client,
        Request::Subagents {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!("children")
    };
    let task = &tasks[0];
    let request = Request::SubagentHistory {
        session_id: id.clone(),
        task_id: task.id.clone(),
        after: None,
        source: None,
        provider: Some(provider),
    };
    let Response::SubagentHistory { events, source, .. } = ask(&mut client, request.clone()).await
    else {
        panic!("native history")
    };
    assert_eq!(source, "native");
    let expected = text_content(&events);
    assert!(expected.starts_with("native before [redacted]"));
    assert!(expected.ends_with(" native after"));
    assert!(!expected.contains(secret));
    let transcript = Request::SubagentTranscript {
        session_id: id.clone(),
        task_id: task.id.clone(),
    };
    let Response::SubagentTranscript { events, .. } = ask(&mut client, transcript.clone()).await
    else {
        panic!("native snapshot")
    };
    assert_eq!(text_content(&events), expected);
    let stored_text: String = stored_content(&host, "subagent_history", &id)
        .into_iter()
        .filter_map(|event| match event {
            EventKind::Text { text } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(stored_text, expected);
    ask(
        &mut client,
        Request::CloseAgentSession {
            session_id: id.clone(),
            only_if_idle: None,
        },
    )
    .await;
    drop(client);
    // An unknown context must not adopt the host directory's title after restart.
    let folder: String = project
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let host_title = host
        .directory
        .path()
        .join("claude-config/projects")
        .join(folder)
        .join("11111111-1111-4111-8111-111111111111.jsonl");
    std::fs::create_dir_all(host_title.parent().unwrap()).unwrap();
    std::fs::write(
        host_title,
        format!(
            "{}\n",
            serde_json::json!({"type":"ai-title","aiTitle":format!("Unsafe {secret} title")})
        ),
    )
    .unwrap();
    host.process.kill().unwrap();
    host.process.wait().unwrap();
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
    let mut client = host.client().await;
    let Response::Session { session } = ask(
        &mut client,
        Request::Session {
            session_id: id.clone(),
        },
    )
    .await
    else {
        panic!("restored session")
    };
    assert_eq!(session.title, "Native [redacted] title");
    assert_eq!(session.agent_session_open, Some(false));
    let Response::SubagentHistory { events, source, .. } = ask(&mut client, request).await else {
        panic!("native replay")
    };
    assert_eq!(source, "native");
    assert_eq!(text_content(&events), expected);
    let Response::SubagentTranscript { events, .. } = ask(&mut client, transcript).await else {
        panic!("snapshot replay")
    };
    assert_eq!(text_content(&events), expected);
    let database = rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    let saved: String = database
        .query_row("SELECT data FROM sessions WHERE id=?1", [&id], |r| r.get(0))
        .unwrap();
    assert!(!saved.contains(secret));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&saved).unwrap()["title"],
        "Native [redacted] title"
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM requests WHERE session_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn short_environment_values_preserve_confirmed_stream_reports_without_exposing_receipts() {
    let host = Host::start().await;
    let mut client = host.client().await;
    for token in ["success", "true"] {
        for failed in [false, true] {
            let project = tempfile::tempdir().unwrap();
            let id = session(&mut client, project.path()).await;
            let provider = latte_work_protocol::TurnProvider::Configured {
                provider: None,
                environment: AgentEnvironment(BTreeMap::from([
                    ("TOKEN".into(), token.into()),
                    (
                        "LATTE_TEST_SECRET".into(),
                        "fixture-environment-secret".into(),
                    ),
                ])),
            };
            ask(
                &mut client,
                Request::Send {
                    session_id: id.clone(),
                    request_id: format!("handback-{token}-{failed}"),
                    text: if failed {
                        "custom-environment-handback-failed"
                    } else {
                        "custom-environment-handback"
                    }
                    .into(),
                    model: None,
                    effort: None,
                    permission_mode: None,
                    provider: Some(provider.clone()),
                },
            )
            .await;
            wait(&mut client, &id, Status::Completed).await;
            let Response::Subagents { tasks, .. } = ask(
                &mut client,
                Request::Subagents {
                    session_id: id.clone(),
                },
            )
            .await
            else {
                panic!("children")
            };
            let request = Request::SubagentHistory {
                session_id: id.clone(),
                task_id: tasks[0].id.clone(),
                after: None,
                source: None,
                provider: Some(provider),
            };
            let Response::SubagentHistory { events, source, .. } =
                ask(&mut client, request.clone()).await
            else {
                panic!("stream history")
            };
            assert_eq!(source, "stream");
            assert_eq!(
                text_content(&events),
                if failed {
                    ""
                } else {
                    "Final [redacted] report"
                }
            );
            assert!(events.iter().any(|e| matches!(&e.event,EventKind::ToolResult {content,..} if content.to_string().contains("[redacted]"))));
            assert!(
                !serde_json::to_string(&events)
                    .unwrap()
                    .contains("fixture-environment-secret")
            );
            let Response::SubagentTranscript {
                events: snapshot, ..
            } = ask(
                &mut client,
                Request::SubagentTranscript {
                    session_id: id.clone(),
                    task_id: tasks[0].id.clone(),
                },
            )
            .await
            else {
                panic!("legacy stream snapshot")
            };
            assert_eq!(text_content(&snapshot), text_content(&events));
            let mut reconnected = host.client().await;
            let Response::SubagentHistory { events: replay, .. } =
                ask(&mut reconnected, request).await
            else {
                panic!("stream replay")
            };
            assert_eq!(text_content(&replay), text_content(&events));
        }
    }
}

#[tokio::test]
async fn backslash_window_redaction_precedes_main_and_child_storage_and_replay() {
    let host = Host::start().await;
    let secret = r"\nAB";
    for child in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = session(&mut client, root.path()).await;
        let provider = latte_work_protocol::TurnProvider::Configured {
            provider: None,
            environment: AgentEnvironment(BTreeMap::from([(
                "LATTE_TEST_SECRET".into(),
                secret.into(),
            )])),
        };
        assert!(matches!(
            ask(
                &mut client,
                Request::Send {
                    session_id: id.clone(),
                    request_id: format!("escape-window-{id}"),
                    text: format!(
                        "custom-environment-escape-window{}",
                        if child { "-child" } else { "" }
                    ),
                    model: None,
                    effort: None,
                    permission_mode: None,
                    provider: Some(provider.clone()),
                }
            )
            .await,
            Response::Accepted { .. }
        ));
        let table = if child { "subagent_history" } else { "events" };
        let text = |events: &[EventKind]| {
            events
                .iter()
                .filter_map(|e| match e {
                    EventKind::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>()
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let before = loop {
            let value = text(&stored_content(&host, table, &id));
            if !value.is_empty() {
                break value;
            }
            assert!(Instant::now() < deadline, "first delta was not stored");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        std::fs::write(root.path().join("environment-window-continue"), "").unwrap();
        wait(&mut client, &id, Status::Completed).await;
        let saved = text(&stored_content(&host, table, &id));
        let decoded: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert!(
            !decoded["secret"].as_str().unwrap().contains(secret),
            "recoverable credential in {table}"
        );
        assert!(decoded["secret"].as_str().unwrap().contains("[redacted]"));
        assert_eq!(
            before,
            format!("{{\"secret\":\"{}", "\\".repeat(16)),
            "the encoded secret prefix must not reach storage"
        );
        let mut reconnected = host.client().await;
        let replay = if child {
            let Response::SubagentHistory { events, .. } = ask(
                &mut reconnected,
                Request::SubagentHistory {
                    session_id: id.clone(),
                    task_id: "tool:escape-window-child".into(),
                    after: None,
                    source: None,
                    provider: Some(provider),
                },
            )
            .await
            else {
                panic!("child replay")
            };
            let Response::SubagentTranscript { events: legacy, .. } = ask(
                &mut reconnected,
                Request::SubagentTranscript {
                    session_id: id.clone(),
                    task_id: "tool:escape-window-child".into(),
                },
            )
            .await
            else {
                panic!("legacy child replay")
            };
            assert_eq!(text_content(&legacy), saved);
            events
        } else {
            wait(&mut reconnected, &id, Status::Completed).await
        };
        assert_eq!(text_content(&replay), saved);
        assert!(
            !serde_json::from_str::<serde_json::Value>(&text_content(&replay)).unwrap()["secret"]
                .as_str()
                .unwrap()
                .contains(secret)
        );
    }
}

#[tokio::test]
async fn environment_secrets_are_redacted_before_storage_across_json_and_stream_fragments() {
    let host = Host::start().await;
    for secret in ["fixture-environment-secret", "abc\"def", "a&b", "A&b<>中🔑"] {
        let project = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let id = session(&mut client, project.path()).await;
        let provider = latte_work_protocol::TurnProvider::Configured {
            provider: None,
            environment: AgentEnvironment(BTreeMap::from([
                ("TOKEN".into(), "text".into()),
                ("LATTE_TEST_SECRET".into(), secret.into()),
            ])),
        };
        assert!(matches!(
            ask(
                &mut client,
                Request::Send {
                    session_id: id.clone(),
                    request_id: format!("redaction-{id}"),
                    text: "custom-environment-stream".into(),
                    model: None,
                    effort: None,
                    permission_mode: None,
                    provider: Some(provider.clone()),
                }
            )
            .await,
            Response::Accepted { duplicate: false }
        ));
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
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
                panic!("events")
            };
            assert_ne!(session.status, Status::Failed);
            if text_content(&events).starts_with("public before ") {
                assert_eq!(text_content(&events), "public before ");
                break;
            }
            assert!(Instant::now() < deadline, "first delta was not observed");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let stored = stored_content(&host, "events", &id);
        let initial_text: String = stored
            .iter()
            .filter_map(|e| match e {
                EventKind::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            initial_text, "public before ",
            "unmatched secret prefixes must not be stored"
        );
        std::fs::write(project.path().join("environment-stream-continue"), "").unwrap();
        let events = wait(&mut client, &id, Status::Completed).await;
        assert_eq!(
            text_content(&events),
            "public before [redacted] public after\n{\"secret\": \"[redacted]\"}\n{\"secret\": \"[redacted]\"}\n"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(&e.event, EventKind::Tool { id, name, input }
            if id == "text" && name == "text" && input["body"] == "[redacted]"))
        );
        assert!(events.iter().any(
            |e| matches!(&e.event, EventKind::ToolResult { id, content, .. }
            if id == "text" && content[0]["type"] == "text" && content[0]["text"] == "[redacted]")
        ));
        let history = Request::SubagentHistory {
            session_id: id.clone(),
            task_id: "tool:secret-child".into(),
            after: None,
            source: None,
            provider: Some(provider),
        };
        let Response::SubagentHistory { events: child, .. } =
            ask(&mut client, history.clone()).await
        else {
            panic!("child history")
        };
        assert_eq!(text_content(&child), "child before [redacted] child after");
        for table in ["events", "subagent_history"] {
            let stored = stored_content(&host, table, &id);
            let text: String = stored
                .iter()
                .filter_map(|e| match e {
                    EventKind::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            assert!(!text.contains(secret));
            assert!(!serde_json::to_string(&stored).unwrap().contains(secret));
            assert!(text.contains("[redacted]"));
        }
        drop(client);
        let mut reconnected = host.client().await;
        let replay = wait(&mut reconnected, &id, Status::Completed).await;
        assert_eq!(text_content(&replay), text_content(&events));
        let Response::SubagentHistory { events: replay, .. } = ask(&mut reconnected, history).await
        else {
            panic!("child replay")
        };
        assert_eq!(
            serde_json::to_value(&replay).unwrap(),
            serde_json::to_value(&child).unwrap()
        );
    }
}

#[tokio::test]
async fn claude_model_labels_use_the_effective_app_environment_and_config_directory() {
    let host = Host::start_with_environment(&[
        (
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            std::ffi::OsStr::new("host/opus"),
        ),
        (
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            std::ffi::OsStr::new("Host Opus"),
        ),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("settings.json"),
        serde_json::json!({"env": {
            "ANTHROPIC_DEFAULT_SONNET_MODEL":"session/sonnet",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME":"Session Sonnet"
        }})
        .to_string(),
    )
    .unwrap();
    let mut client = host.client().await;
    let Response::Models { model_labels, .. } = ask(
        &mut client,
        Request::ModelsForProvider {
            agent: "claude".into(),
            project_id: None,
            model: None,
            provider: None,
            environment: AgentEnvironment(BTreeMap::from([
                (
                    "CLAUDE_CONFIG_DIR".into(),
                    directory.path().to_string_lossy().into(),
                ),
                ("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), "app/opus".into()),
                (
                    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".into(),
                    "App Opus".into(),
                ),
            ])),
        },
    )
    .await
    else {
        panic!("models")
    };
    assert_eq!(
        model_labels.get("opus").map(String::as_str),
        Some("App Opus")
    );
    assert_eq!(
        model_labels.get("sonnet").map(String::as_str),
        Some("Session Sonnet")
    );
}

fn reported_environment(events: &[latte_work_protocol::Event]) -> serde_json::Value {
    events
        .iter()
        .rev()
        .find_map(|event| match &event.event {
            EventKind::Text { text } => serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .filter(|v| v.get("pid").is_some()),
            _ => None,
        })
        .expect("native process environment report")
}

#[tokio::test]
async fn custom_agent_environment_reaches_all_adapters_and_reconfigures_without_replay() {
    let host = Host::start_with_environment(&[(
        "HTTP_PROXY",
        std::ffi::OsStr::new("http://inherited.test:80"),
    )])
    .await;
    let app = tempfile::tempdir().unwrap();
    let target = Mutex::new(host.client().await);
    let mut observer = host.client().await;
    let app_path = app.path();
    for agent in ["claude", "traex", "codex"] {
        let root = tempfile::tempdir().unwrap();
        let Response::Project { project } = ask(
            &mut observer,
            Request::AddProject {
                path: root.path().to_string_lossy().into_owned(),
                name: None,
            },
        )
        .await
        else {
            panic!()
        };
        let Response::Session { session } = ask(
            &mut observer,
            Request::CreateSession {
                project_id: project.id,
                agent: agent.into(),
            },
        )
        .await
        else {
            panic!()
        };
        let resolve = |agent: String| async move {
            ProviderStore::open(app_path, None)?.launch_for_host("target", &agent)
        };
        let mut environment = AgentEnvironment(BTreeMap::from([
            ("HTTP_PROXY".into(), "http://custom.test:7890".into()),
            ("HTTPS_PROXY".into(), "http://custom.test:7890".into()),
            ("NO_PROXY".into(), "localhost,127.0.0.1".into()),
            (
                "LATTE_TEST_LITERAL".into(),
                " $(do-not-execute)=literal ".into(),
            ),
            ("LATTE_TEST_EMPTY".into(), String::new()),
            (
                "LATTE_TEST_SECRET".into(),
                "fixture-environment-secret".into(),
            ),
        ]));
        ProviderStore::open(app_path, None)
            .unwrap()
            .save_environment("target", agent, environment.clone())
            .unwrap();
        assert!(matches!(
            request_with_app_agent_config(
                &target,
                Request::OpenAgentSession {
                    session_id: session.id.clone(),
                    provider: None,
                },
                resolve
            )
            .await
            .unwrap(),
            Response::Ok
        ));
        let send = |id: &str| Request::Send {
            session_id: session.id.clone(),
            request_id: format!("{agent}-{id}"),
            text: "custom-environment".into(),
            model: None,
            effort: None,
            permission_mode: None,
            provider: None,
        };
        assert!(matches!(
            request_with_app_agent_config(&target, send("first"), resolve)
                .await
                .unwrap(),
            Response::Accepted { .. }
        ));
        let first_events = wait(&mut observer, &session.id, Status::Completed).await;
        let first = reported_environment(&first_events);
        assert_eq!(first["HTTP_PROXY"], "http://custom.test:7890");
        assert_eq!(first["HTTPS_PROXY"], "http://custom.test:7890");
        assert_eq!(first["NO_PROXY"], "localhost,127.0.0.1");
        assert_eq!(first["LATTE_TEST_LITERAL"], " $(do-not-execute)=literal ");
        assert_eq!(first["LATTE_TEST_EMPTY"], "");
        assert_eq!(first["LATTE_TEST_SECRET"], "[redacted]");
        assert!(matches!(
            request_with_app_agent_config(&target, send("second"), resolve)
                .await
                .unwrap(),
            Response::Accepted { .. }
        ));
        let second =
            reported_environment(&wait(&mut observer, &session.id, Status::Completed).await);
        assert_eq!(
            first["pid"], second["pid"],
            "same ENV must keep the process"
        );

        environment
            .0
            .insert("HTTP_PROXY".into(), "http://changed.test:7890".into());
        ProviderStore::open(app_path, None)
            .unwrap()
            .save_environment("target", agent, environment)
            .unwrap();
        assert!(
            matches!(
                request_with_app_agent_config(&target, send("first"), resolve)
                    .await
                    .unwrap(),
                Response::Error { .. }
            ),
            "a changed ENV cannot reuse an accepted request identity"
        );
        assert!(matches!(
            request_with_app_agent_config(&target, send("changed"), resolve)
                .await
                .unwrap(),
            Response::Accepted { .. }
        ));
        let changed =
            reported_environment(&wait(&mut observer, &session.id, Status::Completed).await);
        assert_eq!(changed["HTTP_PROXY"], "http://changed.test:7890");
        assert_ne!(
            first["pid"], changed["pid"],
            "changed ENV must replace the idle process"
        );

        ProviderStore::open(app_path, None)
            .unwrap()
            .save_environment("target", agent, AgentEnvironment::default())
            .unwrap();
        // Reconnect through a new real bridge, then explicitly submit a new request.
        let reconnected = Mutex::new(host.client().await);
        assert!(matches!(
            request_with_app_agent_config(&reconnected, send("cleared"), resolve)
                .await
                .unwrap(),
            Response::Accepted { .. }
        ));
        let cleared_events = wait(&mut observer, &session.id, Status::Completed).await;
        let cleared = reported_environment(&cleared_events);
        assert_eq!(cleared["HTTP_PROXY"], "http://inherited.test:80");
        assert_eq!(cleared["LATTE_TEST_LITERAL"], serde_json::Value::Null);
        assert_eq!(cleared["LATTE_TEST_SECRET"], serde_json::Value::Null);
        assert_eq!(
            cleared_events
                .iter()
                .filter(|e| matches!(&e.event, EventKind::User { .. }))
                .count(),
            4
        );
        assert!(
            !serde_json::to_string(&cleared_events)
                .unwrap()
                .contains("fixture-environment-secret")
        );
        ask(
            &mut observer,
            Request::CloseAgentSession {
                session_id: session.id,
                only_if_idle: None,
            },
        )
        .await;
    }
    assert!(!host.directory.path().join("providers.json").exists());
    for name in ["state.sqlite", "state.sqlite-wal"] {
        if let Ok(bytes) = std::fs::read(host.directory.path().join(name)) {
            assert!(
                !bytes
                    .windows(b"fixture-environment-secret".len())
                    .any(|b| b == b"fixture-environment-secret")
            );
        }
    }
}
