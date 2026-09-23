//! Final-binary tests: real daemon, real socket/bridge, deterministic Claude process.
use latte_work_client::Client;
use latte_work_protocol::{EventKind, Request, Response, Status, VERSION};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct Host {
    directory: tempfile::TempDir,
    process: Child,
}
impl Host {
    async fn start() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("lw-")
            .tempdir_in("/tmp")
            .unwrap();
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude.py");
        let process = Command::new(env!("CARGO_BIN_EXE_latte-work-server"))
            .arg("serve")
            .arg("--state-dir")
            .arg(directory.path())
            .env("LATTE_WORK_CLAUDE", fixture)
            .env("CLAUDE_CONFIG_DIR", directory.path().join("claude-config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let host = Self { directory, process };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !host.directory.path().join("control.sock").exists() {
            assert!(Instant::now() < deadline, "server readiness timeout");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        host
    }
    async fn client(&self) -> Client {
        Client::local(
            Path::new(env!("CARGO_BIN_EXE_latte-work-server")),
            Some(self.directory.path()),
        )
        .await
        .unwrap()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = kill(Pid::from_raw(self.process.id() as i32), Signal::SIGINT);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.process.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}
async fn ask(c: &mut Client, r: Request) -> Response {
    c.request(r).await.unwrap()
}
#[tokio::test]
async fn browse_before_registration_and_named_projects_are_host_scoped() {
    let host = Host::start().await;
    let mut client = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let folder = project.path().join("中文 project");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(project.path().join("not-a-folder.txt"), "private").unwrap();
    let root = project.path().canonicalize().unwrap();
    match ask(
        &mut client,
        Request::BrowseDirectories {
            path: Some(root.to_string_lossy().into_owned()),
        },
    )
    .await
    {
        Response::Directories {
            path,
            entries,
            truncated,
            ..
        } => {
            assert_eq!(path, root.to_string_lossy());
            assert!(!truncated);
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].name, "中文 project");
            assert!(entries[0].directory);
        }
        other => panic!("{other:?}"),
    }
    for path in ["relative", "/missing-latte-work-test-directory"] {
        assert!(matches!(
            ask(
                &mut client,
                Request::BrowseDirectories {
                    path: Some(path.into())
                }
            )
            .await,
            Response::Error { .. }
        ));
    }
    let id = match ask(
        &mut client,
        Request::AddProject {
            path: folder.to_string_lossy().into_owned(),
            name: Some(" 自定义名称 ".into()),
        },
    )
    .await
    {
        Response::Project { project } => {
            assert_eq!(project.name, "自定义名称");
            project.id
        }
        other => panic!("{other:?}"),
    };
    let mut reconnect = host.client().await;
    assert!(
        matches!(ask(&mut reconnect, Request::Projects).await, Response::Projects { projects } if projects.len() == 1 && projects[0].id == id && projects[0].name == "自定义名称")
    );
    let other_host = Host::start().await;
    let mut other = other_host.client().await;
    assert!(
        matches!(ask(&mut other, Request::Projects).await, Response::Projects { projects } if projects.is_empty())
    );
}
async fn session(c: &mut Client, path: &Path) -> String {
    let p = match ask(
        c,
        Request::AddProject {
            path: path.to_string_lossy().into_owned(),
            name: None,
        },
    )
    .await
    {
        Response::Project { project } => project.id,
        r => panic!("{r:?}"),
    };
    match ask(
        c,
        Request::CreateSession {
            project_id: p,
            agent: "claude".into(),
        },
    )
    .await
    {
        Response::Session { session } => session.id,
        r => panic!("{r:?}"),
    }
}
async fn wait(c: &mut Client, id: &str, status: Status) -> Vec<latte_work_protocol::Event> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match ask(
            c,
            Request::Poll {
                session_id: id.into(),
                after: 0.0,
            },
        )
        .await
        {
            Response::Events {
                session, events, ..
            } if session.status == status => return events,
            Response::Events { session, .. } => assert!(
                Instant::now() < deadline,
                "expected {status:?}, got {:?}",
                session.status
            ),
            r => panic!("{r:?}"),
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn permission(events: &[latte_work_protocol::Event]) -> String {
    events
        .iter()
        .rev()
        .find_map(|e| {
            if let EventKind::Approval { request_id, .. } = &e.event {
                Some(request_id.clone())
            } else {
                None
            }
        })
        .unwrap()
}
async fn send(c: &mut Client, id: &str, request: &str, text: &str) -> Response {
    ask(
        c,
        Request::Send {
            session_id: id.into(),
            request_id: request.into(),
            text: text.into(),
            model: None,
            effort: None,
        },
    )
    .await
}
#[tokio::test]
async fn singleton_multi_client_reconnect_approval_dedup_and_resume() {
    let host = Host::start().await;
    let mut a = host.client().await;
    let mut b = host.client().await;
    let hello = |r| match r {
        Response::Hello { server_id, .. } => server_id,
        r => panic!("{r:?}"),
    };
    assert_eq!(
        hello(ask(&mut a, Request::Hello { version: VERSION }).await),
        hello(ask(&mut b, Request::Hello { version: VERSION }).await)
    );
    let status = Command::new(env!("CARGO_BIN_EXE_latte-work-server"))
        .args(["serve", "--state-dir"])
        .arg(host.directory.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(!status.success());
    let project = tempfile::tempdir().unwrap();
    let id = session(&mut a, project.path()).await;
    assert!(matches!(
        send(&mut a, &id, "request-1", "approve").await,
        Response::Accepted { duplicate: false }
    ));
    wait(&mut a, &id, Status::Waiting).await;
    drop(a);
    let events = wait(&mut b, &id, Status::Waiting).await;
    let approval_id = permission(&events);
    assert!(
        events
            .iter()
            .any(|e| matches!(e.event, EventKind::Approval { .. }))
    );
    assert!(matches!(
        send(&mut b, &id, "request-1", "approve").await,
        Response::Accepted { duplicate: true }
    ));
    assert!(matches!(
        ask(
            &mut b,
            Request::Approve {
                session_id: id.clone(),
                request_id: "wrong".into(),
                allow: true
            }
        )
        .await,
        Response::Error { .. }
    ));
    assert!(!project.path().join("approved.txt").exists());
    assert!(matches!(
        ask(
            &mut b,
            Request::Approve {
                session_id: id.clone(),
                request_id: approval_id.clone(),
                allow: true
            }
        )
        .await,
        Response::Ok
    ));
    wait(&mut b, &id, Status::Completed).await;
    assert_eq!(
        std::fs::read_to_string(project.path().join("approved.txt")).unwrap(),
        "approved"
    );
    assert!(matches!(
        ask(
            &mut b,
            Request::Approve {
                session_id: id.clone(),
                request_id: approval_id.clone(),
                allow: true
            }
        )
        .await,
        Response::Error { .. }
    ));
    send(&mut b, &id, "request-2", "hello").await;
    let events = wait(&mut b, &id, Status::Completed).await;
    let text: String = events
        .iter()
        .filter_map(|e| {
            if let EventKind::Text { text } = &e.event {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(text, "resumed:你好");
    let cursor = events.last().unwrap().seq;
    assert!(
        matches!(ask(&mut b,Request::Poll{session_id:id,after:cursor}).await,Response::Events{events,..} if events.is_empty())
    );
}
#[tokio::test]
async fn denies_permissions_and_bounds_paths_and_failures() {
    let host = Host::start().await;
    let mut c = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let id = session(&mut c, project.path()).await;
    send(&mut c, &id, "deny", "approve").await;
    let approval_id = permission(&wait(&mut c, &id, Status::Waiting).await);
    ask(
        &mut c,
        Request::Approve {
            session_id: id.clone(),
            request_id: approval_id.clone(),
            allow: false,
        },
    )
    .await;
    wait(&mut c, &id, Status::Completed).await;
    assert!(!project.path().join("approved.txt").exists());
    let project_id = match ask(&mut c, Request::Projects).await {
        Response::Projects { projects } => projects[0].id.clone(),
        _ => unreachable!(),
    };
    assert!(matches!(
        ask(
            &mut c,
            Request::ReadFile {
                project_id: project_id.clone(),
                path: "../../etc/passwd".into()
            }
        )
        .await,
        Response::Error { .. }
    ));
    assert!(matches!(
        ask(
            &mut c,
            Request::CreateSession {
                project_id,
                agent: "codex".into()
            }
        )
        .await,
        Response::Error { .. }
    ));
    for text in ["malformed", "exit"] {
        send(&mut c, &id, text, text).await;
        let events = wait(&mut c, &id, Status::Failed).await;
        assert!(events.iter().any(|e| matches!(
            e.event,
            EventKind::State {
                status: Status::Failed,
                ..
            }
        )));
    }
}
#[tokio::test]
async fn concurrent_agents_and_cancellation_are_isolated() {
    let host = Host::start().await;
    let mut c = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let a = session(&mut c, project.path()).await;
    let b = session(&mut c, project.path()).await;
    send(&mut c, &a, "hang", "hang").await;
    send(&mut c, &b, "fast", "hello").await;
    wait(&mut c, &b, Status::Completed).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    let child = loop {
        let events = match ask(
            &mut c,
            Request::Poll {
                session_id: a.clone(),
                after: 0.0,
            },
        )
        .await
        {
            Response::Events { events, .. } => events,
            _ => unreachable!(),
        };
        if let Some(pid) = events.iter().find_map(|e| {
            if let EventKind::Text { text } = &e.event {
                text.strip_prefix("child:")
                    .and_then(|s| s.parse::<i32>().ok())
            } else {
                None
            }
        }) {
            break pid;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    ask(
        &mut c,
        Request::Cancel {
            session_id: a.clone(),
        },
    )
    .await;
    wait(&mut c, &a, Status::Stopped).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while kill(Pid::from_raw(child), None).is_ok() {
        assert!(
            Instant::now() < deadline,
            "child escaped process-group cancellation"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn inspection_reads_host_files_and_both_git_views() {
    let host = Host::start().await;
    let mut c = host.client().await;
    let project = tempfile::tempdir().unwrap();
    assert!(
        Command::new("git")
            .args(["init", "-q"])
            .arg(project.path())
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(project.path().join("hello.txt"), "staged\n").unwrap();
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(project.path())
            .args(["add", "hello.txt"])
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(project.path().join("hello.txt"), "working\n").unwrap();
    let id = match ask(
        &mut c,
        Request::AddProject {
            path: project.path().to_string_lossy().into_owned(),
            name: None,
        },
    )
    .await
    {
        Response::Project { project } => project.id,
        r => panic!("{r:?}"),
    };
    assert!(
        matches!(ask(&mut c, Request::ReadFile { project_id: id.clone(), path: "hello.txt".into() }).await, Response::Content { text, truncated: false } if text == "working\n")
    );
    assert!(
        matches!(ask(&mut c, Request::Files { project_id: id.clone(), path: "".into() }).await, Response::Files { entries } if entries.iter().any(|e| e.name == "hello.txt") && entries.iter().all(|e| e.name != ".git"))
    );
    assert!(
        matches!(ask(&mut c, Request::Diff { project_id: id.clone() }).await, Response::Content { text, .. } if text.contains("+working") && text.contains("+staged"))
    );
    std::fs::write(project.path().join("binary"), [0, 1, 2]).unwrap();
    assert!(matches!(
        ask(
            &mut c,
            Request::ReadFile {
                project_id: id.clone(),
                path: "binary".into()
            }
        )
        .await,
        Response::Error { .. }
    ));
    std::fs::write(project.path().join("large"), vec![b'a'; 600 * 1024]).unwrap();
    assert!(
        matches!(ask(&mut c, Request::ReadFile { project_id: id, path: "large".into() }).await, Response::Content { text, truncated: true } if text.len() == 512 * 1024)
    );
}

#[tokio::test]
async fn provider_catalog_local_binding_and_remote_sync_use_host_protocol() {
    use latte_work_protocol::{ProviderAuth, ProviderDraft, ProviderProtocol, ProviderTarget};
    use std::os::unix::fs::PermissionsExt;
    let remote = Host::start().await;
    let ssh_dir = tempfile::tempdir().unwrap();
    let ssh = ssh_dir.path().join("ssh");
    let bin = serde_json::to_string(env!("CARGO_BIN_EXE_latte-work-server")).unwrap();
    let state = serde_json::to_string(&remote.directory.path().to_string_lossy()).unwrap();
    std::fs::write(&ssh,format!("#!/usr/bin/env python3\nimport os,sys\nif 'offline-fixture' in sys.argv: sys.exit(1)\nos.execv({bin},[{bin},'connect','--state-dir',{state}])\n")).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let directory = tempfile::Builder::new()
        .prefix("lw-")
        .tempdir_in("/tmp")
        .unwrap();
    let process = Command::new(env!("CARGO_BIN_EXE_latte-work-server"))
        .args(["serve", "--state-dir"])
        .arg(directory.path())
        .env(
            "LATTE_WORK_CLAUDE",
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude.py"),
        )
        .env(
            "PATH",
            format!(
                "{}:{}",
                ssh_dir.path().display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let local = Host { directory, process };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !local.directory.path().join("control.sock").exists() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut c = local.client().await;
    let draft = ProviderDraft {
        id: None,
        name: "Central".into(),
        protocol: ProviderProtocol::AnthropicMessages,
        base_url: "https://example.test".into(),
        model: "first".into(),
        models: vec!["alternate".into()],
        auth: ProviderAuth::ApiKey,
        credential: Some("fixture-private-key".into()),
    };
    let saved = ask(
        &mut c,
        Request::SaveProvider {
            provider: draft.clone(),
        },
    )
    .await;
    let id = match &saved {
        Response::Providers {
            providers,
            bindings,
        } => {
            assert!(bindings.is_empty());
            providers[0].id.clone()
        }
        r => panic!("{r:?}"),
    };
    assert!(
        !serde_json::to_string(&saved)
            .unwrap()
            .contains("fixture-private-key")
    );
    let target = Some(ProviderTarget {
        ssh: "fixture-host".into(),
        server_path: env!("CARGO_BIN_EXE_latte-work-server").into(),
    });
    let result = ask(
        &mut c,
        Request::BindAgentProvider {
            agent: "claude".into(),
            provider_id: Some(id.clone()),
            target: target.clone(),
        },
    )
    .await;
    assert!(matches!(result,Response::Providers{bindings,..} if bindings[0].provider_id==id));
    assert!(
        matches!(ask(&mut c,Request::Providers).await,Response::Providers{bindings,..} if bindings.is_empty())
    );
    let mut r = remote.client().await;
    assert!(
        matches!(ask(&mut r, Request::Models { project_id: None, agent: "claude".into(), model: None }).await, Response::Models { models, .. } if models == ["first", "alternate"])
    );

    let project = tempfile::tempdir().unwrap();
    let session = session(&mut r, project.path()).await;
    send(&mut r, &session, "first", "provider").await;
    assert!(
        wait(&mut r, &session, Status::Completed)
            .await
            .iter()
            .any(|e| matches!(&e.event,EventKind::Text{text} if text=="fresh:first:api_key"))
    );
    let mut updated = draft;
    updated.id = Some(id.clone());
    updated.credential = None;
    updated.model = "second".into();
    ask(&mut c, Request::SaveProvider { provider: updated }).await;
    let offline = Some(ProviderTarget {
        ssh: "offline-fixture".into(),
        server_path: "/server".into(),
    });
    assert!(matches!(
        ask(
            &mut c,
            Request::BindAgentProvider {
                agent: "claude".into(),
                provider_id: Some(id.clone()),
                target: offline
            }
        )
        .await,
        Response::Error { .. }
    ));
    assert!(
        matches!(ask(&mut r,Request::Providers).await,Response::Providers{providers,..} if providers[0].model=="first")
    );
    ask(
        &mut c,
        Request::BindAgentProvider {
            agent: "claude".into(),
            provider_id: Some(id.clone()),
            target: target.clone(),
        },
    )
    .await;
    send(&mut r, &session, "second", "provider").await;
    assert!(
        wait(&mut r, &session, Status::Completed)
            .await
            .iter()
            .any(|e| matches!(&e.event,EventKind::Text{text} if text=="resumed:second:api_key"))
    );
    for protocol in [
        ProviderProtocol::OpenaiChat,
        ProviderProtocol::OpenaiResponses,
    ] {
        let provider = ProviderDraft {
            id: None,
            name: "Other".into(),
            protocol,
            base_url: "https://example.test/v1".into(),
            model: "model".into(),
            models: vec![],
            auth: ProviderAuth::Bearer,
            credential: Some("other-key".into()),
        };
        let pid = match ask(&mut c, Request::SaveProvider { provider }).await {
            Response::Providers { providers, .. } => providers.last().unwrap().id.clone(),
            _ => unreachable!(),
        };
        assert!(matches!(
            ask(
                &mut c,
                Request::BindAgentProvider {
                    agent: "claude".into(),
                    provider_id: Some(pid),
                    target: target.clone()
                }
            )
            .await,
            Response::Error { .. }
        ));
    }
    ask(
        &mut c,
        Request::BindAgentProvider {
            agent: "claude".into(),
            provider_id: None,
            target,
        },
    )
    .await;
    assert!(
        matches!(ask(&mut r,Request::Providers).await,Response::Providers{providers,bindings} if providers.is_empty()&&bindings.is_empty())
    );
    assert!(
        matches!(ask(&mut c,Request::BindAgentProvider{agent:"claude".into(),provider_id:Some(id),target:None}).await,Response::Providers{bindings,..} if bindings.len()==1)
    );
}

#[tokio::test]
async fn rename_and_remove_project_preserve_files_sessions_and_restore_identity() {
    let host = Host::start().await;
    let mut c = host.client().await;
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("keep.txt"), "keep").unwrap();
    let sid = session(&mut c, directory.path()).await;
    let pid = match ask(&mut c, Request::Projects).await {
        Response::Projects { projects } => projects[0].id.clone(),
        _ => unreachable!(),
    };
    assert!(
        matches!(ask(&mut c,Request::RenameProject{project_id:pid.clone(),name:"  Renamed  ".into()}).await,Response::Project{project} if project.name=="Renamed")
    );
    assert!(matches!(
        ask(
            &mut c,
            Request::RenameProject {
                project_id: pid.clone(),
                name: "\n".into()
            }
        )
        .await,
        Response::Error { .. }
    ));
    send(&mut c, &sid, "pending", "hang").await;
    assert!(matches!(
        ask(
            &mut c,
            Request::RemoveProject {
                project_id: pid.clone()
            }
        )
        .await,
        Response::Error { .. }
    ));
    ask(
        &mut c,
        Request::Cancel {
            session_id: sid.clone(),
        },
    )
    .await;
    wait(&mut c, &sid, Status::Stopped).await;
    assert!(
        matches!(ask(&mut c,Request::RemoveProject{project_id:pid.clone()}).await,Response::Projects{projects} if projects.is_empty())
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("keep.txt")).unwrap(),
        "keep"
    );
    let mut reconnect = host.client().await;
    assert!(
        matches!(ask(&mut reconnect,Request::Projects).await,Response::Projects{projects} if projects.is_empty())
    );
    assert!(
        matches!(ask(&mut reconnect,Request::AddProject{path:directory.path().to_string_lossy().into_owned(),name:None}).await,Response::Project{project} if project.id==pid&&project.name=="Renamed")
    );
    assert!(
        matches!(ask(&mut reconnect,Request::Sessions{project_id:pid}).await,Response::Sessions{sessions} if sessions.iter().any(|s|s.id==sid))
    );
}

#[tokio::test]
async fn models_select_per_turn_validate_and_persist_without_changing_provider() {
    use latte_work_protocol::{ProviderAuth, ProviderDraft, ProviderProtocol};
    let host = Host::start().await;
    let mut c = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let sid = session(&mut c, project.path()).await;
    let aliases = ask(
        &mut c,
        Request::Models {
            project_id: None,
            agent: "claude".into(),
            model: None,
        },
    )
    .await;
    assert!(
        matches!(aliases, Response::Models { models, provider: None, .. } if models.contains(&"sonnet".into()))
    );
    let send_model = |request: &str, model: Option<&str>, text: &str| Request::Send {
        session_id: sid.clone(),
        request_id: request.into(),
        text: text.into(),
        model: model.map(str::to_owned),
        effort: None,
    };
    assert!(matches!(
        ask(&mut c, send_model("cli", Some("sonnet"), "model")).await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut c, &sid, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text == "fresh:sonnet"))
    );
    assert!(matches!(
        ask(&mut c, send_model("reset", None, "model")).await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut c, &sid, Status::Completed).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(&e.event, EventKind::Text { text } if text == "resumed:default"))
    );
    let saved = ask(
        &mut c,
        Request::SaveProvider {
            provider: ProviderDraft {
                id: None,
                name: "Model catalog".into(),
                protocol: ProviderProtocol::AnthropicMessages,
                base_url: "https://example.test".into(),
                model: "first".into(),
                models: vec!["second".into(), "third".into()],
                auth: ProviderAuth::ApiKey,
                credential: Some("fixture-private-key".into()),
            },
        },
    )
    .await;
    let Response::Providers { providers, .. } = saved else {
        panic!("save failed")
    };
    ask(
        &mut c,
        Request::BindAgentProvider {
            agent: "claude".into(),
            provider_id: Some(providers[0].id.clone()),
            target: None,
        },
    )
    .await;
    assert!(matches!(
        ask(&mut c, send_model("invalid", Some("sonnet"), "provider")).await,
        Response::Error { .. }
    ));
    assert!(matches!(
        ask(&mut c, send_model("selected", Some("second"), "provider")).await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut c, &sid, Status::Completed).await;
    assert!(
        events.iter().any(
            |e| matches!(&e.event, EventKind::Text { text } if text == "resumed:second:api_key")
        )
    );
    assert!(matches!(
        ask(&mut c, send_model("selected", Some("second"), "provider")).await,
        Response::Accepted { duplicate: true }
    ));
    ask(
        &mut c,
        Request::BindAgentProvider {
            agent: "claude".into(),
            provider_id: None,
            target: None,
        },
    )
    .await;
    assert!(matches!(
        ask(&mut c, send_model("selected", Some("second"), "provider")).await,
        Response::Accepted { duplicate: true }
    ));
    assert!(matches!(
        ask(&mut c, send_model("selected", Some("third"), "provider")).await,
        Response::Error { message, .. } if message.contains("请求 ID 已被其他任务使用")
    ));
    assert!(matches!(
        ask(&mut c, send_model("new", Some("second"), "provider")).await,
        Response::Error { .. }
    ));
    ask(
        &mut c,
        Request::BindAgentProvider {
            agent: "claude".into(),
            provider_id: Some(providers[0].id.clone()),
            target: None,
        },
    )
    .await;
    assert!(matches!(
        ask(&mut c, send_model("selected", Some("third"), "provider")).await,
        Response::Error { .. }
    ));
    let mut reconnect = host.client().await;
    assert!(
        matches!(ask(&mut reconnect, Request::Poll { session_id: sid.clone(), after: 0.0 }).await, Response::Events { session, .. } if session.model.as_deref() == Some("second"))
    );
    assert!(
        matches!(ask(&mut c, Request::Models { project_id: None, agent: "claude".into(), model: None }).await, Response::Models { default_model: Some(model), models, .. } if model == "first" && models == ["first", "second", "third"])
    );
    assert!(matches!(
        ask(&mut c, send_model("default", None, "provider")).await,
        Response::Accepted { .. }
    ));
    let events = wait(&mut c, &sid, Status::Completed).await;
    assert!(
        events.iter().any(
            |e| matches!(&e.event, EventKind::Text { text } if text == "resumed:first:api_key")
        )
    );
}

#[tokio::test]
async fn session_menu_metadata_is_durable_and_host_scoped() {
    let host = Host::start().await;
    let mut client = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let id = session(&mut client, project.path()).await;
    assert!(
        matches!(ask(&mut client, Request::RenameSession { session_id: id.clone(), title: "Renamed".into() }).await,
        Response::Session { session } if session.title == "Renamed" && session.custom_title)
    );
    ask(
        &mut client,
        Request::PinSession {
            session_id: id.clone(),
            pinned: true,
        },
    )
    .await;
    ask(
        &mut client,
        Request::MarkSessionUnread {
            session_id: id.clone(),
            unread: true,
        },
    )
    .await;
    let mut second = host.client().await;
    assert!(matches!(ask(&mut second, Request::PinnedSessions).await,
        Response::Sessions { sessions } if sessions.len() == 1 && sessions[0].id == id && sessions[0].unread));
    let other_host = Host::start().await;
    let mut other = other_host.client().await;
    assert!(
        matches!(ask(&mut other, Request::PinnedSessions).await, Response::Sessions { sessions } if sessions.is_empty())
    );
    assert!(matches!(
        ask(
            &mut other,
            Request::RenameSession {
                session_id: id.clone(),
                title: "wrong host".into()
            }
        )
        .await,
        Response::Error { .. }
    ));
    ask(
        &mut client,
        Request::ArchiveSession {
            session_id: id.clone(),
            archived: true,
        },
    )
    .await;
    assert!(
        matches!(ask(&mut second, Request::PinnedSessions).await, Response::Sessions { sessions } if sessions.is_empty())
    );
    assert!(
        matches!(ask(&mut second, Request::Poll { session_id: id.clone(), after: 0.0 }).await,
        Response::Events { session, events, .. } if session.archived && session.title == "Renamed" && events.is_empty())
    );
    assert!(
        matches!(ask(&mut client, Request::ArchiveSession { session_id: id, archived: false }).await,
        Response::Session { session } if !session.archived && session.pinned_at.is_none())
    );
}

#[tokio::test]
async fn effort_is_applied_on_launch_resume_and_reset() {
    use latte_work_protocol::Effort;
    let host = Host::start().await;
    let mut client = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let id = session(&mut client, project.path()).await;
    assert!(
        matches!(ask(&mut client, Request::Models { project_id: None, agent: "claude".into(), model: Some("haiku".into()) }).await,
        Response::Models { effort_levels, .. } if effort_levels.is_empty())
    );
    assert!(matches!(
        ask(
            &mut client,
            Request::Send {
                session_id: id.clone(),
                request_id: "unsupported".into(),
                text: "effort".into(),
                model: Some("haiku".into()),
                effort: Some(Effort::High)
            }
        )
        .await,
        Response::Error { .. }
    ));
    for (request_id, effort, expected) in [
        ("effort-high", Some(Effort::High), "fresh:high"),
        ("effort-low", Some(Effort::Low), "resumed:low"),
        ("effort-auto", None, "resumed:auto"),
    ] {
        let send = Request::Send {
            session_id: id.clone(),
            request_id: request_id.into(),
            text: "effort".into(),
            model: None,
            effort,
        };
        assert!(matches!(
            ask(&mut client, send.clone()).await,
            Response::Accepted { duplicate: false }
        ));
        let events = wait(&mut client, &id, Status::Completed).await;
        assert!(
            events
                .iter()
                .any(|e| matches!(&e.event, EventKind::Text { text } if text == expected))
        );
        assert!(matches!(
            ask(&mut client, send).await,
            Response::Accepted { duplicate: true }
        ));
        let mut reconnect = host.client().await;
        assert!(
            matches!(ask(&mut reconnect, Request::Poll { session_id: id.clone(), after: 0.0 }).await,
            Response::Events { session, .. } if session.effort == effort)
        );
    }
}

#[tokio::test]
async fn native_model_names_are_host_project_scoped_and_do_not_override_provider_models() {
    use latte_work_protocol::{ProviderAuth, ProviderDraft, ProviderProtocol};
    let host = Host::start().await;
    let config = host.directory.path().join("claude-config");
    std::fs::create_dir(&config).unwrap();
    std::fs::write(
        config.join("settings.json"),
        serde_json::json!({"env": {
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "native-id",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Native name",
            "ANTHROPIC_API_KEY": "do-not-return-this"
        }})
        .to_string(),
    )
    .unwrap();
    let mut c = host.client().await;
    let project = tempfile::tempdir().unwrap();
    let Response::Project {
        project: registered,
    } = ask(
        &mut c,
        Request::AddProject {
            path: project.path().to_string_lossy().into_owned(),
            name: None,
        },
    )
    .await
    else {
        panic!("project registration failed")
    };
    let models = |id| Request::Models {
        agent: "claude".into(),
        model: None,
        project_id: id,
    };
    let response = ask(&mut c, models(None)).await;
    assert!(
        matches!(&response, Response::Models { models, model_labels, .. }
        if models.contains(&"sonnet".into()) && model_labels.get("sonnet").map(String::as_str) == Some("Native name"))
    );
    assert!(
        !serde_json::to_string(&response)
            .unwrap()
            .contains("do-not-return-this")
    );
    std::fs::create_dir(project.path().join(".claude")).unwrap();
    std::fs::write(
        project.path().join(".claude/settings.local.json"),
        serde_json::json!({"env": {
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Project name"
        }})
        .to_string(),
    )
    .unwrap();
    assert!(
        matches!(ask(&mut c, models(Some(registered.id.clone()))).await,
        Response::Models { model_labels, .. } if model_labels.get("sonnet").map(String::as_str) == Some("Project name"))
    );
    assert!(matches!(
        ask(&mut c, models(Some("unknown-project".into()))).await,
        Response::Error { .. }
    ));
    let Response::Providers { providers, .. } = ask(
        &mut c,
        Request::SaveProvider {
            provider: ProviderDraft {
                id: None,
                name: "Bound".into(),
                protocol: ProviderProtocol::AnthropicMessages,
                base_url: "https://example.test".into(),
                model: "sonnet".into(),
                models: vec![],
                auth: ProviderAuth::ApiKey,
                credential: Some("fixture-only".into()),
            },
        },
    )
    .await
    else {
        panic!("save failed")
    };
    ask(
        &mut c,
        Request::BindAgentProvider {
            agent: "claude".into(),
            provider_id: Some(providers[0].id.clone()),
            target: None,
        },
    )
    .await;
    assert!(matches!(ask(&mut c, models(Some(registered.id))).await,
        Response::Models { model_labels, provider: Some(_), .. } if model_labels.is_empty()));
}
