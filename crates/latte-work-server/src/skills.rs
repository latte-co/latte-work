//! Host-owned skill inventory. Never execute skill bodies or change global Agent config.
use crate::agents::claude_skills::{field, read};
use crate::skill_worker::Budget;
use anyhow::{Context, Result, bail};
use latte_work_protocol::{ManagedSkill, SkillScope, SkillState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

const LIMIT: usize = 512;
const FILE_LIMIT: u64 = 64 * 1024;
const BUILTIN: &str = include_str!("../../../skills/latte-work-context/SKILL.md");
const BUILTIN_ID: &str = "platform:latte-work-context";
#[derive(Default, Serialize, Deserialize)]
struct Preferences {
    platform: BTreeMap<String, SkillState>,
}
#[derive(Clone)]
pub struct Skills {
    directory: PathBuf,
    home: PathBuf,
    claude: PathBuf,
    budget: Option<Budget>,
}
struct Entry {
    skill: ManagedSkill,
    root: Option<PathBuf>,
    slug: String,
}
pub struct Catalog {
    pub skills: Vec<ManagedSkill>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}
// Reserve independent wire budgets so copy conflicts cannot hide scan failures.
#[derive(Default)]
struct Warnings {
    messages: Vec<String>,
    omitted: usize,
}
impl Warnings {
    fn push(&mut self, message: String) {
        if self.messages.len() < 15 {
            self.messages.push(message.chars().take(1024).collect());
        } else {
            self.omitted += 1;
        }
    }
    fn finish(mut self, category: &str) -> Vec<String> {
        if self.omitted > 0 {
            self.messages.push(format!(
                "另有 {} 条{category}未显示，请先处理已列问题后刷新。",
                self.omitted
            ));
        }
        self.messages
    }
}
impl Skills {
    pub fn new(directory: &Path) -> Result<Self> {
        let home =
            PathBuf::from(crate::agent_environment::variable("HOME").context("无法确定主目录")?);
        let claude = crate::agent_environment::variable("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        Ok(Self {
            directory: directory.into(),
            home,
            claude,
            budget: None,
        })
    }
    /// Each admitted request owns its cancellation state; no cross-request deadline.
    pub fn with_budget(&self, budget: Budget) -> Self {
        Self {
            budget: Some(budget),
            ..self.clone()
        }
    }
    fn check_budget(&self) -> Result<()> {
        self.budget.as_ref().map_or(Ok(()), Budget::check)
    }
    fn preferences(&self) -> Result<Preferences> {
        self.check_budget()?;
        let path = self.directory.join("skills.json");
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
            Ok(m) if m.file_type().is_symlink() => bail!("Skill 设置不能是符号链接"),
            Ok(_) => Ok(serde_json::from_str(&read(&path, FILE_LIMIT)?)?),
            Err(e) => Err(e.into()),
        }
    }
    fn roots(&self) -> Vec<(SkillScope, PathBuf)> {
        let mut roots = vec![(SkillScope::System, self.claude.join("skills"))];
        for config in [".agents", ".codex", ".trae", ".traex"] {
            roots.push((SkillScope::System, self.home.join(config).join("skills")));
        }
        roots.push((SkillScope::System, self.home.join(".codex/skills/.system")));
        roots
    }
    fn inventory(&self, project: Option<&Path>) -> Result<(Vec<Entry>, Vec<String>, bool)> {
        require_global(project)?;
        self.check_budget()?;
        let (prefs, mut warnings) = match self.preferences() {
            Ok(prefs) => (Some(prefs), Warnings::default()),
            Err(error) => {
                let mut warnings = Warnings::default();
                warnings.push(format!(
                    "平台技能偏好不可用，已跳过平台技能；请核对 {}：{error}",
                    self.directory.join("skills.json").display()
                ));
                (None, warnings)
            }
        };
        let mut entries = vec![Entry {
            skill: ManagedSkill {
                id: BUILTIN_ID.into(),
                name: field(BUILTIN, "name"),
                description: field(BUILTIN, "description"),
                scope: SkillScope::Platform,
                state: prefs
                    .as_ref()
                    .map(|prefs| &prefs.platform)
                    .and_then(|platform| platform.get(BUILTIN_ID))
                    .copied()
                    .unwrap_or(SkillState::Enabled),
                directory: None,
                origin: "Latte Work".into(),
            },
            root: None,
            slug: "latte-work-context".into(),
        }];
        if prefs.is_none() {
            entries.clear();
        }
        let started = std::time::Instant::now();
        let mut seen = HashSet::new();
        let mut truncated = false;
        for (scope, root) in self.roots() {
            self.check_budget()?;
            // Canonical parent prevents aliases from duplicating an installation. Skill-folder
            // symlinks remain entries: state changes move the link, never its shared target.
            let parent = match root.parent().context("Skill 根目录无效")?.canonicalize() {
                Ok(p) => p,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    warnings.push(format!("{}：{e}", root.display()));
                    continue;
                }
            };
            let root = parent.join(root.file_name().context("Skill 根目录无效")?);
            let root = if root
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                match root.canonicalize() {
                    Ok(path) => path,
                    Err(e) => {
                        warnings.push(format!("{}：{e}", root.display()));
                        continue;
                    }
                }
            } else {
                root
            };
            if !seen.insert(root.clone()) {
                continue;
            }
            for state in [
                SkillState::Enabled,
                SkillState::Disabled,
                SkillState::Uninstalled,
            ] {
                let folder = state_root(&root, state)?;
                if folder
                    .symlink_metadata()
                    .is_ok_and(|m| m.file_type().is_symlink())
                {
                    warnings.push(format!("技能状态目录不能是符号链接：{}", folder.display()));
                    continue;
                }
                let listing = match std::fs::read_dir(&folder) {
                    Ok(list) => list,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => {
                        warnings.push(format!("{}：{e}", folder.display()));
                        continue;
                    }
                };
                // Bound traversal, even for directories containing unrelated files.
                let mut names = Vec::new();
                for (n, item) in listing.take(LIMIT + 1).enumerate() {
                    if n == LIMIT {
                        truncated = true;
                        break;
                    }
                    match item {
                        Ok(entry) => names.push(entry),
                        Err(error) => warnings.push(error.to_string()),
                    }
                }
                names.sort_by_key(|entry| entry.file_name());
                for item in names {
                    self.check_budget()?;
                    if entries.len() >= LIMIT
                        || started.elapsed() > std::time::Duration::from_secs(3)
                    {
                        truncated = true;
                        break;
                    }
                    let Some(slug) = item.file_name().to_str().map(str::to_owned) else {
                        warnings.push(format!(
                            "技能目录名称不是 UTF-8，已跳过：{}",
                            item.path().display()
                        ));
                        continue;
                    };
                    if !component(&slug) {
                        // .system is inventoried separately, not a skill installation.
                        if slug != ".system" {
                            warnings.push(format!(
                                "技能目录名称不符合要求，已跳过：{}",
                                item.path().display()
                            ));
                        }
                        continue;
                    }
                    match inspect(&item.path(), &slug) {
                        Ok(Some((name, description, _))) => {
                            let id = identity(&root, &slug);
                            entries.push(Entry {
                                skill: ManagedSkill {
                                    id,
                                    name,
                                    description,
                                    scope,
                                    state,
                                    directory: Some(item.path().to_string_lossy().into()),
                                    origin: root.to_string_lossy().into(),
                                },
                                root: Some(root.clone()),
                                slug,
                            });
                        }
                        Ok(None) => {}
                        Err(e) => warnings.push(format!("{}：{e}", item.path().display())),
                    }
                }
            }
        }
        entries.sort_by(|a, b| {
            a.skill
                .name
                .to_lowercase()
                .cmp(&b.skill.name.to_lowercase())
                .then(a.skill.id.cmp(&b.skill.id))
        });
        Ok((entries, warnings.finish("扫描诊断"), truncated))
    }
    pub fn list(&self, project: Option<&Path>) -> Result<Catalog> {
        let (entries, mut warnings, truncated) = self.inventory(project)?;
        let mut ids = HashSet::new();
        let duplicates: HashSet<_> = entries
            .iter()
            .filter(|entry| !ids.insert(entry.skill.id.clone()))
            .map(|entry| entry.skill.id.clone())
            .collect();
        let mut conflict_warnings = Warnings::default();
        if !duplicates.is_empty() {
            let mut duplicate_ids: Vec<_> = duplicates.iter().collect();
            duplicate_ids.sort();
            for id in duplicate_ids {
                let copies: Vec<_> = entries.iter().filter(|e| &e.skill.id == id).collect();
                let paths = copies
                    .iter()
                    .filter_map(|e| e.skill.directory.as_deref())
                    .collect::<Vec<_>>()
                    .join("；");
                conflict_warnings.push(format!(
                    "技能「{}」有多个状态副本，请核对并保留一个副本后刷新：{paths}",
                    copies[0].skill.name
                ));
            }
        }
        let mut conflicts = conflict_warnings.finish("副本冲突警告");
        conflicts.append(&mut warnings);
        let warnings = conflicts;
        let mut bytes = 0;
        let mut truncated = truncated;
        let skills = entries
            .into_iter()
            .filter(|entry| !duplicates.contains(&entry.skill.id))
            .map(|e| e.skill)
            .take_while(|skill| {
                bytes += serde_json::to_vec(skill).map_or(usize::MAX / 2, |v| v.len());
                if bytes > latte_work_protocol::MAX_FRAME / 2 {
                    truncated = true;
                    false
                } else {
                    true
                }
            })
            .collect();
        Ok(Catalog {
            skills,
            warnings,
            truncated,
        })
    }
    fn find(&self, project: Option<&Path>, id: &str) -> Result<Entry> {
        if id.len() > 128 {
            bail!("Skill 标识无效");
        }
        let (entries, _, _) = self.inventory(project)?;
        let mut matching = entries.into_iter().filter(|e| e.skill.id == id);
        let entry = matching
            .next()
            .context("Skill 已变更或不存在，请刷新列表")?;
        if let Some(other) = matching.next() {
            bail!(
                "技能「{}」有多个状态副本，请核对 {} 与 {}",
                entry.skill.name,
                entry.skill.directory.as_deref().unwrap_or(""),
                other.skill.directory.as_deref().unwrap_or("")
            );
        }
        Ok(entry)
    }
    pub fn detail(&self, project: Option<&Path>, id: &str) -> Result<(ManagedSkill, String)> {
        self.check_budget()?;
        let entry = self.find(project, id)?;
        let markdown = if let Some(path) = &entry.skill.directory {
            inspect(Path::new(path), &entry.slug)?
                .context("Skill 说明已移除")?
                .2
        } else {
            BUILTIN.into()
        };
        Ok((entry.skill, markdown))
    }
    pub fn set_state_checked(
        &self,
        project: Option<&Path>,
        id: &str,
        expected: SkillState,
        state: SkillState,
    ) -> Result<()> {
        let current = self.find(project, id)?.skill.state;
        if current != expected && current != state {
            bail!("Skill 状态已发生变化，请刷新后重新操作");
        }
        self.set_state(project, id, state)
    }
    pub fn set_state(&self, project: Option<&Path>, id: &str, state: SkillState) -> Result<()> {
        self.check_budget()?;
        let entry = self.find(project, id)?;
        if entry.skill.state == state {
            return Ok(());
        }
        if let Some(root) = entry.root {
            let source = state_root(&root, entry.skill.state)?.join(&entry.slug);
            let destination_root = state_root(&root, state)?;
            safe_folder(&destination_root)?;
            let destination = destination_root.join(&entry.slug);
            require_absent(&destination)?;
            if source.symlink_metadata()?.file_type().is_symlink() {
                let link = std::fs::read_link(&source)?;
                if link.is_relative()
                    && destination
                        .parent()
                        .context("目标目录无效")?
                        .join(&link)
                        .canonicalize()
                        .ok()
                        != source.canonicalize().ok()
                {
                    bail!("相对符号链接在移动后会失效，请先改用绝对符号链接");
                }
            }
            // Rename only the discovered top-level directory/link; never recursively delete.
            self.check_budget()?;
            std::fs::rename(&source, &destination)
                .context("无法移动 Skill，请检查目录权限和目标位置")?;
        } else {
            let mut prefs = self.preferences()?;
            prefs.platform.insert(id.into(), state);
            let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
            use std::io::Write;
            file.write_all(&serde_json::to_vec(&prefs)?)?;
            file.as_file().sync_all()?;
            self.check_budget()?;
            file.persist(self.directory.join("skills.json"))?;
        }
        Ok(())
    }
    /// Import selected content without interpreting client-side absolute paths.
    pub fn import_files(
        &self,
        name: &str,
        files: &[latte_work_protocol::SkillImportFile],
    ) -> Result<()> {
        use std::io::{Read, Write};
        use std::os::unix::fs::OpenOptionsExt;
        self.check_budget()?;
        if !component(name) || files.is_empty() || files.len() > LIMIT {
            bail!("技能目录名无效或文件数量超过 512 项");
        }
        let uploads = crate::attachments::Attachments::new(&self.directory)?;
        let mut names = HashSet::new();
        let mut directories = HashSet::new();
        for item in files {
            let parts: Vec<_> = item.path.split('/').collect();
            if item.path.len() > 1024
                || parts.len() > 9
                || parts.iter().any(|p| {
                    p.is_empty()
                        || *p == "."
                        || *p == ".."
                        || p.len() > 255
                        || p.contains('\\')
                        || p.chars().any(char::is_control)
                })
                || !names.insert(item.path.as_str())
            {
                bail!(
                    "技能文件路径无效或重复：{}",
                    item.path.chars().take(128).collect::<String>()
                );
            }
            for n in 1..parts.len() {
                directories.insert(parts[..n].join("/"));
            }
            if !uploads.is_completed(Path::new(&item.attachment)) {
                bail!("技能文件必须来自当前主机已完成的上传");
            }
        }
        if names.len() + directories.len() > LIMIT
            || directories.iter().any(|p| names.contains(p.as_str()))
        {
            bail!("技能最多 512 项，文件和目录不能重名");
        }
        if !names.contains("SKILL.md") {
            bail!("技能中缺少 SKILL.md");
        }
        let staging = tempfile::Builder::new()
            .prefix("skill-upload-")
            .tempdir_in(&self.directory)?;
        let source = staging.path().join(name);
        std::fs::create_dir(&source)?;
        let mut total = 0u64;
        for item in files {
            self.check_budget()?;
            let mut input = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
                .open(&item.attachment)?;
            let metadata = input.metadata()?;
            total = total.saturating_add(metadata.len());
            if !metadata.is_file()
                || total > 16 * 1024 * 1024
                || (item.path == "SKILL.md" && metadata.len() > FILE_LIMIT)
            {
                bail!("技能上传超出读取范围（总量 16 MiB，SKILL.md 64 KiB）");
            }
            let target = source.join(&item.path);
            std::fs::create_dir_all(target.parent().context("技能路径无效")?)?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(target)?;
            let mut remaining = metadata.len();
            while remaining > 0 {
                self.check_budget()?;
                let mut buffer = [0; 65536];
                let count = input.read(&mut buffer[..usize::try_from(remaining.min(65536))?])?;
                if count == 0 {
                    bail!("技能上传文件在读取期间发生变化");
                }
                output.write_all(&buffer[..count])?;
                remaining -= count as u64;
            }
            if input.read(&mut [0])? != 0 {
                bail!("技能上传文件在读取期间发生变化");
            }
        }
        self.install(None, SkillScope::System, &source)
    }
    pub fn install(&self, project: Option<&Path>, scope: SkillScope, source: &Path) -> Result<()> {
        require_global(project)?;
        self.check_budget()?;
        match scope {
            SkillScope::Platform => bail!("平台技能随 Latte Work 提供，请从详情安装"),
            SkillScope::Project => bail!("技能管理仅支持当前主机的全局技能，不支持项目级安装"),
            SkillScope::System => {}
        }
        if !source.is_absolute() {
            bail!("请输入所选主机上的绝对目录路径");
        }
        let source = source.canonicalize().context("Skill 目录不存在")?;
        let slug = source
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| component(s))
            .context("Skill 目录名称无效")?;
        inspect(&source, slug)?.context("目录中缺少 SKILL.md")?;
        // Resolve the trusted HOME (e.g. macOS /var or Linux /home aliases)
        // before refusing symlinks inside its installation destination.
        let base = self.home.canonicalize()?;
        let root = base.join(".agents/skills");
        safe_folder(&root)?;
        let root = root.canonicalize()?;
        for state in [
            SkillState::Enabled,
            SkillState::Disabled,
            SkillState::Uninstalled,
        ] {
            require_absent(&state_root(&root, state)?.join(slug))?;
        }
        let staging = tempfile::Builder::new()
            .prefix(".latte-work-skill-import-")
            .tempdir_in(root.parent().context("Skill 安装根目录无效")?)?;
        let target = staging.path().join(slug);
        let mut budget = (0usize, 0u64);
        copy_tree(&source, &target, 0, &mut budget, self.budget.as_ref())?;
        self.check_budget()?;
        std::fs::rename(target, root.join(slug))?;
        Ok(())
    }
}
// Retain the legacy wire argument for compatibility, but never resolve or scan a project.
fn require_global(project: Option<&Path>) -> Result<()> {
    if project.is_some() {
        bail!("技能管理仅支持当前主机的全局技能，不支持项目级管理");
    }
    Ok(())
}
fn component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        && !s.starts_with('.')
}
fn identity(root: &Path, slug: &str) -> String {
    format!(
        "file:{:x}",
        Sha256::digest(root.join(slug).as_os_str().as_encoded_bytes())
    )
}
fn state_root(root: &Path, state: SkillState) -> Result<PathBuf> {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .context("Skill 根目录无效")?;
    let base = if name == ".system" {
        root.parent()
            .context("系统技能根目录无效")?
            .with_file_name("skills-system")
    } else {
        root.into()
    };
    let base_name = base
        .file_name()
        .and_then(|s| s.to_str())
        .context("Skill 根目录无效")?;
    Ok(match state {
        SkillState::Enabled => root.into(),
        SkillState::Disabled => base.with_file_name(format!("{base_name}.latte-work-disabled")),
        SkillState::Uninstalled => {
            base.with_file_name(format!("{base_name}.latte-work-uninstalled"))
        }
    })
}
fn require_absent(path: &Path) -> Result<()> {
    match path.symlink_metadata() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => bail!("目标位置已存在，请先核对：{}", path.display()),
        Err(e) => Err(e.into()),
    }
}
// Never traverse a symlink while creating a destination, including dangling links.
fn safe_folder(path: &Path) -> Result<()> {
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        match ancestor.symlink_metadata() {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => bail!("Skill 安装位置不是普通目录：{}", ancestor.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(ancestor)?,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn inspect(directory: &Path, slug: &str) -> Result<Option<(String, String, String)>> {
    let target = directory.canonicalize()?;
    if !target.is_dir() {
        return Ok(None);
    }
    let markdown = target.join("SKILL.md");
    let resolved = match markdown.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !resolved.starts_with(&target) {
        bail!("SKILL.md 超出技能目录");
    }
    let body = read(&resolved, FILE_LIMIT)?;
    let name = field(&body, "name");
    Ok(Some((
        if name.is_empty() {
            slug.into()
        } else {
            name.chars().take(128).collect()
        },
        field(&body, "description").chars().take(512).collect(),
        body,
    )))
}
fn copy_tree(
    source: &Path,
    target: &Path,
    depth: usize,
    budget: &mut (usize, u64),
    deadline: Option<&Budget>,
) -> Result<()> {
    if let Some(deadline) = deadline {
        deadline.check()?;
    }
    if depth > 8 {
        bail!("Skill 目录层数超过 8 层");
    }
    std::fs::create_dir(target)?;
    for item in std::fs::read_dir(source)? {
        if let Some(deadline) = deadline {
            deadline.check()?;
        }
        budget.0 += 1;
        if budget.0 > 512 {
            bail!("Skill 文件数量超过 512 项");
        }
        let item = item?;
        let meta = item.path().symlink_metadata()?;
        if meta.is_dir() {
            copy_tree(
                &item.path(),
                &target.join(item.file_name()),
                depth + 1,
                budget,
                deadline,
            )?;
        } else if meta.is_file() {
            budget.1 = budget.1.saturating_add(meta.len());
            if budget.1 > 16 * 1024 * 1024 {
                bail!("Skill 文件总量超过 16 MiB");
            }
            // Bounded nonblocking regular-file read also fences special-file replacement.
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
                .open(item.path())?;
            use std::io::{Read, Write};
            use std::os::unix::fs::OpenOptionsExt;
            if !file.metadata()?.is_file() {
                bail!("Skill 包含非普通文件");
            }
            let mut bytes = Vec::new();
            let mut file = file.take(meta.len() + 1);
            loop {
                if let Some(deadline) = deadline {
                    deadline.check()?;
                }
                let mut chunk = [0; 64 * 1024];
                let count = file.read(&mut chunk)?;
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            if bytes.len() as u64 != meta.len() {
                bail!("Skill 文件在读取期间发生变化");
            }
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target.join(item.file_name()))?;
            for chunk in bytes.chunks(64 * 1024) {
                if let Some(deadline) = deadline {
                    deadline.check()?;
                }
                out.write_all(chunk)?;
            }
            std::fs::set_permissions(target.join(item.file_name()), meta.permissions())?;
        } else {
            bail!("Skill 包含符号链接或特殊文件，请先整理后再导入");
        }
    }
    std::fs::set_permissions(target, source.metadata()?.permissions())?;
    Ok(())
}
/// Process-local built-in instructions. No installation in native discovery roots.
pub fn platform_instructions(directory: &Path) -> String {
    let prefs = match Skills::new(directory).and_then(|manager| manager.preferences()) {
        Ok(prefs) => prefs,
        Err(error) => {
            eprintln!(
                "Latte Work：平台技能注入已跳过，请核对 {}：{error}",
                directory.join("skills.json").display()
            );
            return String::new();
        }
    };
    if prefs
        .platform
        .get(BUILTIN_ID)
        .copied()
        .unwrap_or(SkillState::Enabled)
        == SkillState::Enabled
    {
        format!(
            "Latte Work platform skill (applies to this Work-launched session only):\n{}",
            builtin_body()
        )
    } else {
        String::new()
    }
}
fn builtin_body() -> &'static str {
    BUILTIN
        .strip_prefix("---\n")
        .and_then(|text| text.split_once("\n---\n"))
        .map_or(BUILTIN, |(_, body)| body.trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, Skills, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let state = root.join("state");
        std::fs::create_dir(&state).unwrap();
        let manager = Skills {
            directory: state,
            home: root.join("home"),
            claude: root.join("home/.claude"),
            budget: None,
        };
        let home = manager.home.clone();
        std::fs::create_dir(&home).unwrap();
        (temp, manager, home)
    }
    fn skill(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("SKILL.md"), "---\nname: Example\ndescription: >-\n  Bounded skill\n  metadata\n---\n# Body\n!`touch MUST_NOT_EXIST`\n").unwrap();
    }

    #[test]
    fn corrupt_preferences_skip_only_platform_injection_and_preserve_native_inventory() {
        for case in ["json", "oversize", "symlink"] {
            let (temp, manager, home) = setup();
            skill(&home.join(".agents/skills/native"));
            let path = manager.directory.join("skills.json");
            match case {
                "json" => std::fs::write(&path, "{invalid").unwrap(),
                "oversize" => std::fs::write(&path, " ".repeat(FILE_LIMIT as usize + 1)).unwrap(),
                _ => {
                    let target = temp.path().join("external.json");
                    std::fs::write(&target, "{}").unwrap();
                    std::os::unix::fs::symlink(target, &path).unwrap();
                }
            }
            assert!(platform_instructions(&manager.directory).is_empty());
            let catalog = manager.list(None).unwrap();
            assert_eq!(catalog.skills.len(), 1);
            assert_eq!(catalog.skills[0].scope, SkillScope::System);
            assert!(catalog.warnings.iter().any(|w| w.contains("skills.json")));
            assert!(manager.preferences().is_err());
        }
    }
    #[test]
    fn platform_context_injects_body_without_yaml_metadata() {
        let (_temp, manager, _) = setup();
        let text = platform_instructions(&manager.directory);
        assert!(text.contains("# Latte Work"));
        assert!(!text.contains("description:"));
        assert!(!text.contains("---"));
    }
    #[test]
    fn imports_enforce_entry_byte_and_depth_boundaries_without_partial_installations() {
        for (case, accepted) in [
            ("entries", true),
            ("entries", false),
            ("bytes", true),
            ("bytes", false),
            ("depth", true),
            ("depth", false),
        ] {
            let (temp, manager, home) = setup();
            let source = temp.path().canonicalize().unwrap().join("boundary");
            skill(&source);
            match case {
                "entries" => {
                    for i in 0..if accepted { 511 } else { 512 } {
                        std::fs::write(source.join(format!("file-{i}")), "").unwrap();
                    }
                }
                "bytes" => {
                    let size = 16 * 1024 * 1024
                        - std::fs::metadata(source.join("SKILL.md")).unwrap().len()
                        + u64::from(!accepted);
                    std::fs::File::create(source.join("data"))
                        .unwrap()
                        .set_len(size)
                        .unwrap();
                }
                _ => {
                    let nested = (0..if accepted { 8 } else { 9 })
                        .fold(source.clone(), |p, _| p.join("nested"));
                    std::fs::create_dir_all(&nested).unwrap();
                    std::fs::write(nested.join("data"), "kept").unwrap();
                }
            }
            let result = manager.install(None, SkillScope::System, &source);
            assert_eq!(result.is_ok(), accepted, "{case}: {result:?}");
            assert_eq!(home.join(".agents/skills/boundary").exists(), accepted);
            assert!(source.join("SKILL.md").exists());
            assert!(std::fs::read_dir(home.join(".agents")).unwrap().all(|e| {
                !e.unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".latte-work-skill-import-")
            }));
        }
    }

    #[test]
    fn imports_resolve_trusted_home_aliases_but_refuse_destination_symlinks() {
        let (temp, manager, home) = setup();
        let source = temp.path().canonicalize().unwrap().join("package");
        skill(&source);
        let alias = temp.path().join("home-alias");
        std::os::unix::fs::symlink(&home, &alias).unwrap();
        let aliased = Skills {
            home: alias,
            ..manager.clone()
        };
        aliased.install(None, SkillScope::System, &source).unwrap();
        assert!(home.join(".agents/skills/package/SKILL.md").exists());
        let other_home = temp.path().join("other-home");
        std::fs::create_dir(&other_home).unwrap();
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, other_home.join(".agents")).unwrap();
        let other = Skills {
            home: other_home,
            ..manager
        };
        assert!(other.install(None, SkillScope::System, &source).is_err());
        assert!(!outside.join("skills/package").exists());
    }
    #[test]
    fn expired_import_does_not_create_destination_directories() {
        let (temp, manager, home) = setup();
        let source = temp.path().canonicalize().unwrap().join("source");
        skill(&source);
        let manager = manager.with_budget(Budget::new(std::time::Duration::ZERO));
        assert!(manager.install(None, SkillScope::System, &source).is_err());
        assert!(!home.join(".agents").exists());
    }
    #[test]
    fn non_utf8_and_invalid_installation_names_are_reported_with_paths() {
        #[cfg(target_os = "linux")]
        use std::os::unix::ffi::OsStringExt;
        let (_temp, manager, home) = setup();
        let root = home.join(".agents/skills");
        let invalid = root.join("技能");
        skill(&invalid);
        #[cfg(target_os = "linux")]
        {
            let non_utf8 = root.join(std::ffi::OsString::from_vec(vec![0xff]));
            skill(&non_utf8);
        }
        let catalog = manager.list(None).unwrap();
        #[cfg(target_os = "linux")]
        assert!(catalog.warnings.iter().any(|w| w.contains("UTF-8")));
        assert!(
            catalog
                .warnings
                .iter()
                .any(|w| w.contains(&invalid.to_string_lossy().to_string()))
        );
    }
    #[test]
    fn scans_only_global_roots_and_preserves_project_skills() {
        let (temp, manager, home) = setup();
        skill(&home.join(".agents/skills/example"));
        skill(&manager.claude.join("skills/example"));
        let project = temp.path().join("project");
        let project_skill = project.join(".claude/skills/project-only");
        skill(&project_skill);
        let entries = manager.list(None).unwrap();
        assert_eq!(entries.skills.len(), 3);
        assert_eq!(
            entries
                .skills
                .iter()
                .filter(|s| s.scope == SkillScope::System)
                .count(),
            2
        );
        assert!(
            manager
                .list(Some(&project))
                .err()
                .unwrap()
                .to_string()
                .contains("全局")
        );
        assert!(
            manager
                .install(Some(&project), SkillScope::System, &project_skill)
                .is_err()
        );
        assert!(
            manager
                .install(None, SkillScope::Project, &project_skill)
                .is_err()
        );
        for state in [
            SkillState::Disabled,
            SkillState::Uninstalled,
            SkillState::Enabled,
        ] {
            manager.set_state(None, BUILTIN_ID, state).unwrap();
            assert_eq!(manager.detail(None, BUILTIN_ID).unwrap().0.state, state);
            assert!(!manager.claude.join("skills/latte-work-context").exists());
            assert!(!home.join(".agents/skills/latte-work-context").exists());
        }
        assert!(project_skill.join("SKILL.md").exists());
        assert!(!project.join("MUST_NOT_EXIST").exists());
    }
    #[test]
    fn native_state_moves_complete_installation_and_survives_reopen() {
        let (_temp, manager, home) = setup();
        let directory = home.join(".agents/skills/example");
        skill(&directory);
        std::fs::write(directory.join("reference.txt"), "original").unwrap();
        let id = manager
            .list(None)
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::System)
            .unwrap()
            .id;
        for state in [
            SkillState::Disabled,
            SkillState::Uninstalled,
            SkillState::Enabled,
        ] {
            manager.set_state(None, &id, state).unwrap();
            let info = manager.detail(None, &id).unwrap().0;
            assert_eq!(info.state, state);
            assert_eq!(
                std::fs::read_to_string(
                    Path::new(info.directory.as_ref().unwrap()).join("reference.txt")
                )
                .unwrap(),
                "original"
            );
        }
        assert!(
            manager
                .set_state(None, "file:unknown", SkillState::Disabled)
                .is_err()
        );
        assert!(manager.detail(None, "../../secret").is_err());
    }
    #[test]
    fn moves_skill_links_without_modifying_shared_target_and_rejects_escaping_markdown() {
        let (temp, manager, _) = setup();
        let original = temp.path().canonicalize().unwrap().join("shared");
        skill(&original);
        let root = manager.home.join(".agents/skills");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&original, root.join("linked")).unwrap();
        let entry = manager
            .list(None)
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::System)
            .unwrap();
        manager
            .set_state(None, &entry.id, SkillState::Uninstalled)
            .unwrap();
        assert!(original.join("SKILL.md").exists());
        assert!(!root.join("linked").exists());
        manager
            .set_state(None, &entry.id, SkillState::Enabled)
            .unwrap();
        assert!(
            root.join("linked")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let escape = root.join("escape");
        std::fs::create_dir(&escape).unwrap();
        std::os::unix::fs::symlink(original.join("SKILL.md"), escape.join("SKILL.md")).unwrap();
        let catalog = manager.list(None).unwrap();
        assert_eq!(catalog.skills.len(), 2);
        assert_eq!(catalog.warnings.len(), 1);
    }
    #[test]
    fn conflicts_symlink_destinations_and_oversize_files_are_explicit() {
        let (_temp, manager, home) = setup();
        let root = home.join(".agents/skills");
        skill(&root.join("example"));
        let id = manager
            .list(None)
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::System)
            .unwrap()
            .id;
        manager.set_state(None, &id, SkillState::Disabled).unwrap();
        std::fs::create_dir(root.join("example")).unwrap();
        assert!(manager.set_state(None, &id, SkillState::Enabled).is_err());
        assert!(
            state_root(&root, SkillState::Disabled)
                .unwrap()
                .join("example/SKILL.md")
                .exists()
        );
        let large = root.join("large");
        std::fs::create_dir(&large).unwrap();
        std::fs::write(large.join("SKILL.md"), vec![b'a'; FILE_LIMIT as usize + 1]).unwrap();
        assert!(!manager.list(None).unwrap().warnings.is_empty());
        let outside = home.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(
            &outside,
            state_root(&root, SkillState::Uninstalled).unwrap(),
        )
        .unwrap();
        assert!(
            manager
                .set_state(None, &id, SkillState::Uninstalled)
                .is_err()
        );
    }
    #[test]
    fn import_preserves_resources_and_original_and_rejects_unsafe_packages() {
        let (temp, manager, home) = setup();
        let source = temp.path().canonicalize().unwrap().join("imported");
        skill(&source);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(source.join("scripts")).unwrap();
        std::fs::write(source.join("scripts/check.sh"), "echo test").unwrap();
        manager.install(None, SkillScope::System, &source).unwrap();
        assert!(
            home.join(".agents/skills/imported/scripts/check.sh")
                .exists()
        );
        assert!(source.join("SKILL.md").exists());
        assert_eq!(
            std::fs::metadata(home.join(".agents/skills/imported"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(manager.install(None, SkillScope::System, &source).is_err());
        assert!(
            manager
                .install(None, SkillScope::Platform, &source)
                .is_err()
        );
        let unsafe_source = temp.path().canonicalize().unwrap().join("unsafe-package");
        skill(&unsafe_source);
        std::os::unix::fs::symlink("/etc/passwd", unsafe_source.join("secret")).unwrap();
        assert!(
            manager
                .install(None, SkillScope::System, &unsafe_source)
                .is_err()
        );
        assert!(!home.join(".agents/skills/unsafe-package").exists());
    }
    #[test]
    fn conflicting_state_copies_are_disclosed_without_duplicate_ui_identities() {
        let (_temp, manager, home) = setup();
        let root = home.join(".agents/skills");
        skill(&root.join("example"));
        let id = manager
            .list(None)
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::System)
            .unwrap()
            .id;
        manager.set_state(None, &id, SkillState::Disabled).unwrap();
        skill(&root.join("example"));
        let catalog = manager.list(None).unwrap();
        assert!(!catalog.warnings.is_empty());
        assert!(!catalog.skills.iter().any(|s| s.scope == SkillScope::System));
        assert!(
            manager
                .set_state(None, &id, SkillState::Uninstalled)
                .is_err()
        );
    }
    #[test]
    fn conflict_and_scan_warning_budgets_are_independent_and_disclose_omissions() {
        let (_temp, manager, home) = setup();
        let root = home.join(".agents/skills");
        let disabled = state_root(&root, SkillState::Disabled).unwrap();
        for n in 0..20 {
            skill(&root.join(format!("copy-{n:02}")));
            skill(&disabled.join(format!("copy-{n:02}")));
            skill(&root.join(format!("invalid name {n:02}")));
        }
        let catalog = manager.list(None).unwrap();
        assert_eq!(catalog.warnings.len(), 32);
        assert_eq!(
            catalog
                .warnings
                .iter()
                .filter(|w| w.contains("多个状态副本"))
                .count(),
            15
        );
        assert_eq!(
            catalog
                .warnings
                .iter()
                .filter(|w| w.contains("名称不符合要求"))
                .count(),
            15
        );
        assert!(
            catalog
                .warnings
                .iter()
                .any(|w| w.contains("5 条副本冲突警告"))
        );
        assert!(catalog.warnings.iter().any(|w| w.contains("5 条扫描诊断")));
        assert!(!catalog.skills.iter().any(|s| s.scope == SkillScope::System));
        assert!(catalog.warnings.iter().all(|w| w.chars().count() <= 1024));
    }
    fn uploaded(manager: &Skills, path: &str, body: &[u8]) -> latte_work_protocol::SkillImportFile {
        let mut attachments = crate::attachments::Attachments::new(&manager.directory).unwrap();
        let id = attachments
            .begin("selected-file".into(), body.len() as u64)
            .unwrap();
        for (n, chunk) in body.chunks(65536).enumerate() {
            attachments.chunk(&id, (n * 65536) as u64, chunk).unwrap();
        }
        latte_work_protocol::SkillImportFile {
            path: path.into(),
            attachment: attachments.finish(&id).unwrap().path,
        }
    }
    #[test]
    fn uploaded_skill_files_preserve_contents_and_cannot_overwrite_an_installation() {
        let (_temp, manager, home) = setup();
        let files = vec![
            uploaded(&manager, "SKILL.md", b"---\nname: uploaded\n---\nBody"),
            uploaded(&manager, "references/readme.txt", b"resource"),
        ];
        manager.import_files("uploaded", &files).unwrap();
        assert_eq!(
            std::fs::read(home.join(".agents/skills/uploaded/references/readme.txt")).unwrap(),
            b"resource"
        );
        assert!(manager.import_files("uploaded", &files).is_err());
        assert!(files.iter().all(|f| Path::new(&f.attachment).is_file()));
        assert!(!home.join(".claude/skills/uploaded").exists());
    }
    #[test]
    fn uploaded_skills_reject_paths_foreign_files_and_symlinks_without_partial_installation() {
        let (temp, manager, home) = setup();
        let skill = uploaded(&manager, "SKILL.md", b"Body");
        for path in [
            "../escape",
            "/escape",
            "a/../escape",
            "a//bad",
            "a\\bad",
            "SKILL.md",
        ] {
            let mut bad = skill.clone();
            bad.path = path.into();
            assert!(
                manager
                    .import_files("unsafe", &[skill.clone(), bad])
                    .is_err()
            );
        }
        let foreign = temp.path().join("foreign");
        std::fs::write(&foreign, "preserve").unwrap();
        let bad = latte_work_protocol::SkillImportFile {
            path: "SKILL.md".into(),
            attachment: foreign.to_str().unwrap().into(),
        };
        assert!(manager.import_files("foreign", &[bad]).is_err());
        let link = uploaded(&manager, "SKILL.md", b"placeholder");
        // Replace only this test's generated upload to exercise O_NOFOLLOW.
        std::fs::remove_file(&link.attachment).unwrap();
        std::os::unix::fs::symlink(&foreign, &link.attachment).unwrap();
        assert!(manager.import_files("linked", &[link]).is_err());
        assert_eq!(std::fs::read_to_string(foreign).unwrap(), "preserve");
        assert!(!home.join(".agents/skills").exists());
        let expired = manager.with_budget(Budget::new(std::time::Duration::ZERO));
        assert!(expired.import_files("expired", &[skill]).is_err());
    }
    #[test]
    fn uploaded_skills_bound_metadata_and_total_resources() {
        let (_temp, manager, home) = setup();
        let skill = uploaded(&manager, "SKILL.md", b"Body");
        let huge = uploaded(&manager, "resource.bin", &vec![0; 16 * 1024 * 1024]);
        assert!(manager.import_files("huge", &[skill, huge]).is_err());
        let metadata = uploaded(&manager, "SKILL.md", &vec![b'x'; 65537]);
        assert!(manager.import_files("metadata", &[metadata]).is_err());
        assert!(!home.join(".agents/skills").exists());
    }
    #[test]
    fn stale_actions_cannot_restore_an_uninstalled_skill_but_receipts_can_reconcile() {
        let (_temp, manager, _) = setup();
        manager
            .set_state_checked(
                None,
                BUILTIN_ID,
                SkillState::Enabled,
                SkillState::Uninstalled,
            )
            .unwrap();
        assert!(
            manager
                .set_state_checked(None, BUILTIN_ID, SkillState::Enabled, SkillState::Disabled)
                .is_err()
        );
        manager
            .set_state_checked(
                None,
                BUILTIN_ID,
                SkillState::Enabled,
                SkillState::Uninstalled,
            )
            .unwrap();
        assert_eq!(
            manager.detail(None, BUILTIN_ID).unwrap().0.state,
            SkillState::Uninstalled
        );
    }
    #[test]
    fn aliases_do_not_duplicate_global_inventory() {
        let (_temp, manager, _) = setup();
        let root = manager.home.join(".agents/skills");
        skill(&root.join("example"));
        std::fs::create_dir_all(&manager.claude).unwrap();
        std::os::unix::fs::symlink(&root, manager.claude.join("skills")).unwrap();
        assert_eq!(manager.list(None).unwrap().skills.len(), 2);
        let id = manager
            .list(None)
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::System)
            .unwrap()
            .id;
        manager.set_state(None, &id, SkillState::Disabled).unwrap();
        manager.set_state(None, &id, SkillState::Enabled).unwrap();
        assert_eq!(manager.list(None).unwrap().skills.len(), 2);
    }
    #[test]
    fn inventory_bounds_large_directories_and_special_files_do_not_block() {
        let (_temp, manager, _) = setup();
        let root = manager.home.join(".agents/skills");
        for i in 0..LIMIT + 2 {
            skill(&root.join(format!("skill-{i:04}")));
        }
        let catalog = manager.list(None).unwrap();
        assert!(catalog.truncated);
        assert_eq!(catalog.skills.len(), LIMIT);
        let fifo = manager.claude.join("skills/fifo");
        std::fs::create_dir_all(&fifo).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(fifo.join("SKILL.md"))
                .status()
                .unwrap()
                .success()
        );
        assert!(
            manager
                .list(None)
                .unwrap()
                .warnings
                .iter()
                .any(|s| s.contains("fifo"))
        );
    }
}
