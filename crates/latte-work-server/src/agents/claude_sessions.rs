//! Claude SDK session metadata: bounded head/tail reads and append-only offline rename.
//! Matches the official SDK customTitle > aiTitle > summary ordering. No transcript rewrite.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const WINDOW: u64 = 64 * 1024;
#[derive(Clone)]
pub struct Title {
    pub text: String,
    pub custom: bool,
}
fn valid_title(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 200 && !value.chars().any(char::is_control)
}
fn projects() -> Result<PathBuf> {
    let config = crate::agent_environment::variable("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            crate::agent_environment::variable("HOME").map(|p| PathBuf::from(p).join(".claude"))
        })
        .context("无法确定 Claude 会话目录")?;
    Ok(config.join("projects"))
}
fn locate_in(projects: &Path, cwd: &Path, id: &str) -> Result<Option<PathBuf>> {
    uuid::Uuid::parse_str(id).context("原生会话 ID 无效")?;
    // Require the canonical UUID spelling; never use an input as a free-form path.
    let filename = format!("{}.jsonl", uuid::Uuid::parse_str(id)?);
    let canonical = cwd.canonicalize()?;
    let sanitized: String = canonical
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let root = match projects.canonicalize() {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut candidates = if sanitized.len() <= 200 {
        vec![root.join(&sanitized).join(&filename)]
    } else {
        // Native Bun and SDK hash suffixes differ for long paths; match the exact UUID
        // beneath the shared 200-character prefix, bounded and ambiguity checked.
        let prefix = format!("{}-", &sanitized[..200]);
        let mut paths = vec![];
        for (n, entry) in root.read_dir()?.enumerate() {
            if n >= 1024 {
                bail!("Claude 会话目录超出读取范围");
            }
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && entry.file_name().to_string_lossy().starts_with(&prefix)
            {
                paths.push(entry.path().join(&filename));
            }
        }
        paths
    };
    candidates.retain(|p| p.is_file());
    if candidates.len() > 1 {
        bail!("原生会话目录存在歧义");
    }
    let Some(path) = candidates.pop() else {
        return Ok(None);
    };
    let target = path.canonicalize()?;
    if !target.starts_with(&root) || path.symlink_metadata()?.file_type().is_symlink() {
        bail!("拒绝访问 Claude 会话目录外的路径");
    }
    Ok(Some(target))
}
fn read_path(path: &Path) -> Result<Option<Title>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("Claude 会话不是普通文件");
    }
    let size = metadata.len();
    let mut bytes = Vec::new();
    (&mut file).take(WINDOW).read_to_end(&mut bytes)?;
    if size > WINDOW {
        file.seek(SeekFrom::Start(size.saturating_sub(WINDOW)))?;
        bytes.push(b'\n');
        (&mut file).take(WINDOW).read_to_end(&mut bytes)?;
    }
    let mut custom = None;
    let mut generated = None;
    let mut summary = None;
    for line in bytes.split(|b| *b == b'\n') {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        for (field, slot) in [
            ("customTitle", &mut custom),
            ("aiTitle", &mut generated),
            ("summary", &mut summary),
        ] {
            if let Some(text) = value
                .get(field)
                .and_then(Value::as_str)
                .filter(|text| valid_title(text))
            {
                *slot = Some(text.trim().to_owned());
            }
        }
    }
    Ok(custom.map(|text| Title { text, custom: true }).or_else(|| {
        generated.or(summary).map(|text| Title {
            text,
            custom: false,
        })
    }))
}
pub fn read(cwd: &Path, id: &str) -> Result<Option<Title>> {
    let Some(path) = locate_in(&projects()?, cwd, id)? else {
        return Ok(None);
    };
    read_path(&path)
}

pub(super) struct ChildBytes {
    pub bytes: Vec<u8>,
    pub start: u64,
    pub truncated: bool,
}

/// Construct the native child path from registered identities, never output_file.
pub(super) fn read_child(cwd: &Path, parent: &str, child: &str) -> Result<Option<ChildBytes>> {
    if child.is_empty()
        || child.len() > 128
        || !child
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Ok(None);
    }
    let Some(parent_path) = locate_in(&projects()?, cwd, parent)? else {
        return Ok(None);
    };
    read_child_path(&parent_path, child)
}

