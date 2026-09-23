//! Read-only project inspection, with canonical containment and bounded output.
use anyhow::{Context, Result, bail};
use latte_work_protocol::FileEntry;
use std::{
    path::{Component, Path},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
const LIMIT: usize = 512 * 1024;
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
    let (status, c) = git(root, &["status", "--short", "--untracked-files=normal"]).await?;
    Ok((
        format!("# 工作区状态\n{status}\n# 未暂存改动\n{unstaged}\n# 已暂存改动\n{staged}"),
        a || b || c,
    ))
}
async fn git(root: &Path, args: &[&str]) -> Result<(String, bool)> {
    let mut child = Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-c", "core.quotePath=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = child
        .stdout
        .take()
        .context("git stdout missing")?
        .take((LIMIT + 1) as u64);
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), output.read_to_end(&mut bytes)).await??;
    let truncated = bytes.len() > LIMIT;
    if truncated {
        child.kill().await?;
    } else if !tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await??
        .success()
    {
        bail!("无法读取 Git 状态，请确认项目是 Git 仓库");
    }
    bytes.truncate(LIMIT);
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}
#[cfg(test)]
mod tests {
    use super::*;
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
}
