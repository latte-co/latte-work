//! Read-only project inspection, with canonical containment and bounded output.
use anyhow::{Context, Result, bail};
use latte_work_protocol::{ChangeSection, FileEntry, GitChange};
use std::{
    path::{Component, Path},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
const LIMIT: usize = 512 * 1024;
#[derive(Debug)]
pub(crate) struct NotGitRepository;
impl std::fmt::Display for NotGitRepository {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("此项目无 Git 分支信息")
    }
}
impl std::error::Error for NotGitRepository {}

async fn missing_repository(root: &Path, diagnostic: &[u8]) -> bool {
    // Recognize only Git's repository-discovery failure, in a fixed locale.
    // Invalid gitfiles, unsafe ownership and other command errors stay errors.
    let diagnostic = String::from_utf8_lossy(diagnostic);
    if !diagnostic.lines().any(|line| {
        line.starts_with("fatal: not a git repository (or any of the parent directories): .git")
            || line.starts_with("fatal: not a git repository (or any parent up to mount point ")
    }) {
        return false;
    }
    // Git can ignore an incomplete .git directory. Preserve that as a real
    // failure instead of declaring a broken repository an ordinary folder.
    for ancestor in root.ancestors() {
        match tokio::fs::symlink_metadata(ancestor.join(".git")).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return false,
        }
    }
    true
}
/// Resolve an explicitly chosen host path for a prompt reference only. This does
/// not grant access, read contents, or relax project browsing/read containment.
pub async fn reference(root: &Path, path: &str) -> Result<FileEntry> {
    if path.len() > 4096 || path.contains('\0') || !Path::new(path).is_absolute() {
        bail!("请输入不超过 4096 字节的绝对路径");
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        let target = tokio::fs::canonicalize(path)
            .await
            .context("路径不存在或无法访问")?;
        let metadata = tokio::fs::metadata(&target).await?;
        if !metadata.is_file() && !metadata.is_dir() {
            bail!("只能引用普通文件或目录");
        }
        let root = tokio::fs::canonicalize(root).await?;
        let reference = target.strip_prefix(&root).unwrap_or(&target);
        let path = reference.to_str().context("路径不是 UTF-8")?;
        Ok(FileEntry {
            name: target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("/")
                .into(),
            path: if path.is_empty() {
                ".".into()
            } else {
                path.into()
            },
            directory: metadata.is_dir(),
        })
    })
    .await
    .context("读取路径超时，请检查主机或文件系统")?
}
/// Project selection precedes project registration: browse directory names only,
/// under the authenticated host user's filesystem permissions. No file content.
pub fn browse_directories(path: Option<&str>) -> Result<latte_work_protocol::Response> {
    let folder = match path {
        Some(path) => std::path::PathBuf::from(path),
        None => std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .context("无法确定主目录，请输入绝对路径")?,
    };
    if !folder.is_absolute() {
        bail!("目录必须是绝对路径");
    }
    let folder = folder.canonicalize().context("目录不存在或无法访问")?;
    let path = folder.to_str().context("目录路径不是 UTF-8")?.to_owned();
    let parent = folder.parent().map(|p| p.to_string_lossy().into_owned());
    let mut entries = Vec::new();
    let mut bytes = 0;
    let mut truncated = false;
    for (count, entry) in folder.read_dir()?.enumerate() {
        if count >= 5000 || entries.len() >= 1000 || bytes >= LIMIT {
            truncated = true;
            break;
        }
        let entry = entry?;
        let Ok(metadata) = entry.path().metadata() else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(path) = entry.path().to_str().map(str::to_owned) else {
            continue;
        };
        bytes += name.len() + path.len();
        entries.push(FileEntry {
            name,
            path,
            directory: true,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(latte_work_protocol::Response::Directories {
        path,
        parent,
        entries,
        truncated,
    })
}
pub fn resolve(root: &Path, relative: &str) -> Result<std::path::PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        bail!("路径必须位于项目目录内");
    }
    let root = root.canonicalize()?;
    let target = root.join(path).canonicalize()?;
    if !target.starts_with(&root) {
        bail!("拒绝访问指向项目外部的路径");
    }
    Ok(target)
}
pub fn list(root: &Path, path: &str) -> Result<Vec<FileEntry>> {
    let folder = resolve(root, path)?;
    let mut entries = Vec::new();
    for entry in folder.read_dir()?.take(1001) {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(
            name.as_str(),
            ".git" | "node_modules" | "target" | ".DS_Store"
        ) {
            continue;
        }
        let relative = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        let Ok(target) = resolve(root, &relative) else {
            continue;
        };
        entries.push(FileEntry {
            name,
            path: relative,
            directory: target.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}
pub async fn read(root: &Path, path: &str) -> Result<(String, bool)> {
    let target = resolve(root, path)?;
    if !target.is_file() {
        bail!("不是普通文件");
    }
    let file = tokio::fs::File::open(target).await?;
    let mut bytes = Vec::new();
    file.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    let truncated = bytes.len() > LIMIT;
    bytes.truncate(LIMIT);
    if bytes.contains(&0) {
        bail!("首版仅预览文本文件");
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}
pub async fn diff(root: &Path) -> Result<(String, bool)> {
    let (unstaged, a) = git(root, &["diff", "--no-ext-diff", "--no-textconv", "--", "."]).await?;
    let (staged, b) = git(
        root,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            ".",
        ],
    )
    .await?;
    let (status, c) = git(
        root,
        &["status", "--short", "--untracked-files=normal", "--", "."],
    )
    .await?;
    Ok((
        format!("# 工作区状态\n{status}\n# 未暂存改动\n{unstaged}\n# 已暂存改动\n{staged}"),
        a || b || c,
    ))
}
/// Porcelain -z always reports repository-relative paths, including in subprojects.
/// Read one bounded snapshot, and keep project paths literal throughout Git calls.
pub async fn changes(root: &Path) -> Result<(Vec<GitChange>, bool)> {
    let (prefix, _) = git(root, &["rev-parse", "--show-prefix"]).await?;
    let prefix = prefix.strip_suffix('\n').unwrap_or(&prefix);
    let (status, mut truncated) = git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
    )
    .await?;
    let complete = status.rfind('\0').map(|end| &status[..=end]).unwrap_or("");
    let mut records = complete.split('\0');
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record.as_bytes()[2] != b' ' {
            truncated = true;
            break;
        }
        let flags = &record.as_bytes()[..2];
        let renamed = flags.iter().any(|flag| matches!(flag, b'R' | b'C'));
        let previous = if renamed { records.next() } else { None };
        let Some(path) = record[3..].strip_prefix(prefix) else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        let previous_path = previous
            .and_then(|path| path.strip_prefix(prefix))
            .map(str::to_owned);
        for (flag, section) in if flags == b"??" {
            vec![(b'?', ChangeSection::Untracked)]
        } else {
            vec![
                (flags[0], ChangeSection::Staged),
                (flags[1], ChangeSection::Unstaged),
            ]
        } {
            if flag == b' ' || flag == b'!' {
                continue;
            }
            if entries.len() >= 1000 {
                truncated = true;
                break;
            }
            entries.push(GitChange {
                path: path.into(),
                previous_path: if matches!(flag, b'R' | b'C') {
                    previous_path.clone()
                } else {
                    None
                },
                section,
                status: char::from(flag).to_string(),
            });
        }
        if entries.len() >= 1000 {
            truncated |= records.any(|record| !record.is_empty());
            break;
        }
    }
    Ok((entries, truncated))
}
pub async fn change_diff(
    root: &Path,
    path: &str,
    section: ChangeSection,
) -> Result<(String, bool)> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        bail!("路径必须位于项目目录内");
    }
    if section == ChangeSection::Untracked {
        let (text, truncated) = read(root, path).await?;
        // Plain contents, not a synthetic patch: binary and symlink checks stay in read().
        return Ok((text, truncated));
    }
    let mut args = vec![
        "diff",
        "--relative",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
    ];
    if section == ChangeSection::Staged {
        args.push("--cached");
    }
    let (entries, _) = changes(root).await?;
    let previous = entries
        .iter()
        .find(|entry| entry.path == path && entry.section == section)
        .and_then(|entry| entry.previous_path.as_deref());
    args.extend(["--", path]);
    if let Some(previous) = previous {
        args.push(previous);
    }
    git(root, &args).await
}

