//! Durable pre-request worktree baselines with deadline-bound capture. Read-only inspection never
//! changes the user's index, refs or files. Shared-directory attribution is temporal.
use crate::{
    files,
    snapshot_storage::{self, Contents, Object},
    store::now,
};
use anyhow::{Context, Result, bail};
use latte_work_protocol::{ChangeSummary, TaskChange};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
// Only the wire preview is capped; captured files and statistics are complete.
const DIFF_PREVIEW_LIMIT: usize = 512 * 1024;

async fn read_chunks(mut input: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let count = input.read(&mut chunk).await?;
        if count == 0 {
            return Ok(bytes);
        }
        bytes.try_reserve(count).context("无法分配文件快照内存")?;
        bytes.extend_from_slice(&chunk[..count]);
        tokio::task::yield_now().await;
    }
}

async fn git_paths(root: &Path, excluded: Option<&Path>) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command.args([
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--full-name",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--exclude=.venv/",
        "--exclude=venv/",
        "--exclude=__pycache__/",
        "--exclude=dist/",
    ]);
    if let Some(relative) = excluded
        .and_then(|path| path.strip_prefix(root).ok())
        .filter(|path| !path.as_os_str().is_empty())
    {
        let mut pattern = String::from("--exclude=/");
        for c in relative.to_string_lossy().chars() {
            if matches!(c, '*' | '?' | '[' | ']' | '\\') {
                pattern.push('\\');
            }
            pattern.push(c);
        }
        pattern.push('/');
        command.arg(pattern);
    }
    let mut child = command
        .args(["--", "."])
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().context("git stdout missing")?;
    let mut stderr = child
        .stderr
        .take()
        .context("git stderr missing")?
        .take(8193);
    let (paths, ()) = tokio::try_join!(read_chunks(stdout), async {
        let mut errors = Vec::new();
        stderr.read_to_end(&mut errors).await?;
        anyhow::ensure!(errors.len() <= 8192, "Git 错误信息超出读取上限");
        Ok::<_, anyhow::Error>(())
    })?;
    anyhow::ensure!(child.wait().await?.success(), "无法枚举项目文件");
    Ok(paths)
}
fn no_symlink_ancestors(root: &Path, relative: &Path) -> Result<()> {
    let mut path = root.to_path_buf();
    if path.symlink_metadata()?.file_type().is_symlink() {
        bail!("拒绝采集符号链接目录");
    }
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            bail!("路径必须位于项目目录内");
        }
        path.push(component);
        if path.symlink_metadata()?.file_type().is_symlink() {
            bail!("拒绝采集符号链接路径");
        }
    }
    Ok(())
}
fn if_present<T>(result: Result<T>) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
async fn inventory_directory(root: &Path, path: &Path) -> Result<Option<tokio::fs::ReadDir>> {
    if_present(
        async {
            no_symlink_ancestors(root, path.strip_prefix(root)?)?;
            Ok(tokio::fs::read_dir(path).await?)
        }
        .await,
    )
}
async fn inventory_entry_type(
    root: &Path,
    entry: &tokio::fs::DirEntry,
) -> Result<Option<std::fs::FileType>> {
    if_present(
        async {
            let kind = entry.file_type().await?;
            if !kind.is_symlink() {
                let path = entry.path();
                no_symlink_ancestors(root, path.strip_prefix(root)?)?;
                files::resolve(
                    root,
                    path.strip_prefix(root)?
                        .to_str()
                        .context("文件路径不是 UTF-8")?,
                )?;
            }
            Ok(kind)
        }
        .await,
    )
}
fn decode_git_paths(
    bytes: &[u8],
    prefix: &str,
    root: &Path,
    excluded: Option<&Path>,
) -> (Vec<String>, bool) {
    let mut paths = Vec::new();
    let mut partial = false;
    for raw in bytes.split(|b| *b == 0).filter(|raw| !raw.is_empty()) {
        match std::str::from_utf8(raw) {
            Ok(path) => {
                if let Some(path) = path.strip_prefix(prefix)
                    && !excluded.is_some_and(|excluded| root.join(path).starts_with(excluded))
                {
                    paths.push(path.to_owned());
                }
            }
            Err(_) => partial = true,
        }
    }
    (paths, partial)
}
#[cfg(test)]
async fn inventory(root: &Path) -> Result<(Vec<String>, bool)> {
    inventory_with(root, None).await
}
async fn inventory_with(root: &Path, excluded: Option<&Path>) -> Result<(Vec<String>, bool)> {
    let canonical = root.canonicalize()?;
    let (inside, truncated) = match files::git(root, &["rev-parse", "--is-inside-work-tree"]).await
    {
        Ok(result) => result,
        Err(error) if error.is::<files::NotGitRepository>() => (String::new(), false),
        Err(error) => return Err(error),
    };
    if inside.trim() == "true" && !truncated {
        let (prefix, a) = files::git(root, &["rev-parse", "--show-prefix"]).await?;
        let paths = git_paths(&canonical, excluded).await?;
        let (paths, partial) =
            decode_git_paths(&paths, prefix.trim_end_matches('\n'), &canonical, excluded);
        return Ok((paths, a || partial));
    }
    let mut directories = vec![root.to_path_buf()];
    let mut paths = Vec::new();
    let mut truncated = false;
    while let Some(directory) = directories.pop() {
        if let Some(path) = if_present(directory.canonicalize().map_err(Into::into))? {
            if excluded.is_some_and(|excluded| path.starts_with(excluded)) {
                continue;
            }
        } else {
            continue;
        }
        let Some(mut entries) = inventory_directory(root, &directory).await? else {
            continue;
        };
        while let Some(entry) =
            if_present(entries.next_entry().await.map_err(Into::into))?.flatten()
        {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                truncated = true;
                continue;
            };
            if matches!(
                name,
                ".git"
                    | "node_modules"
                    | "target"
                    | ".DS_Store"
                    | ".venv"
                    | "venv"
                    | "__pycache__"
                    | "dist"
            ) {
                continue;
            }
            let Some(kind) = inventory_entry_type(root, &entry).await? else {
                continue;
            };
            if kind.is_symlink() {
                truncated = true;
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                directories.push(path);
            } else if kind.is_file() {
                paths.push(
                    path.strip_prefix(root)?
                        .to_str()
                        .context("文件路径不是 UTF-8")?
                        .to_owned(),
                );
            } else {
                truncated = true;
            }
        }
    }
    paths.sort();
    Ok((paths, truncated))
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub at: f64,
    #[serde(default)]
    root_identity: Option<(u64, u64)>,
    files: BTreeMap<String, Option<Contents>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest: Option<Object>,
    #[serde(skip)]
    storage: Option<PathBuf>,
    #[serde(default)]
    modes: BTreeMap<String, u32>,
    pub truncated: bool,
    pub unavailable: Option<String>,
}
impl Snapshot {
    pub fn unavailable(message: String) -> Self {
        Self {
            at: now(),
            root_identity: None,
            files: BTreeMap::new(),
            manifest: None,
            storage: None,
            modes: BTreeMap::new(),
            truncated: false,
            unavailable: Some(message),
        }
    }
    pub fn migrate_legacy(mut self, storage: &Path) -> Result<Self> {
        self.attach(storage);
        if self.manifest.is_some() {
            self.materialized()?;
            return Ok(self);
        }
        for contents in self.files.values_mut().flatten() {
            if let Contents::Legacy(bytes) = contents {
                *contents = Contents::Object(snapshot_storage::save_bytes(storage, bytes)?);
            }
        }
        self.persist()
    }
    pub fn referenced_objects(&self, keys: &mut std::collections::HashSet<String>) -> Result<()> {
        if let Some(manifest) = &self.manifest {
            keys.insert(manifest.key().to_owned());
        }
        for contents in self.materialized()?.files.values().flatten() {
            if let Some(object) = contents.object() {
                keys.insert(object.key().to_owned());
            }
        }
        Ok(())
    }
    pub fn attach(&mut self, storage: &Path) {
        self.storage = Some(storage.to_owned());
        if let Some(object) = &mut self.manifest {
            object.attach(storage)
        }
        for contents in self.files.values_mut().flatten() {
            contents.attach(storage)
        }
    }
    fn materialized(&self) -> Result<Self> {
        let Some(manifest) = &self.manifest else {
            return Ok(self.clone());
        };
        let mut result: Self = manifest.read()?;
        if let Some(storage) = &self.storage {
            result.attach(storage)
        }
        result.manifest = None;
        Ok(result)
    }
    fn persist(mut self) -> Result<Self> {
        if self.manifest.is_some() {
            return Ok(self);
        }
        if let Some(storage) = &self.storage {
            let object = snapshot_storage::save_json(storage, &self)?;
            self.files.clear();
            self.modes.clear();
            self.manifest = Some(object);
            // Older daemons ignore the new object reference. Leave an explicit
            // unavailable marker and no root identity so they cannot infer an
            // empty baseline or admit an undo after a binary downgrade.
            self.unavailable = Some("快照使用独立存储，请使用新版 Server 读取。".into());
            self.root_identity = None;
        }
        Ok(self)
    }
    pub async fn capture_stored(root: &Path, storage: &Path) -> Result<Self> {
        Self::capture_with(root, Some(storage)).await
    }
    #[cfg(test)]
    pub async fn capture(root: &Path) -> Result<Self> {
        Self::capture_with(root, None).await
    }
    async fn capture_with(root: &Path, storage: Option<&Path>) -> Result<Self> {
        tokio::time::timeout(Duration::from_secs(12), async {
            // Git keeps its tracked/ignored-file semantics. Ordinary directories
            // use a symlink-free inventory. Both retain every readable file.
            let excluded = storage.and_then(Path::parent);
            anyhow::ensure!(
                !excluded.is_some_and(|state| root
                    .canonicalize()
                    .is_ok_and(|root| root.starts_with(state))),
                "项目目录位于 Server 状态目录内，无法安全采集文件快照"
            );
            let (paths, inventory_truncated) = inventory_with(root, excluded).await?;
            let root_metadata = std::fs::metadata(root)?;
            let mut snapshot = Self {
                at: now(),
                root_identity: Some((root_metadata.dev(), root_metadata.ino())),
                files: BTreeMap::new(),
                manifest: None,
                storage: storage.map(Path::to_owned),
                modes: BTreeMap::new(),
                truncated: inventory_truncated,
                unavailable: None,
            };
            for path in &paths {
                let path = path.as_str();
                if snapshot.files.contains_key(path) {
                    continue;
                }
                let target = root.join(path);
                let metadata = match target.symlink_metadata() {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        snapshot.files.insert(path.into(), None);
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if metadata.file_type().is_symlink() {
                    snapshot.truncated = true;
                    continue;
                }
                let Some(target) = if_present(files::resolve(root, path))? else {
                    snapshot.files.insert(path.into(), None);
                    continue;
                };
                if !target.is_file() {
                    snapshot.truncated = true;
                    continue;
                }
                let Some(file) =
                    if_present(tokio::fs::File::open(target).await.map_err(Into::into))?
                else {
                    snapshot.files.insert(path.into(), None);
                    continue;
                };
                let bytes = if let Some(storage) = storage {
                    Contents::Object(snapshot_storage::save_file(storage, file).await?)
                } else {
                    Contents::Legacy(read_chunks(file).await?)
                };
                snapshot.modes.insert(path.into(), metadata.mode());
                snapshot.files.insert(path.into(), Some(bytes));
            }
            let root_metadata = std::fs::metadata(root)?;
            if snapshot.root_identity != Some((root_metadata.dev(), root_metadata.ino())) {
                bail!("项目目录在采集时已改变，请核对工作区");
            }
            tokio::task::spawn_blocking(move || snapshot.persist())
                .await
                .context("保存快照对象失败")?
        })
        .await
        .context("读取任务变更基线超时")?
    }
    pub async fn summary(&self, root: &Path) -> Result<ChangeSummary> {
        if self.manifest.is_none() && self.unavailable.is_some() {
            return Ok(self.empty_summary());
        }
        let current = Self::capture_with(root, self.storage.as_deref()).await?;
        self.compare(&current).await
    }
    pub async fn compare(&self, current: &Self) -> Result<ChangeSummary> {
        let before = self.clone();
        let after = current.clone();
        tokio::task::spawn_blocking(move || {
            tokio::runtime::Handle::current().block_on(async move {
                before
                    .materialized()?
                    .compare_loaded(&after.materialized()?)
                    .await
            })
        })
        .await
        .context("比较快照失败")?
    }
    async fn compare_loaded(&self, current: &Self) -> Result<ChangeSummary> {
        if self.root_identity.is_some()
            && current.root_identity.is_some()
            && self.root_identity != current.root_identity
        {
            bail!("项目目录已改变，无法确认本轮变更");
        }
        let mut result = self.empty_summary();
        result.truncated |= current.truncated;
        if self.unavailable.is_some() || current.unavailable.is_some() {
            result.unavailable = self
                .unavailable
                .clone()
                .or_else(|| current.unavailable.clone());
            return Ok(result);
        }
        let temp = tempfile::tempdir()?;
        let before = temp.path().join("before");
        let after = temp.path().join("after");
        std::fs::create_dir(&before)?;
        std::fs::create_dir(&after)?;
        let mut paths: Vec<_> = self
            .files
            .keys()
            .chain(current.files.keys())
            .cloned()
            .collect();
        paths.sort();
        paths.dedup();
        for path in paths {
            let old = self.files.get(&path).and_then(Option::as_ref);
            let new = current.files.get(&path).and_then(Option::as_ref);
            if old == new {
                continue;
            }
            // Missing from a bounded snapshot is unknown, never a fabricated deletion.
            if (old.is_some() && !current.files.contains_key(&path) && current.truncated)
                || (new.is_some() && !self.files.contains_key(&path) && self.truncated)
            {
                result.truncated = true;
                continue;
            }
            let index = result.entries.len();
            if let Some(bytes) = old {
                bytes.write_to(&before.join(index.to_string()))?;
            }
            if let Some(bytes) = new {
                bytes.write_to(&after.join(index.to_string()))?;
            }
            result.entries.push(TaskChange {
                path,
                status: if old.is_none() {
                    "A"
                } else if new.is_none() {
                    "D"
                } else {
                    "M"
                }
                .into(),
                added: None,
                removed: None,
            });
        }
        if result.entries.is_empty() {
            return Ok(result);
        }
        let (stats, truncated) = no_index(&before, &after, true).await?;
        result.truncated |= truncated;
        let mut records = stats.split('\0');
        while let Some(line) = records.next().filter(|line| !line.is_empty()) {
            let mut fields = line.splitn(3, '\t');
            let (Some(added), Some(removed), Some(path)) =
                (fields.next(), fields.next(), fields.next())
            else {
                result.truncated = true;
                break;
            };
            let path = if path.is_empty() {
                let (Some(old), Some(new)) = (records.next(), records.next()) else {
                    result.truncated = true;
                    break;
                };
                if new == "/dev/null" { old } else { new }
            } else {
                path
            };
            let Some(entry) = path
                .rsplit('/')
                .next()
                .and_then(|p| p.parse::<usize>().ok())
                .and_then(|i| result.entries.get_mut(i))
            else {
                result.truncated = true;
                continue;
            };
            entry.added = added.parse().ok();
            entry.removed = removed.parse().ok();
            match (entry.added, entry.removed) {
                (Some(a), Some(r)) => {
                    result.added += a;
                    result.removed += r;
                }
                _ => result.binary_files += 1,
            }
        }
        Ok(result)
    }
    fn empty_summary(&self) -> ChangeSummary {
        ChangeSummary {
            total_files: None,
            next_offset: None,
            offset: None,
            entries: vec![],
            added: 0,
            removed: 0,
            binary_files: 0,
            truncated: self.truncated,
            baseline_at: Some(self.at),
            unavailable: self.unavailable.clone(),
        }
    }
    pub async fn patch(&self, root: &Path, path: &str) -> Result<(String, bool)> {
        let current = Self::capture_with(root, self.storage.as_deref()).await?;
        self.patch_between(&current, path).await
    }
    pub async fn patch_between(&self, current: &Self, path: &str) -> Result<(String, bool)> {
        let before = self.clone();
        let after = current.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            tokio::runtime::Handle::current().block_on(async move {
                before
                    .materialized()?
                    .patch_loaded(&after.materialized()?, &path)
                    .await
            })
        })
        .await
        .context("读取快照差异失败")?
    }
    async fn patch_loaded(&self, current: &Self, path: &str) -> Result<(String, bool)> {
        validate_path(path)?;
        if let Some(error) = self.unavailable.as_ref().or(current.unavailable.as_ref()) {
            bail!("{error}");
        }
        let old = self.files.get(path).and_then(Option::as_ref);
        let new = current.files.get(path).and_then(Option::as_ref);
        if old == new
            || (old.is_some() && !current.files.contains_key(path) && current.truncated)
            || (new.is_some() && !self.files.contains_key(path) && self.truncated)
        {
            bail!("文件不属于本轮已记录的变更");
        }
        let temp = tempfile::tempdir()?;
        let before = temp.path().join("before");
        let after = temp.path().join("after");
        if let Some(bytes) = old {
            bytes.write_to(&before)?;
        }
        if let Some(bytes) = new {
            bytes.write_to(&after)?;
        }
        let old_path = if old.is_some() {
            before.as_path()
        } else {
            Path::new("/dev/null")
        };
        let new_path = if new.is_some() {
            after.as_path()
        } else {
            Path::new("/dev/null")
        };
        let (patch, truncated) = no_index(old_path, new_path, false).await?;
        Ok((
            patch
                .replace(&before.to_string_lossy().to_string(), &format!("/{path}"))
                .replace(&after.to_string_lossy().to_string(), &format!("/{path}")),
            truncated,
        ))
    }
}
fn validate_path(path: &str) -> Result<()> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
    {
        bail!("路径必须位于项目目录内");
    }
    Ok(())
}
/// Retain only changed bytes after completion; historical previews never read live files.
#[derive(Clone, Serialize, Deserialize)]
pub struct FrozenTurn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_summary: Option<SummaryData>,
    pub changes: latte_work_protocol::TurnChanges,
    before: Snapshot,
    after: Snapshot,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum SummaryData {
    Object(Object),
    Inline(Box<ChangeSummary>),
}
impl SummaryData {
    fn read(&self) -> Result<ChangeSummary> {
        match self {
            Self::Object(o) => o.read(),
            Self::Inline(s) => Ok((**s).clone()),
        }
    }
}
/// Presentation pages are independent of complete capture and undo state.
pub fn summary_page(summary: &ChangeSummary, offset: u32) -> Result<ChangeSummary> {
    let offset = offset as usize;
    anyhow::ensure!(offset <= summary.entries.len(), "文件列表游标无效");
    let mut result = ChangeSummary {
        entries: Vec::new(),
        total_files: None,
        next_offset: None,
        offset: None,
        added: summary.added,
        removed: summary.removed,
        binary_files: summary.binary_files,
        truncated: summary.truncated,
        baseline_at: summary.baseline_at,
        unavailable: summary.unavailable.clone(),
    };
    let mut bytes = 0;
    for entry in summary.entries.iter().skip(offset).take(64) {
        let size = serde_json::to_vec(entry)?.len();
        anyhow::ensure!(size <= 64 * 1024, "文件路径超出展示范围");
        if bytes + size > 64 * 1024 {
            break;
        }
        result.entries.push(entry.clone());
        bytes += size;
    }
    let end = offset + result.entries.len();
    if offset > 0 || end < summary.entries.len() {
        result.total_files = Some(u32::try_from(summary.entries.len())?);
        result.offset = Some(offset as u32);
        result.next_offset = if end < summary.entries.len() {
            Some(u32::try_from(end)?)
        } else {
            None
        };
    }
    Ok(result)
}
impl FrozenTurn {
    pub async fn freeze(
        request_id: String,
        before: Snapshot,
        after: Snapshot,
        interrupted: bool,
        background_pending: bool,
    ) -> Result<Self> {
        tokio::task::spawn_blocking(move || {
            tokio::runtime::Handle::current().block_on(Self::freeze_inner(
                request_id,
                before,
                after,
                interrupted,
                background_pending,
            ))
        })
        .await
        .context("保存本轮快照失败")?
    }
    async fn freeze_inner(
        request_id: String,
        mut before: Snapshot,
        mut after: Snapshot,
        interrupted: bool,
        background_pending: bool,
    ) -> Result<Self> {
        before = before.materialized()?;
        after = after.materialized()?;
        let summary = before.compare_loaded(&after).await?;
        let paths: std::collections::HashSet<_> =
            summary.entries.iter().map(|e| e.path.as_str()).collect();
        before.files.retain(|path, _| paths.contains(path.as_str()));
        after.files.retain(|path, _| paths.contains(path.as_str()));
        before
            .modes
            .retain(|path, _| before.files.contains_key(path));
        after.modes.retain(|path, _| after.files.contains_key(path));
        let page = summary_page(&summary, 0)?;
        let full_summary = if page.next_offset.is_some() {
            Some(if let Some(storage) = &before.storage {
                SummaryData::Object(snapshot_storage::save_json(storage, &summary)?)
            } else {
                SummaryData::Inline(Box::new(summary))
            })
        } else {
            None
        };
        Ok(Self {
            full_summary,
            changes: latte_work_protocol::TurnChanges {
                request_id,
                summary: page,
                interrupted,
                background_pending,
                undo: latte_work_protocol::TurnUndoStatus::Ready,
            },
            before: before.persist()?,
            after: after.persist()?,
        })
    }
    pub async fn page_for_async(
        &self,
        offset: Option<u32>,
        path: Option<&str>,
    ) -> Result<ChangeSummary> {
        let turn = self.clone();
        let path = path.map(str::to_owned);
        tokio::task::spawn_blocking(move || turn.page_for(offset, path.as_deref()))
            .await
            .context("读取文件分页失败")?
    }
    pub async fn check_undo(self, root: PathBuf, restore: bool) -> Result<Self> {
        tokio::task::spawn_blocking(move || {
            if restore {
                self.restore(&root)?;
            } else {
                self.validate_undo(&root)?;
            }
            Ok(self)
        })
        .await
        .context("核对撤销快照失败")?
    }
    pub fn page_for(&self, offset: Option<u32>, path: Option<&str>) -> Result<ChangeSummary> {
        let full = if let Some(summary) = &self.full_summary {
            summary.read()?
        } else {
            self.changes.summary.clone()
        };
        let offset = if let Some(offset) = offset {
            offset
        } else if let Some(path) = path {
            let index = full
                .entries
                .iter()
                .position(|entry| entry.path == path)
                .unwrap_or(0);
            let start = (index / 64) * 64;
            let first = summary_page(&full, u32::try_from(start)?)?;
            u32::try_from(if first.entries.iter().any(|entry| entry.path == path) {
                start
            } else {
                index
            })?
        } else {
            0
        };
        summary_page(&full, offset)
    }
    pub fn migrate_legacy(mut self, storage: &Path) -> Result<Self> {
        self.attach(storage);
        self.before = self.before.migrate_legacy(storage)?;
        self.after = self.after.migrate_legacy(storage)?;
        let full = if let Some(summary) = &self.full_summary {
            summary.read()?
        } else {
            self.changes.summary.clone()
        };
        self.changes.summary = summary_page(&full, 0)?;
        self.full_summary = if self.changes.summary.next_offset.is_some() {
            Some(SummaryData::Object(snapshot_storage::save_json(
                storage, &full,
            )?))
        } else {
            None
        };
        Ok(self)
    }
    pub fn referenced_objects(&self, keys: &mut std::collections::HashSet<String>) -> Result<()> {
        self.before.referenced_objects(keys)?;
        self.after.referenced_objects(keys)?;
        if let Some(SummaryData::Object(object)) = &self.full_summary {
            keys.insert(object.key().to_owned());
        }
        Ok(())
    }
    pub fn attach(&mut self, storage: &Path) {
        if let Some(SummaryData::Object(o)) = &mut self.full_summary {
            o.attach(storage)
        }
        self.before.attach(storage);
        self.after.attach(storage);
    }
    fn materialized(&self) -> Result<Self> {
        Ok(Self {
            full_summary: self.full_summary.clone(),
            changes: {
                let mut changes = self.changes.clone();
                if let Some(full) = &self.full_summary {
                    changes.summary = full.read()?;
                }
                changes
            },
            before: self.before.materialized()?,
            after: self.after.materialized()?,
        })
    }
    pub fn validate_undo(&self, root: &Path) -> Result<()> {
        self.materialized()?.validate_undo_loaded(root)
    }
    fn validate_undo_loaded(&self, root: &Path) -> Result<()> {
        if self.changes.undo != latte_work_protocol::TurnUndoStatus::Ready
            || self.changes.summary.truncated
            || self.changes.summary.unavailable.is_some()
            || self.changes.background_pending
            || self.changes.summary.entries.is_empty()
        {
            bail!("此轮变更无法安全撤销，请查看工作区并手动核对");
        }
        let metadata = std::fs::metadata(root)?;
        if root.symlink_metadata()?.file_type().is_symlink()
            || self.before.root_identity != Some((metadata.dev(), metadata.ino()))
            || self.after.root_identity != self.before.root_identity
        {
            bail!("项目目录已改变，无法安全撤销");
        }
        for entry in &self.changes.summary.entries {
            if self
                .before
                .files
                .get(&entry.path)
                .and_then(Option::as_ref)
                .is_some()
                && !self.before.modes.contains_key(&entry.path)
            {
                bail!("缺少原文件权限，无法撤销");
            }
            self.verify_current(root, &entry.path)?;
        }
        Ok(())
    }
    fn verify_current(&self, root: &Path, path: &str) -> Result<()> {
        let metadata = std::fs::metadata(root)?;
        if self.before.root_identity != Some((metadata.dev(), metadata.ino()))
            || root.symlink_metadata()?.file_type().is_symlink()
        {
            bail!("项目目录已改变，无法安全撤销");
        }
        validate_path(path)?;
        let mut target = root.to_path_buf();
        let mut components = Path::new(path).components().peekable();
        while let Some(component) = components.next() {
            if component.as_os_str() == ".git" {
                bail!("不能撤销 Git 内部文件");
            }
            target.push(component);
            match target.symlink_metadata() {
                Ok(meta) if meta.file_type().is_symlink() => {
                    bail!("文件路径已变为符号链接：{path}")
                }
                Ok(meta) if components.peek().is_some() && !meta.is_dir() => {
                    bail!("文件所在目录已改变：{path}")
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && components.peek().is_none() => {}
                Err(error) => return Err(error.into()),
                _ => {}
            }
        }
        let expected = self.after.files.get(path).and_then(Option::as_ref);
        match (target.symlink_metadata(), expected) {
            (Err(e), None) if e.kind() == std::io::ErrorKind::NotFound => {}
            (Ok(meta), Some(bytes)) if meta.is_file() && meta.len() == bytes.len() as u64 => {
                if !bytes.matches(&target)?
                    || self
                        .after
                        .modes
                        .get(path)
                        .is_none_or(|mode| *mode != meta.mode())
                {
                    bail!("文件在本轮结束后已改变，未撤销：{path}");
                }
            }
            _ => bail!("文件在本轮结束后已改变，未撤销：{path}"),
        }
        Ok(())
    }
    pub fn restore(&self, root: &Path) -> Result<()> {
        self.materialized()?.restore_loaded(root)
    }
    fn restore_loaded(&self, root: &Path) -> Result<()> {
        // Called only after durable Unknown intent, with host admission paused and
        // overlapping idle native processes closed. External edits are checked again.
        for entry in &self.changes.summary.entries {
            self.verify_current(root, &entry.path)?;
            let target = root.join(&entry.path);
            if let Some(bytes) = self.before.files.get(&entry.path).and_then(Option::as_ref) {
                let mode = self
                    .before
                    .modes
                    .get(&entry.path)
                    .context("缺少原文件权限，无法撤销")?;
                let mut temporary =
                    tempfile::NamedTempFile::new_in(target.parent().context("文件目录缺失")?)?;
                bytes.write_to_file(temporary.as_file_mut())?;
                temporary
                    .as_file()
                    .set_permissions(std::fs::Permissions::from_mode(*mode & 0o777))?;
                temporary.as_file().sync_all()?;
                self.verify_current(root, &entry.path)?;
                if self
                    .after
                    .files
                    .get(&entry.path)
                    .and_then(Option::as_ref)
                    .is_some()
                {
                    temporary.persist(&target)?;
                } else {
                    temporary.persist_noclobber(&target)?;
                }
            } else {
                std::fs::remove_file(&target)?;
            }
        }
        Ok(())
    }
    pub async fn patch(&self, path: &str) -> Result<(String, bool)> {
        let turn = self.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            tokio::runtime::Handle::current().block_on(turn.patch_inner(&path))
        })
        .await
        .context("读取本轮差异失败")?
    }
    async fn patch_inner(&self, path: &str) -> Result<(String, bool)> {
        // The summary was computed before compaction. Retained bytes are sufficient
        // to compare exactly these paths; original partial flags remain on the summary.
        validate_path(path)?;
        if !self
            .full_summary
            .as_ref()
            .map(SummaryData::read)
            .transpose()?
            .unwrap_or_else(|| self.changes.summary.clone())
            .entries
            .iter()
            .any(|e| e.path == path)
        {
            bail!("文件不属于本轮已记录的变更");
        }
        let mut before = self.before.materialized()?;
        let mut after = self.after.materialized()?;
        before.truncated = false;
        after.truncated = false;
        before.patch_loaded(&after, path).await
    }
}
async fn no_index(before: &Path, after: &Path, stats: bool) -> Result<(String, bool)> {
    let mut command = Command::new("git");
    command.args([
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
    ]);
    if stats {
        command.args(["--numstat", "-z"]);
    }
    let mut child = command
        .arg("--")
        .arg(before)
        .arg(after)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().context("git stdout missing")?;
    let mut bytes = tokio::time::timeout(Duration::from_secs(10), async {
        if stats {
            read_chunks(stdout).await
        } else {
            let mut bytes = Vec::new();
            stdout
                .take((DIFF_PREVIEW_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            Ok(bytes)
        }
    })
    .await??;
    let truncated = !stats && bytes.len() > DIFF_PREVIEW_LIMIT;
    if truncated {
        child.kill().await?;
    } else {
        let status = tokio::time::timeout(Duration::from_secs(3), child.wait()).await??;
        if !matches!(status.code(), Some(0 | 1)) {
            bail!("无法比较任务文件");
        }
    }
    if truncated {
        bytes.truncate(DIFF_PREVIEW_LIMIT);
    }
    Ok((String::from_utf8_lossy(&bytes).into(), truncated))
}
pub async fn workspace_summary(root: &Path) -> Result<ChangeSummary> {
    let (entries, truncated) = files::changes(root).await?;
    let mut result = ChangeSummary {
        total_files: None,
        next_offset: None,
        offset: None,
        entries: vec![],
        added: 0,
        removed: 0,
        binary_files: 0,
        truncated,
        baseline_at: None,
        unavailable: None,
    };
    // Count the net HEAD-to-worktree diff once, including both staged and unstaged
    // edits. An unborn repository has no HEAD, so compare against its empty index.
    let stats = match files::git(
        root,
        &[
            "diff",
            "HEAD",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            ".",
        ],
    )
    .await
    {
        Ok(stats) => vec![stats],
        Err(_) => {
            files::git(root, &["rev-parse", "--is-inside-work-tree"]).await?;
            vec![
                files::git(
                    root,
                    &[
                        "diff",
                        "--cached",
                        "--numstat",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--",
                        ".",
                    ],
                )
                .await?,
                files::git(
                    root,
                    &[
                        "diff",
                        "--numstat",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--",
                        ".",
                    ],
                )
                .await?,
            ]
        }
    };
    for (stats, partial) in stats {
        result.truncated |= partial;
        for line in stats.lines() {
            let mut columns = line.splitn(3, '\t');
            match (
                columns.next().and_then(|v| v.parse::<u32>().ok()),
                columns.next().and_then(|v| v.parse::<u32>().ok()),
            ) {
                (Some(a), Some(r)) => {
                    result.added += a;
                    result.removed += r;
                }
                _ => result.binary_files += 1,
            }
        }
    }
    for (index, entry) in entries.into_iter().enumerate() {
        if index >= 128 {
            result.truncated = true;
            break;
        }
        if entry.section == latte_work_protocol::ChangeSection::Untracked {
            match files::read(root, &entry.path).await {
                Ok((text, partial)) => {
                    result.added += text.lines().count() as u32;
                    result.truncated |= partial;
                }
                Err(_) => result.binary_files += 1,
            }
        }
        if !result.entries.iter().any(|e| e.path == entry.path) {
            result.entries.push(TaskChange {
                path: entry.path,
                status: entry.status,
                added: None,
                removed: None,
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) {
        assert!(
            std::process::Command::new("git")
                .current_dir(root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fn repository(root: &Path) {
        git(root, &["init", "-q"]);
        std::fs::write(root.join("dirty.txt"), "original\n").unwrap();
        std::fs::write(root.join("delete.txt"), "gone\n").unwrap();
        std::fs::write(root.join("binary.dat"), [0, 1, 2]).unwrap();
        git(root, &["add", "."]);
        git(
            root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "baseline",
            ],
        );
    }
    #[tokio::test]
    async fn runtime_state_is_excluded_and_old_daemons_see_explicit_unknown_metadata() {
        for git_project in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            if git_project {
                repository(dir.path());
            }
            std::fs::write(dir.path().join("source.txt"), "source").unwrap();
            let state = dir.path().join(".state");
            std::fs::create_dir(&state).unwrap();
            let storage = snapshot_storage::prepare(&state.join("objects")).unwrap();
            std::fs::File::create(state.join("state.sqlite"))
                .unwrap()
                .set_len(16 * 1024 * 1024)
                .unwrap();
            let snapshot = Snapshot::capture_stored(dir.path(), &storage)
                .await
                .unwrap();
            let loaded = snapshot.materialized().unwrap();
            assert!(loaded.unavailable.is_none());
            assert!(loaded.files.contains_key("source.txt"));
            assert!(loaded.files.keys().all(|path| !path.starts_with(".state/")));
            assert_eq!(loaded.files.len(), if git_project { 4 } else { 1 });
            let metadata: serde_json::Value =
                serde_json::from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();
            assert!(metadata["root_identity"].is_null());
            assert!(metadata["unavailable"].as_str().unwrap().contains("新版"));
            assert_eq!(metadata["files"].as_object().unwrap().len(), 0);
            assert!(Snapshot::capture_stored(&state, &storage).await.is_err());
        }
    }
    #[test]
    fn twenty_thousand_files_are_complete_on_disk_and_bounded_on_every_wire_page() {
        let dir = tempfile::tempdir().unwrap();
        let root = snapshot_storage::prepare(dir.path()).unwrap();
        let full = ChangeSummary {
            entries: (0..20_000)
                .map(|n| TaskChange {
                    path: format!("src/{n:05}-{}.txt", "a".repeat(180)),
                    status: "A".into(),
                    added: Some(1),
                    removed: Some(0),
                })
                .collect(),
            total_files: None,
            next_offset: None,
            offset: None,
            added: 20_000,
            removed: 0,
            binary_files: 0,
            truncated: false,
            baseline_at: Some(1.0),
            unavailable: None,
        };
        assert!(serde_json::to_vec(&full).unwrap().len() > latte_work_protocol::MAX_FRAME);
        let object = snapshot_storage::save_json(&root, &full).unwrap();
        let turn = FrozenTurn {
            full_summary: Some(SummaryData::Object(object)),
            changes: latte_work_protocol::TurnChanges {
                request_id: "many".into(),
                summary: summary_page(&full, 0).unwrap(),
                interrupted: false,
                background_pending: false,
                undo: latte_work_protocol::TurnUndoStatus::Ready,
            },
            before: Snapshot::unavailable("fixture".into()),
            after: Snapshot::unavailable("fixture".into()),
        };
        let data = snapshot_storage::small_json(&turn).unwrap();
        assert!(data.len() < snapshot_storage::RECORD_LIMIT);
        let mut turn: FrozenTurn = serde_json::from_str(&data).unwrap();
        turn.attach(&root);
        assert_eq!(turn.changes.summary.total_files, Some(20_000));
        assert!(!turn.changes.summary.truncated);
        let mut offset = 0;
        let mut count = 0;
        loop {
            let page = summary_page(&full, offset).unwrap();
            assert!(page.entries.len() <= 64);
            assert!(serde_json::to_vec(&page).unwrap().len() < 128 * 1024);
            assert_eq!(page.entries[0].path, full.entries[count].path);
            count += page.entries.len();
            match page.next_offset {
                Some(next) => {
                    assert!(next > offset);
                    offset = next;
                }
                None => break,
            }
        }
        assert_eq!(count, full.entries.len());
        let last = turn
            .page_for(None, Some(&full.entries.last().unwrap().path))
            .unwrap();
        assert_eq!(last.entries.len(), 32);
        assert_eq!(last.offset, Some(19_968));
        assert_eq!(
            last.entries.last().unwrap().path,
            full.entries.last().unwrap().path
        );
        assert!(last.next_offset.is_none());
        assert_eq!(
            turn.page_for(Some(64), None).unwrap().entries[0].path,
            full.entries[64].path
        );
        assert!(turn.page_for(Some(20_001), None).is_err());
        assert_eq!(
            turn.page_for(None, Some("no-longer-changed.txt"))
                .unwrap()
                .offset,
            Some(0)
        );
    }
    #[test]
    fn invalid_utf8_git_paths_are_partial_without_discarding_valid_paths() {
        let (paths, partial) = decode_git_paths(
            b"sub/good.txt\0sub/bad-\xff\0sub/other.txt\0",
            "sub/",
            Path::new("/fixture"),
            None,
        );
        assert_eq!(paths, ["good.txt", "other.txt"]);
        assert!(partial);
    }
    #[tokio::test]
    async fn generated_untracked_files_stay_excluded_without_losing_tracked_files() {
        let dir = tempfile::tempdir().unwrap();
        repository(dir.path());
        std::fs::create_dir(dir.path().join(".venv")).unwrap();
        std::fs::write(dir.path().join(".venv/untracked.py"), "generated").unwrap();
        std::fs::write(dir.path().join(".venv/tracked.py"), "tracked").unwrap();
        git(dir.path(), &["add", ".venv/tracked.py"]);
        let before = Snapshot::capture(dir.path()).await.unwrap();
        assert!(!before.truncated);
        assert!(before.unavailable.is_none());
        assert!(before.files.contains_key(".venv/tracked.py"));
        assert!(!before.files.contains_key(".venv/untracked.py"));
        std::fs::write(dir.path().join("dirty.txt"), "actual change\n").unwrap();
        let summary = before.summary(dir.path()).await.unwrap();
        assert!(summary.unavailable.is_none());
        assert_eq!(summary.entries.len(), 1);
        assert_eq!(summary.entries[0].path, "dirty.txt");
    }
    #[tokio::test]
    async fn ordinary_directory_freezes_real_edits_additions_and_deletions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/edit.txt"), "before\n").unwrap();
        std::fs::write(root.join("delete.txt"), "remove\n").unwrap();
        let before = Snapshot::capture(root).await.unwrap();
        assert!(before.summary(root).await.unwrap().entries.is_empty());
        std::fs::write(root.join("nested/edit.txt"), "after\nextra\n").unwrap();
        std::fs::remove_file(root.join("delete.txt")).unwrap();
        std::fs::write(root.join("new.txt"), "created\n").unwrap();
        let after = Snapshot::capture(root).await.unwrap();
        let turn = FrozenTurn::freeze("r1".into(), before, after, false, false)
            .await
            .unwrap();
        assert_eq!(turn.changes.summary.entries.len(), 3);
        assert_eq!(
            (turn.changes.summary.added, turn.changes.summary.removed),
            (3, 2)
        );
        assert!(!turn.changes.summary.truncated);
        assert!(turn.changes.summary.unavailable.is_none());
        let turn: FrozenTurn =
            serde_json::from_str(&serde_json::to_string(&turn).unwrap()).unwrap();
        let (patch, _) = turn.patch("nested/edit.txt").await.unwrap();
        assert!(patch.contains("-before") && patch.contains("+extra"));
        std::fs::write(root.join("nested/edit.txt"), "external\n").unwrap();
        assert_eq!(turn.patch("nested/edit.txt").await.unwrap().0, patch);
        assert!(turn.validate_undo(root).is_err());
        std::fs::write(root.join("nested/edit.txt"), "after\nextra\n").unwrap();
        turn.restore(root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("nested/edit.txt")).unwrap(),
            "before\n"
        );
        assert!(root.join("delete.txt").exists());
        assert!(!root.join("new.txt").exists());
    }
    #[tokio::test]
    async fn ordinary_inventory_keeps_large_files_without_following_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("private.txt"), "private").unwrap();
        std::os::unix::fs::symlink(external.path(), dir.path().join("outside")).unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/skip.txt"), "skip").unwrap();
        std::fs::write(dir.path().join("large.txt"), vec![0; 512 * 1024 + 1]).unwrap();
        let before = Snapshot::capture(dir.path()).await.unwrap();
        assert!(before.truncated, "symlink is still excluded");
        assert_eq!(before.files.len(), 1);
        assert_eq!(
            before.files["large.txt"].as_ref().unwrap().len(),
            512 * 1024 + 1
        );
        assert!(before.summary(dir.path()).await.unwrap().entries.is_empty());
    }
    #[tokio::test]
    async fn snapshots_exceed_previous_file_count_total_bytes_and_inventory_limits() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..1001 {
            std::fs::write(dir.path().join(format!("file-{n}.txt")), "before\n").unwrap();
        }
        for n in 0..5001 {
            std::fs::create_dir(dir.path().join(format!("dir-{n}"))).unwrap();
        }
        let large = "before\n".repeat(180_000);
        for n in 0..8 {
            std::fs::write(dir.path().join(format!("large-{n}.txt")), &large).unwrap();
        }
        let before = Snapshot::capture(dir.path()).await.unwrap();
        assert!(!before.truncated);
        assert_eq!(before.files.len(), 1009);
        std::fs::write(dir.path().join("file-1000.txt"), "after\n").unwrap();
        std::fs::write(dir.path().join("large-7.txt"), format!("{large}after\n")).unwrap();
        let after = Snapshot::capture(dir.path()).await.unwrap();
        let turn = FrozenTurn::freeze("large".into(), before, after, false, false)
            .await
            .unwrap();
        assert!(!turn.changes.summary.truncated);
        assert_eq!(turn.changes.summary.entries.len(), 2);
        assert_eq!(
            (turn.changes.summary.added, turn.changes.summary.removed),
            (2, 1)
        );
        let turn: FrozenTurn =
            serde_json::from_str(&serde_json::to_string(&turn).unwrap()).unwrap();
        assert!(
            turn.patch("large-7.txt")
                .await
                .unwrap()
                .0
                .contains("+after")
        );
        turn.validate_undo(dir.path()).unwrap();
        // Compare same-sized changed contents in chunks, even above the old cap.
        let expected = std::fs::read(dir.path().join("large-7.txt")).unwrap();
        let mut changed = expected.clone();
        changed[0] = b'X';
        std::fs::write(dir.path().join("large-7.txt"), changed).unwrap();
        assert!(turn.validate_undo(dir.path()).is_err());
        std::fs::write(dir.path().join("large-7.txt"), expected).unwrap();
        turn.restore(dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("large-7.txt")).unwrap(),
            large
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file-1000.txt")).unwrap(),
            "before\n"
        );
    }
    #[tokio::test]
    async fn git_inventory_does_not_truncate_the_file_list_at_the_preview_byte_limit() {
        let dir = tempfile::tempdir().unwrap();
        repository(dir.path());
        for n in 0..2300 {
            std::fs::write(
                dir.path().join(format!("{n:04}-{}.txt", "a".repeat(230))),
                "content",
            )
            .unwrap();
        }
        let snapshot = Snapshot::capture(dir.path()).await.unwrap();
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.files.len(), 2303);
    }
    #[tokio::test]
    async fn ordinary_inventory_skips_entries_and_queued_directories_deleted_after_enumeration() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("gone.txt"), "gone").unwrap();
        let mut entries = tokio::fs::read_dir(dir.path()).await.unwrap();
        let entry = entries.next_entry().await.unwrap().unwrap();
        std::fs::remove_file(entry.path()).unwrap();
        assert!(
            inventory_entry_type(dir.path(), &entry)
                .await
                .unwrap()
                .is_none()
        );
        let queued = dir.path().join("queued");
        std::fs::create_dir(&queued).unwrap();
        std::fs::remove_dir(&queued).unwrap();
        assert!(
            inventory_directory(dir.path(), &queued)
                .await
                .unwrap()
                .is_none()
        );
        std::fs::write(dir.path().join("kept.txt"), "kept").unwrap();
        assert_eq!(
            inventory(dir.path()).await.unwrap(),
            (vec!["kept.txt".into()], false)
        );
        // Disappearance is the only ignored error; permission and path-boundary
        // failures must never be turned into a complete, empty inventory.
        assert!(
            if_present::<()>(Err(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied
            )
            .into()))
            .is_err()
        );
    }
    #[tokio::test]
    async fn task_counts_exclude_existing_dirty_files_survive_serialization_and_do_not_modify_index()
     {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repository(root);
        std::fs::write(root.join("dirty.txt"), "existing dirty\n").unwrap();
        std::fs::write(root.join("existing.txt"), "preexisting untracked\n").unwrap();
        let baseline = Snapshot::capture(root).await.unwrap();
        assert!(baseline.summary(root).await.unwrap().entries.is_empty());
        let baseline: Snapshot =
            serde_json::from_str(&serde_json::to_string(&baseline).unwrap()).unwrap();
        std::fs::write(root.join("dirty.txt"), "task edit\nsecond line\n").unwrap();
        std::fs::remove_file(root.join("delete.txt")).unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        std::fs::write(root.join("empty.txt"), "").unwrap();
        std::fs::write(root.join("binary.dat"), [0, 4, 2]).unwrap();
        git(root, &["add", "dirty.txt"]);
        let index = std::fs::read(root.join(".git/index")).unwrap();
        let result = baseline.summary(root).await.unwrap();
        assert_eq!(
            (result.added, result.removed, result.binary_files),
            (3, 2, 1)
        );
        assert_eq!(result.entries.len(), 5, "{result:?}");
        assert!(!result.truncated, "{result:?}");
        assert!(!result.entries.iter().any(|e| e.path == "existing.txt"));
        let empty = result
            .entries
            .iter()
            .find(|e| e.path == "empty.txt")
            .unwrap();
        assert_eq!((empty.added, empty.removed), (Some(0), Some(0)));
        let (patch, _) = baseline.patch(root, "dirty.txt").await.unwrap();
        assert!(
            patch.contains("-existing dirty") && patch.contains("+task edit"),
            "{patch}"
        );
        assert!(patch.contains("--- a/dirty.txt") && patch.contains("+++ b/dirty.txt"));
        assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index);
        assert!(baseline.patch(root, "../private").await.is_err());
        assert!(baseline.patch(root, "existing.txt").await.is_err());
    }
    #[tokio::test]
    async fn workspace_totals_count_net_edits_once_across_staging() {
        let dir = tempfile::tempdir().unwrap();
        repository(dir.path());
        std::fs::write(dir.path().join("dirty.txt"), "staged\n").unwrap();
        git(dir.path(), &["add", "dirty.txt"]);
        std::fs::write(dir.path().join("dirty.txt"), "final\n").unwrap();
        let result = workspace_summary(dir.path()).await.unwrap();
        assert_eq!((result.added, result.removed), (1, 1));
    }
    #[tokio::test]
    async fn snapshots_include_large_edits_and_respect_subprojects() {
        let dir = tempfile::tempdir().unwrap();
        repository(dir.path());
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("a.txt"), "old\n").unwrap();
        let baseline = Snapshot::capture(&sub).await.unwrap();
        std::fs::write(dir.path().join("dirty.txt"), "outside\n").unwrap();
        assert!(baseline.summary(&sub).await.unwrap().entries.is_empty());
        std::fs::write(sub.join("a.txt"), vec![b'a'; 512 * 1024 + 1]).unwrap();
        let result = baseline.summary(&sub).await.unwrap();
        assert!(!result.truncated);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].status, "M");
        assert!(
            Snapshot::capture(Path::new("/missing-fixture-root"))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn frozen_turns_survive_later_edits_and_restore_only_the_latest_exact_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repository(root);
        std::fs::write(root.join("dirty.txt"), "existing dirty\n").unwrap();
        let before = Snapshot::capture(root).await.unwrap();
        std::fs::write(root.join("dirty.txt"), "turn one\nsecond line\n").unwrap();
        let after = Snapshot::capture(root).await.unwrap();
        let one = FrozenTurn::freeze("r1".into(), before, after, false, false)
            .await
            .unwrap();
        let patch_one = one.patch("dirty.txt").await.unwrap();
        let before = Snapshot::capture(root).await.unwrap();
        std::fs::write(root.join("dirty.txt"), "turn two\n").unwrap();
        std::fs::remove_file(root.join("delete.txt")).unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        std::fs::write(root.join("binary.dat"), [0, 7, 2]).unwrap();
        let after = Snapshot::capture(root).await.unwrap();
        let two = FrozenTurn::freeze("r2".into(), before, after, false, false)
            .await
            .unwrap();
        assert_eq!(one.patch("dirty.txt").await.unwrap(), patch_one);
        assert!(one.validate_undo(root).is_err());
        let index = std::fs::read(root.join(".git/index")).unwrap();
        let two: FrozenTurn = serde_json::from_str(&serde_json::to_string(&two).unwrap()).unwrap();
        assert_eq!(
            (two.changes.summary.added, two.changes.summary.removed),
            (2, 3)
        );
        assert!(
            two.patch("dirty.txt")
                .await
                .unwrap()
                .0
                .contains("-turn one")
        );
        assert!(
            two.patch("delete.txt")
                .await
                .unwrap()
                .0
                .contains("+++ /dev/null")
        );
        two.validate_undo(root).unwrap();
        std::fs::write(root.join("dirty.txt"), "external writer\n").unwrap();
        assert!(two.validate_undo(root).is_err());
        assert!(
            root.join("new.txt").exists(),
            "preflight has no side effects"
        );
        std::fs::write(root.join("dirty.txt"), "turn two\n").unwrap();
        two.validate_undo(root).unwrap();
        two.restore(root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("dirty.txt")).unwrap(),
            "turn one\nsecond line\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("delete.txt")).unwrap(),
            "gone\n"
        );
        assert_eq!(std::fs::read(root.join("binary.dat")).unwrap(), [0, 1, 2]);
        assert!(!root.join("new.txt").exists());
        assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index);
        assert!(two.validate_undo(root).is_err());
        assert_eq!(one.patch("dirty.txt").await.unwrap(), patch_one);
    }
    #[tokio::test]
    async fn undo_refuses_symlink_ancestors_and_partial_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repository(root);
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), "before\n").unwrap();
        let before = Snapshot::capture(root).await.unwrap();
        std::fs::write(root.join("sub/a.txt"), "after\n").unwrap();
        let after = Snapshot::capture(root).await.unwrap();
        let mut turn = FrozenTurn::freeze("r".into(), before, after, false, false)
            .await
            .unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("a.txt"), "after\n").unwrap();
        std::fs::rename(root.join("sub"), root.join("saved")).unwrap();
        std::os::unix::fs::symlink(external.path(), root.join("sub")).unwrap();
        assert!(turn.validate_undo(root).is_err());
        assert_eq!(
            std::fs::read_to_string(external.path().join("a.txt")).unwrap(),
            "after\n"
        );
        std::fs::remove_file(root.join("sub")).unwrap();
        std::fs::rename(root.join("saved"), root.join("sub")).unwrap();
        turn.validate_undo(root).unwrap();
        turn.changes.summary.truncated = true;
        assert!(turn.validate_undo(root).is_err());
        turn.changes.summary.truncated = false;
        turn.changes.background_pending = true;
        assert!(turn.validate_undo(root).is_err());
    }
    #[tokio::test]
    async fn undo_refuses_replaced_project_roots_even_with_matching_file_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        repository(&root);
        let before = Snapshot::capture(&root).await.unwrap();
        std::fs::write(root.join("dirty.txt"), "after\n").unwrap();
        let after = Snapshot::capture(&root).await.unwrap();
        let turn = FrozenTurn::freeze("r".into(), before, after, false, false)
            .await
            .unwrap();
        let external = dir.path().join("replacement");
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("dirty.txt"), "after\n").unwrap();
        std::fs::rename(&root, dir.path().join("original-project")).unwrap();
        std::os::unix::fs::symlink(&external, &root).unwrap();
        assert!(turn.validate_undo(&root).is_err());
        assert!(turn.restore(&root).is_err());
        assert_eq!(
            std::fs::read_to_string(external.join("dirty.txt")).unwrap(),
            "after\n"
        );
    }
}
