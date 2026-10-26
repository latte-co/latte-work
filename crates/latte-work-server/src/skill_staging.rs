//! Recover only marked, unlocked Skill import scratch directories.
use crate::skill_worker::Budget;
use anyhow::{Result, bail};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

const LEASE: &str = ".latte-work-stage";
const MARKER: &[u8] = b"latte-work-skill-stage-v1\n";
pub struct Staging {
    // Remove the scratch tree while its lease is still locked.
    directory: tempfile::TempDir,
    _lease: File,
}
fn check(budget: Option<&Budget>) -> Result<()> {
    budget.map_or(Ok(()), Budget::check)
}
impl Staging {
    pub fn new(parent: &Path, prefix: &str, budget: Option<&Budget>) -> Result<Self> {
        check(budget)?;
        let mut recovered = 0;
        for entry in std::fs::read_dir(parent)?.take(512) {
            check(budget)?;
            let entry = entry?;
            let name = entry.file_name();
            let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix(prefix)) else {
                continue;
            };
            if suffix.len() != 6
                || !suffix.bytes().all(|b| b.is_ascii_alphanumeric())
                || !entry.file_type()?.is_dir()
            {
                continue;
            }
            let Ok(mut lease) = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
                .open(entry.path().join(LEASE))
            else {
                continue;
            };
            if !lease.metadata()?.is_file()
                || lease.metadata()?.len() != MARKER.len() as u64
                || lease.try_lock().is_err()
            {
                continue;
            }
            let mut marker = [0; MARKER.len()];
            lease.read_exact(&mut marker)?;
            if marker != MARKER {
                continue;
            }
            remove(&entry.path(), 0, &mut 0, budget)?;
            recovered += 1;
            if recovered == 8 {
                break;
            }
        }
        check(budget)?;
        let directory = tempfile::Builder::new().prefix(prefix).tempdir_in(parent)?;
        let mut lease = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(directory.path().join(LEASE))?;
        lease.try_lock()?;
        lease.write_all(MARKER)?;
        Ok(Self {
            directory,
            _lease: lease,
        })
    }
    pub fn path(&self) -> &Path {
        self.directory.path()
    }
}
fn remove(path: &Path, depth: usize, count: &mut usize, budget: Option<&Budget>) -> Result<()> {
    check(budget)?;
    if depth > 10 {
        bail!("技能暂存目录层数异常，请手动核对：{}", path.display());
    }
    for entry in std::fs::read_dir(path)? {
        check(budget)?;
        let entry = entry?;
        if depth == 0 && entry.file_name() == LEASE {
            continue;
        }
        *count += 1;
        if *count > 516 {
            bail!("技能暂存目录项数异常，请手动核对：{}", path.display());
        }
        if entry.file_type()?.is_dir() {
            remove(&entry.path(), depth + 1, count, budget)?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    check(budget)?;
    // Keep the marker until payload removal succeeds, so cancellation is recoverable.
    if depth == 0 {
        std::fs::remove_file(path.join(LEASE))?;
    }
    std::fs::remove_dir(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovers_abandoned_stages_but_preserves_active_unmarked_and_linked_paths() {
        let parent = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "preserve").unwrap();
        let active = Staging::new(parent.path(), "skill-upload-", None).unwrap();
        let abandoned = Staging::new(parent.path(), "skill-upload-", None).unwrap();
        std::fs::write(abandoned.path().join("partial"), "scratch").unwrap();
        std::os::unix::fs::symlink(outside.path(), abandoned.path().join("reference")).unwrap();
        let Staging {
            directory,
            _lease: lease,
        } = abandoned;
        let abandoned = directory.keep();
        drop(lease);
        let unmarked = tempfile::Builder::new()
            .prefix("skill-upload-")
            .tempdir_in(parent.path())
            .unwrap();
        let linked = parent.path().join("skill-upload-ABCDEF");
        std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
        let fresh = Staging::new(parent.path(), "skill-upload-", None).unwrap();
        assert!(!abandoned.exists());
        assert!(active.path().exists());
        assert!(unmarked.path().exists());
        assert!(linked.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(outside.path().join("keep").exists());
        assert!(fresh.path().exists());
    }
    #[test]
    fn bounds_recovery_work_and_keeps_the_marker_for_a_later_retry() {
        let parent = tempfile::tempdir().unwrap();
        let Staging {
            directory,
            _lease: lease,
        } = Staging::new(parent.path(), "stage-", None).unwrap();
        for n in 0..517 {
            std::fs::write(directory.path().join(format!("item-{n}")), []).unwrap();
        }
        let abandoned = directory.keep();
        drop(lease);
        assert!(Staging::new(parent.path(), "stage-", None).is_err());
        assert!(abandoned.join(LEASE).exists());
        assert!(Staging::new(parent.path(), "stage-", None).is_ok());
        assert!(!abandoned.exists());
    }
    #[test]
    fn cleanup_respects_cancellation_and_keeps_recovery_marker() {
        let parent = tempfile::tempdir().unwrap();
        let Staging {
            directory,
            _lease: lease,
        } = Staging::new(parent.path(), "stage-", None).unwrap();
        let abandoned = directory.keep();
        drop(lease);
        let budget = Budget::new(std::time::Duration::ZERO);
        assert!(Staging::new(parent.path(), "stage-", Some(&budget)).is_err());
        assert!(abandoned.join(LEASE).exists());
        assert!(Staging::new(parent.path(), "stage-", None).is_ok());
        assert!(!abandoned.exists());
    }
}
