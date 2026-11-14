use super::*;
use latte_work_protocol::{AgentEnvironment, Effort, TurnProvider};
use std::ffi::OsStr;

async fn project(client: &mut Client, path: &Path) -> String {
    let response = ask(
        client,
        Request::AddProject {
            path: path.to_string_lossy().into(),
            name: None,
        },
    )
    .await;
    let Response::Project { project } = response else {
        panic!("{response:?}")
    };
    project.id
}

async fn create(client: &mut Client, project_id: &str) -> String {
    let response = ask(
        client,
        Request::CreateSession {
            project_id: project_id.into(),
            agent: "opencode".into(),
        },
    )
    .await;
    let Response::Session { session } = response else {
        panic!("{response:?}")
    };
    session.id
}

async fn current(client: &mut Client, id: &str) -> latte_work_protocol::Session {
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
    session
}

fn open(id: &str) -> Request {
    Request::OpenAgentSession {
        session_id: id.into(),
        provider: Some(TurnProvider::Cli),
    }
}

fn close(id: &str, only_if_idle: bool) -> Request {
    Request::CloseAgentSession {
        session_id: id.into(),
        only_if_idle: Some(only_if_idle),
    }
}

fn turn(id: &str, request: &str, text: &str) -> Request {
    Request::SendQueued {
        session_id: id.into(),
        request_id: request.into(),
        text: text.into(),
        model: Some("test/other".into()),
        effort: Some(Effort::Max),
        permission_mode: None,
        provider: Some(TurnProvider::Cli),
    }
}

fn contains_text(events: &[latte_work_protocol::Event], text: &str) -> bool {
    events
        .iter()
        .any(|event| matches!(&event.event, EventKind::Text { text: actual } if actual == text))
}

#[tokio::test]
async fn opencode_rejects_v1_at_discovery() {
    let host =
        Host::start_with_environment(&[("LATTE_TEST_OPENCODE_VERSION", OsStr::new("1.19.5"))])
            .await;
    let mut client = host.client().await;
    let Response::Hello { agents, .. } =
        ask(&mut client, Request::Hello { version: VERSION }).await
    else {
        panic!("hello")
    };
    assert!(
        agents
            .iter()
            .any(|a| a.id == "opencode" && !a.available && a.detail.contains("2.x"))
    );
    let folder = tempfile::tempdir().unwrap();
    let project_id = project(&mut client, folder.path()).await;
    assert!(matches!(
        ask(
            &mut client,
            Request::CreateSession {
                project_id,
                agent: "opencode".into()
            }
        )
        .await,
        Response::Error { .. }
    ));
}

