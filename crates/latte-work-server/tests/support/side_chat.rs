use super::*;
use latte_work_protocol::{AgentEnvironment, Session, TurnProvider, TurnUndoStatus};

#[tokio::test]
async fn side_chat_forks_while_parent_waits_and_resumes_independently() {
    for agent in ["codex", "traex"] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let mut client = host.client().await;
        let project = terminal_project(&mut client, root.path()).await;
        let Response::Session { session: parent } = ask(
            &mut client,
            Request::CreateSession {
                project_id: project.clone(),
                agent: agent.into(),
            },
        )
        .await
        else {
            panic!("main session")
        };
        let open = || Request::OpenSideChat {
            session_id: parent.id.clone(),
            side_id: None,
        };
        assert!(matches!(
            ask(&mut client, open()).await,
            Response::Error { .. }
        ));
        assert!(matches!(
            send(&mut client, &parent.id, "main", "approval").await,
            Response::Accepted { .. }
        ));
        let pending = permission(&wait(&mut client, &parent.id, Status::Waiting).await);
        let Response::Session { session: side } = ask(&mut client, open()).await else {
            panic!("side session")
        };
        assert_ne!(side.id, parent.id);
        assert!(side.native_id.is_none());
        assert!(matches!(
            ask(
                &mut client,
                Request::OpenSideChat {
                    session_id: side.id.clone(),
                    side_id: None,
                }
            )
            .await,
            Response::Error { .. }
        ));
        assert!(
            matches!(ask(&mut client, Request::Sessions {project_id:project}).await,Response::Sessions{sessions} if sessions.len()==1 && sessions[0].id==parent.id)
        );
        assert!(matches!(
            send(&mut client, &side.id, "side", "side-only").await,
            Response::Accepted { duplicate: false }
        ));
        let events = wait(&mut client, &side.id, Status::Completed).await;
        assert!(
            events
                .iter()
                .any(|e| matches!(&e.event, EventKind::Text{text} if text.contains("side-only")))
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(&e.event, EventKind::TurnChanges { .. }))
        );
        let mut reconnect = host.client().await;
        assert!(
            matches!(ask(&mut reconnect,open()).await,Response::Session{session} if session.id==side.id && session.native_id.as_deref().is_some_and(|id| id.starts_with("side-thread-")))
        );
        assert!(matches!(
            send(&mut reconnect, &side.id, "side", "side-only").await,
            Response::Accepted { duplicate: true }
        ));
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::CloseAgentSession {
                    session_id: side.id.clone(),
                    only_if_idle: Some(true)
                }
            )
            .await,
            Response::Ok
        ));
        assert!(matches!(
            send(&mut reconnect, &side.id, "follow", "question").await,
            Response::Accepted { .. }
        ));
        wait(&mut reconnect, &side.id, Status::Waiting).await;
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::CloseAgentSession {
                    session_id: side.id.clone(),
                    only_if_idle: Some(false),
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut reconnect, &side.id, Status::Stopped).await;
        assert!(matches!(
            ask(&mut reconnect, Request::Session { session_id: side.id.clone() }).await,
            Response::Session { session } if session.agent_session_open == Some(false)
        ));
        let next_id = uuid::Uuid::new_v4().to_string();
        let new_chat = || Request::OpenSideChat {
            session_id: parent.id.clone(),
            side_id: Some(next_id.clone()),
        };
        for _ in 0..2 {
            assert!(
                matches!(ask(&mut reconnect, new_chat()).await, Response::Session{session} if session.id == next_id)
            );
        }
        assert!(
            matches!(ask(&mut reconnect, Request::SideChats{session_id:parent.id.clone()}).await, Response::Sessions{sessions} if sessions.len() == 2 && sessions[0].id == next_id && sessions[1].id == side.id)
        );
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::Send {
                    session_id: next_id.clone(),
                    request_id: "side-approval".into(),
                    text: "approval".into(),
                    model: None,
                    effort: None,
                    permission_mode: Some("default".into()),
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Accepted { .. }
        ));
        let side_approval = permission(&wait(&mut reconnect, &next_id, Status::Waiting).await);
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::Approve {
                    session_id: next_id.clone(),
                    request_id: side_approval,
                    allow: true,
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut reconnect, &next_id, Status::Completed).await;
        assert!(matches!(
            ask(
                &mut reconnect,
                Request::Send {
                    session_id: next_id.clone(),
                    request_id: "side-full-access".into(),
                    text: "full-access follow-up".into(),
                    model: None,
                    effort: None,
                    permission_mode: Some("bypass_permissions".into()),
                    provider: Some(TurnProvider::Cli),
                }
            )
            .await,
            Response::Accepted { .. }
        ));
        wait(&mut reconnect, &next_id, Status::Completed).await;
        assert!(
            matches!(ask(&mut reconnect, Request::Session {session_id:next_id.clone()}).await,
            Response::Session{session} if session.permission_mode.as_deref()==Some("bypass_permissions"))
        );
        let original = wait(&mut client, &parent.id, Status::Waiting).await;
        assert_eq!(permission(&original), pending);
        assert_eq!(
            original
                .iter()
                .filter(|e| matches!(e.event, EventKind::User { .. }))
                .count(),
            1
        );
        assert!(matches!(
            ask(
                &mut client,
                Request::Approve {
                    session_id: parent.id.clone(),
                    request_id: pending,
                    allow: true
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut client, &parent.id, Status::Completed).await;
        assert!(matches!(ask(&mut client, Request::UndoTurnChanges {
            session_id: parent.id.clone(), request_id: "main".into(),
        }).await, Response::Error { message, .. } if message.contains("具备写权限的侧边聊天")));
        assert!(
            matches!(ask(&mut client,Request::RecentSessions{before:None}).await,Response::RecentSessions{sessions,..} if sessions.len()==1 && sessions[0].session.id==parent.id)
        );
    }
}

#[tokio::test]
async fn claude_side_chat_resumes_its_own_native_session_and_denies_readonly_approval() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = terminal_project(&mut client, root.path()).await;
    let Response::Session { session: parent } = ask(
        &mut client,
        Request::CreateSession {
            project_id,
            agent: "claude".into(),
        },
    )
    .await
    else {
        panic!("Claude main session");
    };
    let open = Request::OpenSideChat {
        session_id: parent.id.clone(),
        side_id: None,
    };
    assert!(matches!(
        send(&mut client, &parent.id, "main", "approve").await,
        Response::Accepted { .. }
    ));
    let pending = permission(&wait(&mut client, &parent.id, Status::Waiting).await);
    let Response::Session { session: side } = ask(&mut client, open).await else {
        panic!("Claude side session");
    };
    let read_session = |id: &str| Request::Session {
        session_id: id.into(),
    };
    let Response::Session {
        session: running_parent,
    } = ask(&mut client, read_session(&parent.id)).await
    else {
        panic!("running Claude main session");
    };
    assert!(matches!(
        send(&mut client, &side.id, "side", "approve").await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &side.id, Status::Completed).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e.event, EventKind::Approval { .. }))
    );
    assert!(!root.path().join("approved.txt").exists());
    let Response::Session {
        session: completed_side,
    } = ask(&mut client, read_session(&side.id)).await
    else {
        panic!("completed Claude side session");
    };
    assert!(completed_side.native_id.is_some());
    assert_ne!(completed_side.native_id, running_parent.native_id);
    assert!(matches!(
        ask(
            &mut client,
            Request::CloseAgentSession {
                session_id: side.id.clone(),
                only_if_idle: Some(true)
            }
        )
        .await,
        Response::Ok
    ));
    let mut reconnect = host.client().await;
    assert!(matches!(
        ask(
            &mut reconnect,
            Request::Send {
                session_id: side.id.clone(),
                request_id: "side-write".into(),
                text: "approve".into(),
                model: None,
                effort: None,
                permission_mode: Some("default".into()),
                provider: Some(TurnProvider::Cli),
            }
        )
        .await,
        Response::Accepted { .. }
    ));
    let side_pending = permission(&wait(&mut reconnect, &side.id, Status::Waiting).await);
    assert!(matches!(
        ask(
            &mut reconnect,
            Request::Approve {
                session_id: side.id.clone(),
                request_id: side_pending,
                allow: true
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut reconnect, &side.id, Status::Completed).await;
    assert!(root.path().join("approved.txt").exists());
    assert!(
        matches!(ask(&mut reconnect, read_session(&side.id)).await, Response::Session { session } if session.native_id == completed_side.native_id)
    );
    assert_eq!(
        permission(&wait(&mut client, &parent.id, Status::Waiting).await),
        pending
    );
}

async fn create_session(client: &mut Client, project_id: String, agent: &str) -> Session {
    match ask(
        client,
        Request::CreateSession {
            project_id,
            agent: agent.into(),
        },
    )
    .await
    {
        Response::Session { session } => session,
        other => panic!("create session: {other:?}"),
    }
}

async fn open_side(client: &mut Client, parent: &Session) -> Session {
    match ask(
        client,
        Request::OpenSideChat {
            session_id: parent.id.clone(),
            side_id: Some(uuid::Uuid::new_v4().to_string()),
        },
    )
    .await
    {
        Response::Session { session } => session,
        other => panic!("open side chat: {other:?}"),
    }
}

async fn start_writable_side(client: &mut Client, side: &Session, prompt: &str) {
    send_writable_side(client, side, prompt, "default", TurnProvider::Cli).await;
    wait(client, &side.id, Status::Completed).await;
}

async fn send_writable_side(
    client: &mut Client,
    side: &Session,
    prompt: &str,
    permission: &str,
    provider: TurnProvider,
) {
    assert!(matches!(
        ask(
            client,
            Request::Send {
                session_id: side.id.clone(),
                request_id: "side-write".into(),
                text: prompt.into(),
                model: None,
                effort: None,
                permission_mode: Some(permission.into()),
                provider: Some(provider),
            }
        )
        .await,
        Response::Accepted { .. }
    ));
}

async fn check_side_write_undo(background: bool, main_in_subdir: Option<bool>) {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let nested = root.path().join("sub");
    std::fs::create_dir(&nested).unwrap();
    let mut client = host.client().await;
    let root_id = terminal_project(&mut client, root.path()).await;
    let nested_id = terminal_project(&mut client, &nested).await;
    let (main_project, side_project, side_dir) = match main_in_subdir {
        Some(true) => (nested_id, root_id, root.path()),
        Some(false) => (root_id, nested_id, nested.as_path()),
        None => (root_id.clone(), root_id, root.path()),
    };
    let file = if main_in_subdir == Some(true) {
        nested.join("shared.txt")
    } else {
        side_dir.join("shared.txt")
    };
    std::fs::write(&file, "before\n").unwrap();
    let parent = create_session(&mut client, side_project, "codex").await;
    send(&mut client, &parent.id, "parent-init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let side = open_side(&mut client, &parent).await;
    if background {
        start_writable_side(&mut client, &side, "side-background-write").await;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
    }
    let main = create_session(&mut client, main_project, "codex").await;
    send(&mut client, &main.id, "main-write", "approval").await;
    let pending = permission(&wait(&mut client, &main.id, Status::Waiting).await);
    if background {
        std::fs::write(side_dir.join("release-side-writer"), "").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if matches!(
                ask(
                    &mut client,
                    Request::CloseAgentSession {
                        session_id: side.id.clone(),
                        only_if_idle: Some(true),
                    }
                )
                .await,
                Response::Ok
            ) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "background writer never became idle"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    } else {
        let prompt = if main_in_subdir == Some(true) {
            "side-foreground-write-nested"
        } else {
            "side-foreground-write"
        };
        start_writable_side(&mut client, &side, prompt).await;
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "side edit\n");
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: main.id.clone(),
                request_id: pending,
                allow: true,
            }
        )
        .await,
        Response::Ok
    ));
    let events = wait(&mut client, &main.id, Status::Completed).await;
    assert!(events.iter().any(|event| matches!(&event.event,
        EventKind::TurnChanges { changes } if changes.summary.entries.iter().any(|entry| entry.path.ends_with("shared.txt"))
    )));
    assert!(matches!(ask(&mut client, Request::UndoTurnChanges {
        session_id: main.id.clone(), request_id: "main-write".into(),
    }).await, Response::Error { message, .. } if message.contains("具备写权限的侧边聊天")));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "side edit\n");

    if background {
        send(&mut client, &main.id, "main-later", "main-foreground-write").await;
        wait(&mut client, &main.id, Status::Completed).await;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "main edit\n");
        let response = ask(
            &mut client,
            Request::UndoTurnChanges {
                session_id: main.id,
                request_id: "main-later".into(),
            },
        )
        .await;
        assert!(
            matches!(response, Response::TurnChanges { .. }),
            "{response:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "side edit\n");
    }
}

