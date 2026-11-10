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
            matches!(ask(&mut client, Request::RenameSession { session_id: id.clone(), title: "My name".into() }).await, Response::Session { session } if session.custom_title)
        );
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