#[tokio::test]
async fn opencode_metadata_resume_and_reconciliation_use_native_identity() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let response = ask(
        &mut client,
        Request::ModelsForProvider {
            agent: "opencode".into(),
            model: Some("test/other".into()),
            project_id: Some(project_id.clone()),
            provider: None,
            environment: AgentEnvironment(
                [("OPENCODE_FIXTURE_LABEL".into(), "Configured".into())].into(),
            ),
        },
    )
    .await;
    assert!(
        matches!(response, Response::Models { default_model, effort_levels, model_labels, .. }
        if default_model.as_deref() == Some("test/default") && effort_levels == [Effort::Medium, Effort::Max] && model_labels["test/other"] == "Configured")
    );
    assert!(
        matches!(ask(&mut client, Request::AgentCommands { agent: "opencode".into(), project_id: project_id.clone(), provider: None }).await,
        Response::AgentCommands { commands } if commands.iter().any(|c| c.name == "compact") && commands.iter().any(|c| c.name == "project:check"))
    );
    assert_eq!(
        std::fs::read_dir(folder.path()).unwrap().count(),
        0,
        "metadata leaves no native session"
    );
    let id = create(&mut client, &project_id).await;
    assert!(matches!(ask(&mut client, open(&id)).await, Response::Ok));
    let draft = current(&mut client, &id).await;
    assert_eq!(draft.agent_session_open, Some(true));
    assert!(draft.native_id.is_none());
    assert!(!folder.path().join("prompts").exists());
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));

    assert!(matches!(
        ask(
            &mut client,
            turn(&id, "unknown-slash", "/not-a-native-command xxx")
        )
        .await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Failed).await;
    assert!(
        !folder.path().join("prompts").exists(),
        "unsupported command must not reach the model"
    );

    let first = || turn(&id, "command", "/compact");
    assert!(matches!(
        ask(&mut client, first()).await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(contains_text(&events, "fixture "));
    assert!(contains_text(&events, "reply"));
    assert!(!contains_text(&events, "wrong session"));
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("private reasoning")
    );
    assert!(events.iter().any(|event| matches!(&event.event, EventKind::Usage { context: Some(context), totals: Some(totals) } if context.model == "test/other" && totals.output_tokens == Some(3.0))));
    let native = current(&mut client, &id).await.native_id.unwrap();
    drop(client);
    let mut client = host.client().await;
    assert!(matches!(
        ask(&mut client, first()).await,
        Response::Accepted { duplicate: true }
    ));
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    assert!(matches!(ask(&mut client, open(&id)).await, Response::Ok));
    assert!(matches!(
        ask(&mut client, turn(&id, "second", "after reopen")).await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert_eq!(
        current(&mut client, &id).await.native_id.as_deref(),
        Some(native.as_str())
    );
    let log = std::fs::read_to_string(folder.path().join("prompts")).unwrap();
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        [
            format!("{native}:test/other:max:/compact"),
            format!("{native}:test/other:max:after reopen"),
        ]
    );

    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    std::fs::remove_file(folder.path().join(&native)).unwrap();
    assert!(matches!(
        ask(&mut client, open(&id)).await,
        Response::Error { .. }
    ));
    assert_eq!(
        current(&mut client, &id).await.native_id.as_deref(),
        Some(native.as_str())
    );
    assert_eq!(
        std::fs::read_dir(folder.path()).unwrap().count(),
        1,
        "resume failure must not create a replacement session"
    );
}

#[tokio::test]
async fn opencode_permissions_cancel_and_eof_do_not_infer_completion() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    let other = create(&mut client, &project_id).await;
    for (request, allow) in [("permission-allow", true), ("permission-deny", false)] {
        assert!(matches!(
            ask(&mut client, turn(&id, request, request)).await,
            Response::Accepted { .. }
        ));
        let events = wait(&mut client, &id, Status::Waiting).await;
        let token = permission(&events);
        let approve = |session_id: &str| Request::Approve {
            session_id: session_id.into(),
            request_id: token.clone(),
            allow,
        };
        assert!(matches!(
            ask(&mut client, approve(&other)).await,
            Response::Error { .. }
        ));
        assert!(matches!(ask(&mut client, approve(&id)).await, Response::Ok));
        assert!(matches!(
            ask(&mut client, approve(&id)).await,
            Response::Error { .. }
        ));
        let events = wait(&mut client, &id, Status::Completed).await;
        assert!(contains_text(
            &events,
            if allow {
                "decision:once"
            } else {
                "decision:no"
            }
        ));
    }
    assert!(matches!(
        ask(&mut client, turn(&id, "cancel", "permission-cancel")).await,
        Response::Accepted { .. }
    ));
    let token = permission(&wait(&mut client, &id, Status::Waiting).await);
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
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: token,
                allow: true
            }
        )
        .await,
        Response::Error { .. }
    ));
    assert!(matches!(
        ask(&mut client, turn(&id, "eof", "unexpected-eof")).await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &id, Status::Failed).await;
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::State { status: Status::Failed, message: Some(text) } if text.contains("意外退出"))));
}

#[tokio::test]
async fn opencode_project_command_waits_for_native_response_without_sending_a_prompt() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(
            &mut client,
            turn(&id, "native-command", "/project:check now")
        )
        .await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(contains_text(&events, "command reply"));
    assert!(current(&mut client, &id).await.native_id.is_some());
    assert!(!folder.path().join("prompts").exists());
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
}

#[tokio::test]
async fn opencode_skill_metadata_reads_project_install_without_starting_agent() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    let skill = folder
        .path()
        .join(".opencode/skills/fixture-opencode-skill");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: Fixture Skill\ndescription: Project skill\n---\nprivate body\n",
    )
    .unwrap();
    let request = |name: &str| Request::SkillInfo {
        session_id: id.clone(),
        name: name.into(),
    };
    assert!(matches!(
        ask(&mut client, request("fixture-opencode-skill")).await,
        Response::SkillInfo { skill: Some(info) }
            if info.name == "Fixture Skill" && info.description == "Project skill"
                && std::path::Path::new(&info.directory) == skill.canonicalize().unwrap()
    ));
    assert!(matches!(
        ask(&mut client, request("../fixture-opencode-skill")).await,
        Response::Error { .. }
    ));
    assert_eq!(
        current(&mut client, &id).await.agent_session_open,
        Some(false)
    );
}

#[tokio::test]
async fn opencode_child_transcript_is_separate_and_prevents_idle_close() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "child", "background")).await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &id, Status::Completed).await;
    assert!(contains_text(&events, "main only"));
    assert!(!contains_text(&events, "child only"));
    assert_eq!(
        current(&mut client, &id).await.agent_session_busy,
        Some(true)
    );
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Error { .. }
    ));
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
    assert_eq!(tasks.len(), 1);
    let task_id = tasks[0].id.clone();
    assert!(
        matches!(ask(&mut client, Request::SubagentHistory { session_id: id.clone(), task_id, after: None, source: None, provider: None }).await,
        Response::SubagentHistory { events, .. } if contains_text(&events, "child only"))
    );
    assert!(matches!(
        ask(&mut client, close(&id, false)).await,
        Response::Ok
    ));
}