#[tokio::test]
async fn undo_preserves_background_side_writes_after_native_exit() {
    check_side_write_undo(true, None).await;
}

#[tokio::test]
async fn undo_fences_writable_side_chats_in_both_directions_of_nested_roots() {
    check_side_write_undo(false, Some(false)).await;
    check_side_write_undo(false, Some(true)).await;
}

#[tokio::test]
async fn undo_preserves_full_access_side_writes_in_an_unrelated_project() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let main_dir = root.path().join("main-project");
    let side_dir = root.path().join("side-project");
    std::fs::create_dir(&main_dir).unwrap();
    std::fs::create_dir(&side_dir).unwrap();
    let file = main_dir.join("shared.txt");
    std::fs::write(&file, "before\n").unwrap();
    let mut client = host.client().await;
    let side_project = terminal_project(&mut client, &side_dir).await;
    let parent = create_session(&mut client, side_project, "codex").await;
    send(&mut client, &parent.id, "parent-init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let side = open_side(&mut client, &parent).await;

    let main_project = terminal_project(&mut client, &main_dir).await;
    let main = create_session(&mut client, main_project, "codex").await;
    send(&mut client, &main.id, "main-write", "approval").await;
    let pending = permission(&wait(&mut client, &main.id, Status::Waiting).await);
    send_writable_side(
        &mut client,
        &side,
        "side-cross-project-write",
        "bypass_permissions",
        TurnProvider::Cli,
    )
    .await;
    wait(&mut client, &side.id, Status::Completed).await;
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "side edit\n");
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: main.id.clone(),
                request_id: pending,
                allow: true,
            }
        )
        .await,
        Response::Ok
    ));
    let events = wait(&mut client, &main.id, Status::Completed).await;
    assert!(events.iter().any(|event| matches!(&event.event,
        EventKind::TurnChanges { changes } if changes.summary.entries.iter().any(|entry| entry.path == "shared.txt")
    )));
    let undo = ask(
        &mut client,
        Request::UndoTurnChanges {
            session_id: main.id,
            request_id: "main-write".into(),
        },
    )
    .await;
    assert!(
        matches!(&undo, Response::Error { message, .. }
        if message.contains("具备写权限的侧边聊天")),
        "{undo:?}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "side edit\n");
}

