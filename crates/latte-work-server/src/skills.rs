//! Host-owned skill inventory. Never execute skill bodies or change global Agent config.
use crate::agents::claude_skills::{field, read};
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
pub struct Skills {
    directory: PathBuf,
    home: PathBuf,
    claude: PathBuf,
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
        })
    }
    fn preferences(&self) -> Result<Preferences> {
        let path = self.directory.join("skills.json");
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
            Ok(m) if m.file_type().is_symlink() => bail!("Skill 设置不能是符号链接"),
            Ok(_) => Ok(serde_json::from_str(&read(&path, FILE_LIMIT)?)?),
            Err(e) => Err(e.into()),
        }
    }
    fn roots(&self, project: Option<&Path>) -> Vec<(SkillScope, PathBuf)> {
        let mut roots = vec![(SkillScope::System, self.claude.join("skills"))];
        for config in [".agents", ".codex", ".trae", ".traex"] {
            roots.push((SkillScope::System, self.home.join(config).join("skills")));
        }
        roots.push((SkillScope::System, self.home.join(".codex/skills/.system")));
        if let Some(project) = project {
            for config in [".claude", ".agents", ".codex", ".trae", ".traex"] {
                roots.push((SkillScope::Project, project.join(config).join("skills")));
            }
        }
        roots
    }
    fn inventory(&self, project: Option<&Path>) -> Result<(Vec<Entry>, Vec<String>, bool)> {
        let prefs = self.preferences()?;
        let mut entries = vec![Entry {
            skill: ManagedSkill {
                id: BUILTIN_ID.into(),
                name: field(BUILTIN, "name"),
                description: field(BUILTIN, "description"),
                scope: SkillScope::Platform,
                state: prefs
                    .platform
                    .get(BUILTIN_ID)
                    .copied()
                    .unwrap_or(SkillState::Enabled),
                directory: None,
                origin: "Latte Work".into(),
            },
            root: None,
            slug: "latte-work-context".into(),
        }];
        let mut warnings = Vec::new();
        let started = std::time::Instant::now();
        let mut seen = HashSet::new();
        let mut truncated = false;
        for (scope, root) in self.roots(project) {
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
            if scope == SkillScope::Project
                && !root.starts_with(project.context("项目目录无效")?.canonicalize()?)
            {
                warnings.push(format!("项目技能根目录超出项目范围：{}", root.display()));
                continue;
            }
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
                    if entries.len() >= LIMIT
                        || started.elapsed() > std::time::Duration::from_secs(3)
                    {
                        truncated = true;
                        break;
                    }
                    let Some(slug) = item.file_name().to_str().map(str::to_owned) else {
                        continue;
                    };
                    if !component(&slug) {
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
        // Descriptions and warning text have independent aggregate wire bounds.
        warnings.truncate(32);
        for warning in &mut warnings {
            *warning = warning.chars().take(1024).collect();
        }
        Ok((entries, warnings, truncated))
    }
    pub fn list(&self, project: Option<&Path>) -> Result<Catalog> {
        let (entries, mut warnings, truncated) = self.inventory(project)?;
        let mut ids = HashSet::new();
        let duplicates: HashSet<_> = entries
            .iter()
            .filter(|entry| !ids.insert(entry.skill.id.clone()))
            .map(|entry| entry.skill.id.clone())
            .collect();
        if !duplicates.is_empty() {
            warnings.push(
                "部分技能有多个状态副本，请先核对 skills 及其禁用／卸载目录，刷新后再操作。".into(),
            );
        }
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
        if matching.next().is_some() {
            bail!("Skill 有多个状态副本，请先核对安装目录");
        }
        Ok(entry)
    }
    pub fn detail(&self, project: Option<&Path>, id: &str) -> Result<(ManagedSkill, String)> {
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
            std::fs::rename(&source, &destination)
                .context("无法移动 Skill，请检查目录权限和目标位置")?;
        } else {
            let mut prefs = self.preferences()?;
            prefs.platform.insert(id.into(), state);
            let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
            use std::io::Write;
            file.write_all(&serde_json::to_vec(&prefs)?)?;
            file.as_file().sync_all()?;
            file.persist(self.directory.join("skills.json"))?;
        }
        Ok(())
    }
    pub fn install(&self, project: Option<&Path>, scope: SkillScope, source: &Path) -> Result<()> {
        if scope == SkillScope::Platform {
            bail!("平台技能随 Latte Work 提供，请从详情重新安装");
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
        let root = match scope {
            SkillScope::System => self.home.join(".agents/skills"),
            SkillScope::Project => project.context("请先选择项目")?.join(".agents/skills"),
            SkillScope::Platform => unreachable!(),
        };
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
        copy_tree(&source, &target, 0, &mut budget)?;
        std::fs::rename(target, root.join(slug))?;
        Ok(())
    }
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
fn copy_tree(source: &Path, target: &Path, depth: usize, budget: &mut (usize, u64)) -> Result<()> {
    if depth > 8 {
        bail!("Skill 目录层数超过 8 层");
    }
    std::fs::create_dir(target)?;
    for item in std::fs::read_dir(source)? {
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
            file.take(meta.len() + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 != meta.len() {
                bail!("Skill 文件在读取期间发生变化");
            }
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target.join(item.file_name()))?;
            out.write_all(&bytes)?;
            std::fs::set_permissions(target.join(item.file_name()), meta.permissions())?;
        } else {
            bail!("Skill 包含符号链接或特殊文件，请先整理后再导入");
        }
    }
    std::fs::set_permissions(target, source.metadata()?.permissions())?;
    Ok(())
}
/// Process-local built-in instructions. No installation in native discovery roots.
pub fn platform_instructions(directory: &Path) -> Result<String> {
    let manager = Skills::new(directory)?;
    let prefs = manager.preferences()?;
    Ok(
        if prefs
            .platform
            .get(BUILTIN_ID)
            .copied()
            .unwrap_or(SkillState::Enabled)
            == SkillState::Enabled
        {
            format!(
                "Latte Work platform skill (applies to this Work-launched session only):\n{BUILTIN}"
            )
        } else {
            String::new()
        },
    )
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
        };
        let project = root.join("project");
        std::fs::create_dir(&project).unwrap();
        (temp, manager, project)
    }
    fn skill(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("SKILL.md"), "---\nname: Example\ndescription: >-\n  Bounded skill\n  metadata\n---\n# Body\n!`touch MUST_NOT_EXIST`\n").unwrap();
    }
    #[test]
    fn scans_scopes_and_persists_platform_without_touching_native_directories() {
        let (_temp, manager, project) = setup();
        skill(&manager.home.join(".agents/skills/example"));
        skill(&manager.claude.join("skills/example"));
        skill(&project.join(".claude/skills/example"));
        let entries = manager.list(Some(&project)).unwrap();
        assert_eq!(entries.skills.len(), 4);
        assert_eq!(
            entries
                .skills
                .iter()
                .filter(|s| s.scope == SkillScope::System)
                .count(),
            2
        );
        assert_eq!(
            entries
                .skills
                .iter()
                .filter(|s| s.scope == SkillScope::Project)
                .count(),
            1
        );
        for state in [
            SkillState::Disabled,
            SkillState::Uninstalled,
            SkillState::Enabled,
        ] {
            manager.set_state(None, BUILTIN_ID, state).unwrap();
            assert_eq!(manager.detail(None, BUILTIN_ID).unwrap().0.state, state);
            assert!(!manager.claude.join("skills/latte-work-context").exists());
            assert!(
                !manager
                    .home
                    .join(".agents/skills/latte-work-context")
                    .exists()
            );
        }
        assert!(!project.join("MUST_NOT_EXIST").exists());
    }
    #[test]
    fn native_state_moves_complete_installation_and_survives_reopen() {
        let (_temp, manager, project) = setup();
        let directory = project.join(".agents/skills/example");
        skill(&directory);
        std::fs::write(directory.join("reference.txt"), "original").unwrap();
        let id = manager
            .list(Some(&project))
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::Project)
            .unwrap()
            .id;
        for state in [
            SkillState::Disabled,
            SkillState::Uninstalled,
            SkillState::Enabled,
        ] {
            manager.set_state(Some(&project), &id, state).unwrap();
            let info = manager.detail(Some(&project), &id).unwrap().0;
            assert_eq!(info.state, state);
            assert_eq!(
                std::fs::read_to_string(
                    Path::new(info.directory.as_ref().unwrap()).join("reference.txt")
                )
                .unwrap(),
                "original"
            );
        }
        assert!(manager.set_state(None, &id, SkillState::Disabled).is_err());
        assert!(manager.detail(Some(&project), "../../secret").is_err());
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
        let (_temp, manager, project) = setup();
        let root = project.join(".agents/skills");
        skill(&root.join("example"));
        let id = manager
            .list(Some(&project))
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::Project)
            .unwrap()
            .id;
        manager
            .set_state(Some(&project), &id, SkillState::Disabled)
            .unwrap();
        std::fs::create_dir(root.join("example")).unwrap();
        assert!(
            manager
                .set_state(Some(&project), &id, SkillState::Enabled)
                .is_err()
        );
        assert!(
            state_root(&root, SkillState::Disabled)
                .unwrap()
                .join("example/SKILL.md")
                .exists()
        );
        let large = root.join("large");
        std::fs::create_dir(&large).unwrap();
        std::fs::write(large.join("SKILL.md"), vec![b'a'; FILE_LIMIT as usize + 1]).unwrap();
        assert!(!manager.list(Some(&project)).unwrap().warnings.is_empty());
        let outside = project.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(
            &outside,
            state_root(&root, SkillState::Uninstalled).unwrap(),
        )
        .unwrap();
        assert!(
            manager
                .set_state(Some(&project), &id, SkillState::Uninstalled)
                .is_err()
        );
    }
    #[test]
    fn import_preserves_resources_and_original_and_rejects_unsafe_packages() {
        let (temp, manager, project) = setup();
        let source = temp.path().canonicalize().unwrap().join("imported");
        skill(&source);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(source.join("scripts")).unwrap();
        std::fs::write(source.join("scripts/check.sh"), "echo test").unwrap();
        manager
            .install(Some(&project), SkillScope::Project, &source)
            .unwrap();
        assert!(
            project
                .join(".agents/skills/imported/scripts/check.sh")
                .exists()
        );
        assert!(source.join("SKILL.md").exists());
        assert_eq!(
            std::fs::metadata(project.join(".agents/skills/imported"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(
            manager
                .install(Some(&project), SkillScope::Project, &source)
                .is_err()
        );
        assert!(manager.install(None, SkillScope::Project, &source).is_err());
        assert!(
            manager
                .install(None, SkillScope::Platform, &source)
                .is_err()
        );
        std::os::unix::fs::symlink("/etc/passwd", source.join("secret")).unwrap();
        assert!(manager.install(None, SkillScope::System, &source).is_err());
        assert!(!manager.home.join(".agents/skills/imported").exists());
    }
    #[test]
    fn conflicting_state_copies_are_disclosed_without_duplicate_ui_identities() {
        let (_temp, manager, project) = setup();
        let root = project.join(".agents/skills");
        skill(&root.join("example"));
        let id = manager
            .list(Some(&project))
            .unwrap()
            .skills
            .into_iter()
            .find(|s| s.scope == SkillScope::Project)
            .unwrap()
            .id;
        manager
            .set_state(Some(&project), &id, SkillState::Disabled)
            .unwrap();
        skill(&root.join("example"));
        let catalog = manager.list(Some(&project)).unwrap();
        assert!(!catalog.warnings.is_empty());
        assert!(
            !catalog
                .skills
                .iter()
                .any(|s| s.scope == SkillScope::Project)
        );
        assert!(
            manager
                .set_state(Some(&project), &id, SkillState::Uninstalled)
                .is_err()
        );
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
    fn aliases_do_not_duplicate_inventory_and_project_roots_cannot_escape() {
        let (_temp, manager, project) = setup();
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
        std::os::unix::fs::symlink(manager.home.join(".agents"), project.join(".agents")).unwrap();
        let catalog = manager.list(Some(&project)).unwrap();
        assert!(!catalog.warnings.is_empty());
        assert!(
            !catalog
                .skills
                .iter()
                .any(|s| s.scope == SkillScope::Project)
        );
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