#[tokio::test]
async fn opencode_recovers_nested_history_only_within_known_project_and_ancestry() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "nested", "nested")).await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Completed).await;
    assert!(matches!(
        ask(&mut client, close(&id, true)).await,
        Response::Ok
    ));
    for (task_id, expected_source, expected_text) in [
        ("ses_nested", "native", "native ses_nested"),
        ("ses_unowned", "stream", "stream ses_unowned"),
        ("ses_other_project", "stream", "stream ses_other_project"),
    ] {
        let response = ask(
            &mut client,
            Request::SubagentHistory {
                session_id: id.clone(),
                task_id: task_id.into(),
                after: None,
                source: None,
                provider: Some(TurnProvider::Cli),
            },
        )
        .await;
        assert!(
            matches!(&response, Response::SubagentHistory { source, events, .. }
                if source == expected_source && contains_text(events, expected_text)),
            "{response:?}"
        );
        if task_id == "ses_nested" {
            let Response::SubagentHistory {
                incomplete, events, ..
            } = response
            else {
                unreachable!()
            };
            assert!(incomplete);
            assert!(events.iter().any(|e| matches!(&e.event, EventKind::ToolResult { is_error: true, content, .. } if content[0]["text"] == "native shell failure")));
            assert!(events.iter().any(
                |e| matches!(&e.event, EventKind::Tool { id, .. } if id == "tool_unfinished")
            ));
            assert!(!events.iter().any(
                |e| matches!(&e.event, EventKind::ToolResult { id, .. } if id == "tool_unfinished")
            ));
        }
    }
}

#[tokio::test]
async fn opencode_ignores_late_foreground_events_and_runs_the_background_notification() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    for (request, text) in [
        ("path", "/tmp/project/src inspect this"),
        ("single-component-path", "/tmp inspect this"),
        ("race", "late-native"),
    ] {
        assert!(matches!(
            ask(&mut client, turn(&id, request, text)).await,
            Response::Accepted { .. }
        ));
        wait(&mut client, &id, Status::Completed).await;
    }
    std::fs::write(folder.path().join("release-native"), "").unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(6), async {
        loop {
            let events = wait(&mut client, &id, Status::Completed).await;
            if contains_text(&events, "real follow-up") {
                break events;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert!(contains_text(&events, "ACP reply"));
    assert!(!contains_text(&events, "duplicate native reply"));
}

#[tokio::test]
async fn opencode_routes_native_command_child_approval_and_preserves_tool_identity() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(
            &mut client,
            turn(&id, "command", "/project:check child permission")
        )
        .await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut client, &id, Status::Waiting).await;
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::Approval { input, .. } if input["command"] == "printf fixture")));
    let request_id = permission(&events);
    assert!(matches!(
        ask(
            &mut client,
            Request::Approve {
                session_id: id.clone(),
                request_id: request_id.clone(),
                allow: true
            }
        )
        .await,
        Response::Error { message, .. } if message.contains("仍待处理")
    ));
    let events = wait(&mut client, &id, Status::Waiting).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(&e.event, EventKind::ApprovalResolved { .. }))
    );
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
    let Response::SubagentHistory { events, .. } = ask(
        &mut client,
        Request::SubagentHistory {
            session_id: id,
            task_id: tasks[0].id.clone(),
            after: None,
            source: None,
            provider: None,
        },
    )
    .await
    else {
        panic!("history")
    };
    assert!(events.iter().any(|e| matches!(&e.event, EventKind::Tool { name, input, .. } if name == "Skill" && input["skill"] == "fixture-skill")));
}

#[tokio::test]
async fn opencode_parent_finishes_while_a_child_question_remains_answerable() {
    let host = Host::start().await;
    let folder = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let project_id = project(&mut client, folder.path()).await;
    let id = create(&mut client, &project_id).await;
    assert!(matches!(
        ask(&mut client, turn(&id, "parent", "background-question")).await,
        Response::Accepted { .. }
    ));
    wait(&mut client, &id, Status::Waiting).await;
    std::fs::write(folder.path().join("release-parent"), "").unwrap();
    let (request_id, question_id) = tokio::time::timeout(std::time::Duration::from_secs(6), async {
        loop {
            let events = wait(&mut client, &id, Status::Waiting).await;
            if events.iter().any(|e| matches!(&e.event, EventKind::TurnChanges { changes } if changes.request_id == "parent"))
                && let Some(ids) = events.iter().find_map(|e| match &e.event {
                    EventKind::Question { request_id, questions, .. } => Some((request_id.clone(), questions[0].id.clone())),
                    _ => None,
                })
            {
                break ids;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }).await.unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::AnswerQuestion {
                session_id: id.clone(),
                request_id,
                answers: Some(vec![latte_work_protocol::QuestionAnswer {
                    question_id,
                    option_indices: vec![0],
                    text: None,
                }]),
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut client, &id, Status::Completed).await;
}
