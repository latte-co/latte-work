use super::*;
use latte_work_client::request_with_app_agent_config;
use latte_work_config::ProviderStore;
use latte_work_protocol::AgentEnvironment;
use std::collections::BTreeMap;
use tokio::sync::Mutex;

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
