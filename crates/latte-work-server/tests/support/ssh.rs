//! Real OpenSSH transport coverage. The launcher supplies a disposable loopback sshd.
use super::*;
use latte_work_protocol::{SkillScope, SkillState};

#[tokio::test]
#[ignore = "requires scripts/test-ssh-skills.py and an isolated OpenSSH daemon"]
async fn global_skills_over_real_ssh_are_isolated_reversible_and_reconnectable() {
    assert_eq!(std::env::var("LATTE_WORK_TEST_SSH").as_deref(), Ok("1"));
    let roots = tempfile::tempdir().unwrap();
    let local_home = roots.path().join("local-home");
    let remote_home = roots.path().join("remote-home");
    let skill = |home: &Path, slug: &str| {
        let directory = home.join(".agents/skills").join(slug);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {slug}\ndescription: SSH fixture\n---\nBody"),
        )
        .unwrap();
    };
    skill(&local_home, "local-only");
    skill(&remote_home, "remote-only");
    let local = Host::start_with_environment(&[("HOME", local_home.as_os_str())]).await;
    let remote = Host::start_with_environment(&[("HOME", remote_home.as_os_str())]).await;
    let wrapper = roots.path().join("remote-server");
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {} connect --state-dir {}\n",
            quote(env!("CARGO_BIN_EXE_latte-work-server")),
            quote(remote.directory.path().to_str().unwrap())
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let binary = wrapper.to_str().unwrap();
    assert!(
        Client::ssh("latte-skill-badkey", binary).await.is_err(),
        "mismatched host key must fail"
    );
    let mut client = Client::ssh("latte-skill-test", binary).await.unwrap();
    assert_ne!(client.server_id(), local.client().await.server_id());
    assert!(matches!(
        ask(&mut client, Request::Hello { version: VERSION }).await,
        Response::Hello {
            skill_management: true,
            ..
        }
    ));
    let Response::Skills { skills, .. } =
        ask(&mut client, Request::Skills { project_id: None }).await
    else {
        panic!("remote catalog")
    };
    let entry = skills.iter().find(|s| s.name == "remote-only").unwrap();
    assert!(!skills.iter().any(|s| s.name == "local-only"));
    let id = entry.id.clone();
    for (expected, state) in [
        (SkillState::Enabled, SkillState::Disabled),
        (SkillState::Disabled, SkillState::Uninstalled),
        (SkillState::Uninstalled, SkillState::Enabled),
    ] {
        let Response::Skills { skills, .. } = ask(
            &mut client,
            Request::SetSkillState {
                project_id: None,
                id: id.clone(),
                expected_state: expected,
                state,
            },
        )
        .await
        else {
            panic!("remote mutation")
        };
        assert_eq!(skills.iter().find(|s| s.id == id).unwrap().state, state);
        assert!(
            local_home
                .join(".agents/skills/local-only/SKILL.md")
                .is_file()
        );
        assert!(!local_home.join(".agents/skills/remote-only").exists());
    }
    let source = roots.path().join("imported");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(
        source.join("SKILL.md"),
        "---\nname: imported\n---\nImport body",
    )
    .unwrap();
    std::fs::write(source.join("resource.txt"), "complete package").unwrap();
    assert!(matches!(
        ask(
            &mut client,
            Request::InstallSkill {
                project_id: None,
                scope: SkillScope::System,
                path: source.to_str().unwrap().into()
            }
        )
        .await,
        Response::Skills { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(remote_home.join(".agents/skills/imported/resource.txt")).unwrap(),
        "complete package"
    );
    assert!(!local_home.join(".agents/skills/imported").exists());
    let body = b"---\nname: ssh-upload\n---\nUploaded over SSH";
    let Response::AttachmentUpload { id: upload_id } = ask(
        &mut client,
        Request::BeginAttachment {
            name: "SKILL.md".into(),
            size: body.len() as u64,
        },
    )
    .await
    else {
        panic!("SSH upload")
    };
    assert!(matches!(
        ask(
            &mut client,
            Request::AttachmentChunk {
                id: upload_id.clone(),
                offset: 0,
                data: body.to_vec()
            }
        )
        .await,
        Response::Ok
    ));
    let Response::FileReference { entry } =
        ask(&mut client, Request::FinishAttachment { id: upload_id }).await
    else {
        panic!("SSH finish")
    };
    assert!(matches!(
        ask(
            &mut client,
            Request::ImportSkillFiles {
                name: "ssh-upload".into(),
                files: vec![latte_work_protocol::SkillImportFile {
                    path: "SKILL.md".into(),
                    attachment: entry.path
                }]
            }
        )
        .await,
        Response::Skills { .. }
    ));
    assert!(
        remote_home
            .join(".agents/skills/ssh-upload/SKILL.md")
            .is_file()
    );
    assert!(!local_home.join(".agents/skills/ssh-upload").exists());
    drop(client);
    let mut client = Client::ssh("latte-skill-test", binary).await.unwrap();
    assert!(
        matches!(ask(&mut client, Request::SkillDetail { project_id: None, id }).await,
        Response::SkillDetail { skill, markdown } if skill.state == SkillState::Enabled && markdown.contains("Body"))
    );
    let Response::Skills { skills, .. } = ask(
        &mut local.client().await,
        Request::Skills { project_id: None },
    )
    .await
    else {
        panic!("local catalog")
    };
    assert!(skills.iter().any(|s| s.name == "local-only"));
    assert!(
        !skills
            .iter()
            .any(|s| s.name == "remote-only" || s.name == "imported")
    );
    assert!(
        matches!(ask(&mut client, Request::Projects).await, Response::Projects { projects } if projects.is_empty())
    );
    assert!(
        matches!(ask(&mut client, Request::RecentSessions { before: None }).await,
        Response::RecentSessions { sessions, .. } if sessions.is_empty())
    );
}