#[tokio::test]
async fn undo_ignores_prelaunch_rejection_and_fences_unconfirmed_native_exit() {
    for launch in [false, true] {
        let host = Host::start().await;
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("shared.txt");
        std::fs::write(&file, "before\n").unwrap();
        let mut client = host.client().await;
        let project = terminal_project(&mut client, root.path()).await;
        let parent = create_session(&mut client, project, "codex").await;
        send(&mut client, &parent.id, "parent-init", "hello").await;
        wait(&mut client, &parent.id, Status::Completed).await;
        let side = open_side(&mut client, &parent).await;

        let main = &parent.id;
        send(&mut client, main, "main-write", "approval-then-main-write").await;
        let pending = permission(&wait(&mut client, main, Status::Waiting).await);
        let provider = if launch {
            TurnProvider::Cli
        } else {
            TurnProvider::Configured {
                provider: None,
                environment: AgentEnvironment(
                    [("LATTE_TEST_LITERAL".into(), "changed".into())].into(),
                ),
            }
        };
        send_writable_side(&mut client, &side, "eof", "default", provider).await;
        let events = wait(&mut client, &side.id, Status::Failed).await;
        let inputs = std::fs::read_to_string(root.path().join("codex-inputs")).unwrap();
        assert_eq!(inputs.contains(r#""prompt": "eof""#), launch);
        if !launch {
            assert!(events.iter().any(|event| matches!(&event.event,
                EventKind::State { message: Some(message), .. } if message.contains("Provider 或环境已变化")
            )));
        }
        assert!(matches!(
            ask(
                &mut client,
                Request::Approve {
                    session_id: main.clone(),
                    request_id: pending,
                    allow: true,
                }
            )
            .await,
            Response::Ok
        ));
        wait(&mut client, main, Status::Completed).await;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "main edit\n");
        let undo = ask(
            &mut client,
            Request::UndoTurnChanges {
                session_id: main.clone(),
                request_id: "main-write".into(),
            },
        )
        .await;
        if launch {
            assert!(
                matches!(&undo, Response::Error { message, .. }
                if message.contains("具备写权限的侧边聊天")),
                "{undo:?}"
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "main edit\n");
        } else {
            assert!(
                matches!(&undo, Response::TurnChanges { changes }
                if changes.undo == TurnUndoStatus::Reverted),
                "{undo:?}"
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
        }
    }
}

#[tokio::test]
async fn history_pages_past_one_hundred_and_can_reopen_the_oldest_chat() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project = terminal_project(&mut client, root.path()).await;
    let parent = create_session(&mut client, project, "codex").await;
    send(&mut client, &parent.id, "parent-init", "hello").await;
    wait(&mut client, &parent.id, Status::Completed).await;
    let oldest = open_side(&mut client, &parent).await;
    for _ in 0..100 {
        open_side(&mut client, &parent).await;
    }
    let history = |before| Request::SideChatHistory {
        session_id: parent.id.clone(),
        before,
    };
    let Response::SideChatHistory {
        sessions,
        next: Some(next),
    } = ask(&mut client, history(None)).await
    else {
        panic!("first page")
    };
    assert_eq!(sessions.len(), 100);
    assert_eq!(sessions.last().unwrap().id, next);
    assert!(!sessions.iter().any(|entry| entry.id == oldest.id));
    open_side(&mut client, &parent).await;
    assert!(matches!(ask(&mut client, history(Some(next))).await,
        Response::SideChatHistory { sessions, next: None } if sessions.len() == 1 && sessions[0].id == oldest.id
    ));
    assert!(matches!(ask(&mut client, Request::OpenSideChat {
        session_id: parent.id, side_id: Some(oldest.id.clone()),
    }).await, Response::Session { session } if session.id == oldest.id));
}
