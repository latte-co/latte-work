use super::*;
use latte_work_protocol::TurnProvider;

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