pub(crate) async fn git(root: &Path, args: &[&str]) -> Result<(String, bool)> {
    let mut child = Command::new("git")
        .args([
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotePath=false",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = child
        .stdout
        .take()
        .context("git stdout missing")?
        .take((LIMIT + 1) as u64);
    let mut bytes = Vec::new();
    let mut diagnostic = child
        .stderr
        .take()
        .context("git stderr missing")?
        // Read one byte beyond the 8 KiB cap to detect overflow, even on exit 0.
        .take(8193);
    let mut errors = Vec::new();
    // A full pipe must end the combined read immediately so the child can be
    // killed; waiting for the other pipe's EOF would deadlock on large output.
    let read = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::try_join!(
            async {
                output.read_to_end(&mut bytes).await?;
                anyhow::ensure!(bytes.len() <= LIMIT, "Git 输出达到读取上限");
                Ok::<_, anyhow::Error>(())
            },
            async {
                diagnostic.read_to_end(&mut errors).await?;
                anyhow::ensure!(errors.len() <= 8192, "Git 错误信息超出读取上限");
                Ok::<_, anyhow::Error>(())
            }
        )
    })
    .await?;
    let truncated = bytes.len() > LIMIT;
    if truncated || errors.len() > 8192 {
        child.kill().await?;
        if errors.len() > 8192 {
            bail!("Git 错误信息超出读取上限");
        }
    } else {
        read?;
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await??;
        if !status.success() {
            if status.code() == Some(128)
                && tokio::time::timeout(Duration::from_secs(3), missing_repository(root, &errors))
                    .await
                    .unwrap_or(false)
            {
                return Err(NotGitRepository.into());
            }
            bail!("无法读取 Git 状态，请确认项目是 Git 仓库");
        }
    }
    bytes.truncate(LIMIT);
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn git_output_limits_do_not_wait_for_the_other_pipe_to_close() {
        let root = tempfile::tempdir().unwrap();
        // git config does not require a repository. A large value fills stdout
        // while stderr stays open until the producer is killed.
        std::fs::write(
            root.path().join("config"),
            format!("[large]\nvalue = {}\n", "x".repeat(LIMIT * 4)),
        )
        .unwrap();
        let (text, truncated) = tokio::time::timeout(
            Duration::from_secs(3),
            git(root.path(), &["config", "--file", "config", "--list"]),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(truncated);
        assert_eq!(text.len(), LIMIT);
        // A local, prompt-free Git alias fills stderr instead of stdout.
        let error = tokio::time::timeout(
            Duration::from_secs(3),
            git(
                root.path(),
                &["-c", "alias.noisy=!head -c 32768 /dev/zero >&2", "noisy"],
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(!error.is::<NotGitRepository>());
        assert_eq!(error.to_string(), "Git 错误信息超出读取上限");
    }
    #[tokio::test]
    async fn git_stderr_cap_accepts_8192_bytes_and_rejects_the_sentinel_and_beyond() {
        let root = tempfile::tempdir().unwrap();
        for count in [8192, 8193, 8194] {
            let alias = format!("alias.noisy=!head -c {count} /dev/zero >&2");
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                git(root.path(), &["-c", &alias, "noisy"]),
            )
            .await
            .unwrap();
            if count == 8192 {
                assert_eq!(result.unwrap(), (String::new(), false));
            } else {
                assert_eq!(result.unwrap_err().to_string(), "Git 错误信息超出读取上限");
            }
        }
    }
    #[tokio::test]
    async fn non_git_discovery_accepts_warning_lines_but_not_other_errors_or_broken_git() {
        let root = tempfile::tempdir().unwrap();
        for fatal in [
            "fatal: not a git repository (or any of the parent directories): .git",
            "fatal: not a git repository (or any parent up to mount point /)",
        ] {
            let diagnostic = format!("warning: fixture warning\nhint: fixture hint\n{fatal}\n");
            assert!(missing_repository(root.path(), diagnostic.as_bytes()).await);
        }
        for diagnostic in [
            "warning: fatal: not a git repository (or any of the parent directories): .git",
            "warning: fixture warning\nfatal: detected dubious ownership in repository at /fixture",
            "hint: fixture hint\nfatal: invalid gitfile format: .git",
        ] {
            assert!(!missing_repository(root.path(), diagnostic.as_bytes()).await);
        }
        std::fs::create_dir(root.path().join(".git")).unwrap();
        assert!(
            !missing_repository(
                root.path(),
                b"warning: fixture warning\nfatal: not a git repository (or any of the parent directories): .git\n",
            )
            .await
        );
    }
    #[tokio::test]
    async fn non_git_discovery_is_distinct_from_broken_repository_and_command_errors() {
        let root = tempfile::tempdir().unwrap();
        let error = git(root.path(), &["rev-parse", "--show-prefix"])
            .await
            .unwrap_err();
        assert!(error.is::<NotGitRepository>(), "{error:?}");
        // Incomplete repositories must not fall back to a directory inventory.
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let error = git(root.path(), &["rev-parse", "--show-prefix"])
            .await
            .unwrap_err();
        assert!(!error.is::<NotGitRepository>());
        assert!(
            crate::task_changes::Snapshot::capture(root.path())
                .await
                .is_err()
        );
        let sub = root.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        assert!(
            !git(&sub, &["rev-parse", "--show-prefix"])
                .await
                .unwrap_err()
                .is::<NotGitRepository>()
        );
        assert!(
            !git(root.path(), &["not-a-git-command"])
                .await
                .unwrap_err()
                .is::<NotGitRepository>()
        );
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join(".git"), "broken gitfile").unwrap();
        assert!(
            !git(other.path(), &["rev-parse", "--show-prefix"])
                .await
                .unwrap_err()
                .is::<NotGitRepository>()
        );
    }
    #[tokio::test]
    async fn explicit_references_resolve_without_expanding_project_access() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("中文 file.txt");
        std::fs::write(&file, "reference only").unwrap();
        let reference_file = reference(root.path(), file.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            reference_file.path,
            file.canonicalize().unwrap().to_str().unwrap()
        );
        assert!(!reference_file.directory);
        assert!(
            reference(root.path(), outside.path().to_str().unwrap())
                .await
                .unwrap()
                .directory
        );
        std::fs::write(root.path().join("inside"), "text").unwrap();
        assert_eq!(
            reference(root.path(), root.path().join("inside").to_str().unwrap())
                .await
                .unwrap()
                .path,
            "inside"
        );
        assert_eq!(
            reference(root.path(), root.path().to_str().unwrap())
                .await
                .unwrap()
                .path,
            "."
        );
        std::os::unix::fs::symlink(&file, root.path().join("link")).unwrap();
        assert_eq!(
            reference(root.path(), root.path().join("link").to_str().unwrap())
                .await
                .unwrap()
                .path,
            reference_file.path
        );
        assert!(resolve(root.path(), "link").is_err());
        assert!(read(root.path(), &reference_file.path).await.is_err());
        assert!(list(root.path(), outside.path().to_str().unwrap()).is_err());
        for invalid in [
            "relative",
            "../escape",
            "/missing/latte-reference",
            "/nul\0path",
        ] {
            assert!(reference(root.path(), invalid).await.is_err());
        }
        assert!(
            reference(root.path(), &format!("/{}", "x".repeat(4096)))
                .await
                .is_err()
        );
        let socket = outside.path().join("socket");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        assert!(
            reference(root.path(), socket.to_str().unwrap())
                .await
                .is_err()
        );
    }
    #[test]
    fn directory_picker_bounds_large_listings_and_rejects_files() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..1001 {
            std::fs::create_dir(root.path().join(i.to_string())).unwrap();
        }
        let response = browse_directories(root.path().to_str()).unwrap();
        assert!(
            matches!(response, latte_work_protocol::Response::Directories { entries, truncated: true, .. } if entries.len() == 1000)
        );
        let file = root.path().join("file");
        std::fs::write(&file, "not a folder").unwrap();
        assert!(browse_directories(file.to_str()).is_err());
    }
    #[test]
    fn traversal_and_symlink_escape_are_denied() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(resolve(root.path(), "../x").is_err());
        assert!(resolve(root.path(), "/etc/passwd").is_err());
        assert!(resolve(root.path(), "escape").is_err());
        std::fs::write(root.path().join("ok"), "text").unwrap();
        assert!(resolve(root.path(), "ok").is_ok());
    }
    #[tokio::test]
    async fn changes_are_project_scoped_and_preserve_unusual_paths() {
        let root = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(root.path())
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "-q"]);
        run(&["config", "user.name", "Fixture"]);
        run(&["config", "user.email", "fixture@example.test"]);
        let sub = root.path().join("project");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("existing.txt"), "original\n").unwrap();
        std::fs::write(sub.join("old.txt"), "rename me\n").unwrap();
        std::fs::write(root.path().join("outside.txt"), "outside\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "initial"]);
        std::fs::write(sub.join("existing.txt"), "staged\n").unwrap();
        run(&["add", "project/existing.txt"]);
        std::fs::write(sub.join("existing.txt"), "working\n").unwrap();
        run(&["mv", "project/old.txt", "project/renamed.txt"]);
        let unusual = "中文 space\nfile.txt";
        std::fs::write(sub.join(unusual), "untracked\n").unwrap();
        std::fs::write(root.path().join("outside.txt"), "changed\n").unwrap();
        std::fs::write(root.path().join("outside-new.txt"), "new\n").unwrap();
        let (entries, truncated) = changes(&sub).await.unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 4);
        assert!(entries.iter().all(|entry| !entry.path.contains("outside") && !entry.path.starts_with("project/")));
        assert!(
            entries
                .iter()
                .any(|entry| entry.path == unusual && entry.section == ChangeSection::Untracked)
        );
        assert!(entries.iter().any(|entry| entry.path == "renamed.txt"
            && entry.previous_path.as_deref() == Some("old.txt")));
        assert!(
            change_diff(&sub, "existing.txt", ChangeSection::Staged)
                .await
                .unwrap()
                .0
                .contains("+staged")
        );
        assert!(
            change_diff(&sub, "existing.txt", ChangeSection::Unstaged)
                .await
                .unwrap()
                .0
                .contains("+working")
        );
        assert_eq!(
            change_diff(&sub, unusual, ChangeSection::Untracked)
                .await
                .unwrap()
                .0,
            "untracked\n"
        );
        assert!(!diff(&sub).await.unwrap().0.contains("outside"));
        for path in ["../outside.txt", "/etc/passwd", ":(top)*", ""] {
            // Magic syntax is a literal filename, never a pathspec escape.
            let result = change_diff(&sub, path, ChangeSection::Unstaged).await;
            if path.starts_with(':') {
                assert_eq!(result.unwrap().0, "");
            } else {
                assert!(result.is_err());
            }
        }
        std::os::unix::fs::symlink(root.path().join("outside.txt"), sub.join("link")).unwrap();
        assert!(
            change_diff(&sub, "link", ChangeSection::Untracked)
                .await
                .is_err()
        );
        std::fs::write(sub.join("binary"), [0, 1, 2]).unwrap();
        assert!(
            change_diff(&sub, "binary", ChangeSection::Untracked)
                .await
                .is_err()
        );
        std::fs::write(sub.join("large"), vec![b'a'; LIMIT + 10]).unwrap();
        assert!(
            change_diff(&sub, "large", ChangeSection::Untracked)
                .await
                .unwrap()
                .1
        );
    }
}