fn read_child_path(parent: &Path, child: &str) -> Result<Option<ChildBytes>> {
    const LIMIT: u64 = 512 * 1024;
    let session_dir = parent.with_extension("");
    let directory = session_dir.join("subagents");
    for path in [&session_dir, &directory] {
        match path.symlink_metadata() {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => bail!("子会话目录不是普通目录"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }
    }
    let path = directory.join(format!("agent-{child}.jsonl"));
    let expected = match path.symlink_metadata() {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
        Ok(_) => bail!("子会话记录不是普通文件"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if directory.canonicalize()? != directory || path.canonicalize()? != path {
        bail!("拒绝读取子会话目录外的记录");
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.dev() != expected.dev()
        || metadata.ino() != expected.ino()
        || metadata.uid() != nix::unistd::Uid::current().as_raw()
    {
        bail!("子会话记录身份已改变");
    }
    let start = metadata.len().saturating_sub(LIMIT);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(LIMIT).read_to_end(&mut bytes)?;
    Ok(Some(ChildBytes {
        bytes,
        start,
        truncated: start != 0,
    }))
}
pub fn rename(cwd: &Path, id: &str, title: &str) -> Result<String> {
    let path = locate_in(&projects()?, cwd, id)?.context("未找到原生会话，标题未修改")?;
    append(&path, id, title)?;
    let actual = read_path(&path)?.context("原生标题写入后未能确认")?;
    if !actual.custom || actual.text != title.trim() {
        bail!("原生标题写入后发生变化，请核对后重试");
    }
    Ok(actual.text)
}
fn append(path: &Path, id: &str, title: &str) -> Result<()> {
    if !valid_title(title) {
        bail!("原生会话标题无效");
    }
    let expected = path.symlink_metadata()?;
    if path.canonicalize()? != path || !expected.is_file() {
        bail!("原生会话路径已改变，标题未修改");
    }
    let mut file = OpenOptions::new()
        .append(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.len() == 0
        || meta.dev() != expected.dev()
        || meta.ino() != expected.ino()
        || path.canonicalize()? != path
    {
        bail!("原生会话文件不可用，标题未修改");
    }
    // Same append-only mutation as SDK rename_session; never create a missing session.
    let mut record = serde_json::to_vec(
        &json!({"type":"custom-title","customTitle":title.trim(),"sessionId":id}),
    )?;
    record.push(b'\n');
    if file.write(&record)? != record.len() {
        bail!("原生标题写入未完成，请核对会话");
    }
    file.sync_data()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn child_record_reads_are_bounded_and_reject_symlink_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let parent = root.join("11111111-1111-4111-8111-111111111111.jsonl");
        let child_dir = parent.with_extension("").join("subagents");
        std::fs::create_dir_all(&child_dir).unwrap();
        let file = child_dir.join("agent-a123.jsonl");
        std::fs::write(&file, vec![b'x'; 600 * 1024]).unwrap();
        let bytes = super::read_child_path(&parent, "a123").unwrap().unwrap();
        assert_eq!(bytes.bytes.len(), 512 * 1024);
        assert!(bytes.truncated && bytes.start > 0);
        std::fs::remove_file(&file).unwrap();
        let secret = root.join("secret.jsonl");
        std::fs::write(&secret, "private").unwrap();
        std::os::unix::fs::symlink(&secret, &file).unwrap();
        assert!(super::read_child_path(&parent, "a123").is_err());
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_dir(&child_dir).unwrap();
        std::os::unix::fs::symlink(&root, &child_dir).unwrap();
        assert!(super::read_child_path(&parent, "a123").is_err());
        assert!(
            super::read_child(&root, "parent", "../../secret")
                .unwrap()
                .is_none()
        );
    }
    use super::*;
    #[test]
    fn native_titles_follow_sdk_priority_and_rename_preserves_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("session.jsonl");
        let original = "{\"type\":\"user\",\"message\":{\"content\":\"prompt\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"Generated title\"}\n";
        std::fs::write(&path, original).unwrap();
        assert_eq!(read_path(&path).unwrap().unwrap().text, "Generated title");
        append(
            &path,
            "11111111-1111-4111-8111-111111111111",
            "Manual title",
        )
        .unwrap();
        let title = read_path(&path).unwrap().unwrap();
        assert!(title.custom);
        assert_eq!(title.text, "Manual title");
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .starts_with(original)
        );
        append(&path, "id", "Second title").unwrap();
        assert_eq!(read_path(&path).unwrap().unwrap().text, "Second title");
        assert!(append(&dir.path().join("missing.jsonl"), "id", "No fake session").is_err());
    }
    #[test]
    fn session_paths_reject_invalid_ids_symlinks_and_keep_reads_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("project");
        std::fs::create_dir(&cwd).unwrap();
        let projects = dir.path().join("projects");
        std::fs::create_dir(&projects).unwrap();
        assert!(locate_in(&projects, &cwd, "../escape").is_err());
        let name: String = cwd
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let folder = projects.join(name);
        std::fs::create_dir(&folder).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let external = dir.path().join("private.jsonl");
        std::fs::write(&external, "private").unwrap();
        std::os::unix::fs::symlink(&external, folder.join(format!("{id}.jsonl"))).unwrap();
        assert!(locate_in(&projects, &cwd, id).is_err());
        assert!(read_path(&folder.join(format!("{id}.jsonl"))).is_err());
        let large = dir.path().join("large.jsonl");
        let mut data = vec![b'x'; (WINDOW * 3) as usize];
        data.extend(b"\n{\"aiTitle\":\"Tail title\"}\n");
        std::fs::write(&large, data).unwrap();
        assert_eq!(read_path(&large).unwrap().unwrap().text, "Tail title");
    }
}
