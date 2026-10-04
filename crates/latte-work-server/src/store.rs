//! SQLite is the source of truth for sessions and replayable presentation events.
use anyhow::{Context, Result, bail};
use latte_work_protocol::{Effort, Event, EventKind, Project, Session, Status};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub struct Store {
    db: Connection,
}
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS hidden_projects(project_id TEXT PRIMARY KEY REFERENCES projects(id));
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), at REAL NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,text TEXT NOT NULL);")?;
        let columns = db
            .prepare("PRAGMA table_info(requests)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !columns.iter().any(|name| name == "model") {
            db.execute("ALTER TABLE requests ADD COLUMN model TEXT", [])?;
        }
        if !columns.iter().any(|name| name == "effort") {
            db.execute("ALTER TABLE requests ADD COLUMN effort TEXT", [])?;
        }
        if !columns.iter().any(|name| name == "provider_fingerprint") {
            db.execute(
                "ALTER TABLE requests ADD COLUMN provider_fingerprint TEXT",
                [],
            )?;
        }
        if !columns.iter().any(|name| name == "permission_mode") {
            db.execute("ALTER TABLE requests ADD COLUMN permission_mode TEXT", [])?;
        }
        let store = Self { db };
        let interrupted = store.all_sessions()?;
        for mut session in interrupted.into_iter().filter(|s| s.status.active()) {
            session.status = Status::Unknown;
            store.save(&session)?;
            store.event(
                &session.id,
                EventKind::State {
                    status: Status::Unknown,
                    message: Some("Server 已重启，先前执行结果未知；请核对文件后继续。".into()),
                },
            )?;
        }
        Ok(store)
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let hidden = self
            .db
            .prepare("SELECT project_id FROM hidden_projects")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(self
            .all_projects()?
            .into_iter()
            .filter(|p| !hidden.contains(&p.id))
            .collect())
    }
    fn all_projects(&self) -> Result<Vec<Project>> {
        Ok(self
            .db
            .prepare("SELECT id,name,path FROM projects ORDER BY name")?
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn project(&self, id: &str) -> Result<Project> {
        self.all_projects()?
            .into_iter()
            .find(|p| p.id == id)
            .context("项目不存在")
    }
    #[cfg(test)]
    pub fn add_project(&self, path: &Path) -> Result<Project> {
        self.add_named_project(path, None)
    }
    pub fn add_named_project(&self, path: &Path, name: Option<&str>) -> Result<Project> {
        let name = name.map(str::trim).filter(|v| !v.is_empty());
        if name.is_some_and(|v| v.chars().count() > 100 || v.chars().any(char::is_control)) {
            bail!("项目名称不能超过 100 个字符或包含控制字符");
        }
        if !path.is_absolute() {
            bail!("项目路径必须是绝对路径");
        }
        let canonical = path.canonicalize().context("项目目录不存在或无法访问")?;
        if !canonical.is_dir() {
            bail!("请选择目录");
        }
        let path = canonical.to_str().context("项目路径不是 UTF-8")?.to_owned();
        if let Some(existing) = self.all_projects()?.into_iter().find(|p| p.path == path) {
            self.db.execute(
                "DELETE FROM hidden_projects WHERE project_id=?1",
                [&existing.id],
            )?;
            return Ok(existing);
        }
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name.map(str::to_owned).unwrap_or_else(|| {
                canonical
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }),
            path,
        };
        self.db.execute(
            "INSERT INTO projects VALUES (?1,?2,?3)",
            params![project.id, project.name, project.path],
        )?;
        Ok(project)
    }
    pub fn rename_project(&self, id: &str, name: &str) -> Result<Project> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
            bail!("项目名称不能为空、超过 100 个字符或包含控制字符");
        }
        let mut project = self.project(id)?;
        self.db
            .execute("UPDATE projects SET name=?1 WHERE id=?2", params![name, id])?;
        project.name = name.into();
        Ok(project)
    }
    pub fn remove_project(&self, id: &str) -> Result<()> {
        self.project(id)?;
        if self
            .all_sessions()?
            .iter()
            .any(|s| s.project_id == id && s.status.active())
        {
            bail!("项目中还有运行中的任务，请等待完成或停止后再移除");
        }
        self.db.execute(
            "INSERT OR IGNORE INTO hidden_projects(project_id) VALUES(?1)",
            [id],
        )?;
        Ok(())
    }
    pub fn has_active_sessions(&self) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE json_extract(data, '$.status') IN ('running', 'waiting'))", [], |row| row.get(0))?)
    }
    fn all_sessions(&self) -> Result<Vec<Session>> {
        let rows = self
            .db
            .prepare("SELECT data FROM sessions ORDER BY rowid DESC")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    pub fn sessions(&self, project: &str) -> Result<Vec<Session>> {
        self.project(project)?;
        Ok(self
            .all_sessions()?
            .into_iter()
            .filter(|s| s.project_id == project)
            .take(500)
            .collect())
    }
    pub fn session(&self, id: &str) -> Result<Session> {
        let data: String = self
            .db
            .query_row("SELECT data FROM sessions WHERE id=?1", [id], |r| r.get(0))
            .context("会话不存在")?;
        Ok(serde_json::from_str(&data)?)
    }
    pub fn create_session(&self, project_id: String, agent: String) -> Result<Session> {
        self.project(&project_id)?;
        let session = Session {
            id: Uuid::new_v4().to_string(),
            project_id,
            title: "新任务".into(),
            agent,
            native_id: None,
            model: None,
            effort: None,
            permission_mode: None,
            status: Status::Ready,
            created_at: now(),
            custom_title: false,
            pinned_at: None,
            unread: false,
            archived: false,
            agent_session_open: None,
            agent_session_busy: None,
        };
        self.db.execute(
            "INSERT INTO sessions VALUES (?1,?2,?3)",
            params![
                session.id,
                session.project_id,
                serde_json::to_string(&session)?
            ],
        )?;
        Ok(session)
    }
    pub fn pinned_sessions(&self) -> Result<Vec<Session>> {
        let rows = self.db.prepare("SELECT data FROM sessions WHERE json_extract(data, '$.pinned_at') IS NOT NULL AND COALESCE(json_extract(data, '$.archived'),0)=0 AND project_id NOT IN (SELECT project_id FROM hidden_projects) ORDER BY json_extract(data, '$.pinned_at') DESC LIMIT 100")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    pub fn rename_session(&self, id: &str, title: &str) -> Result<Session> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 100 || title.chars().any(char::is_control) {
            bail!("会话名称不能为空、超过 100 个字符或包含控制字符");
        }
        let mut session = self.session(id)?;
        session.title = title.into();
        session.custom_title = true;
        self.save(&session)?;
        Ok(session)
    }
    pub fn pin_session(&self, id: &str, pinned: bool) -> Result<Session> {
        let mut session = self.session(id)?;
        if pinned && session.archived {
            bail!("请先取消归档再置顶");
        }
        if pinned && session.pinned_at.is_none() && self.pinned_sessions()?.len() >= 100 {
            bail!("每台主机最多置顶 100 个会话");
        }
        session.pinned_at = if pinned {
            Some(session.pinned_at.unwrap_or_else(now))
        } else {
            None
        };
        self.save(&session)?;
        Ok(session)
    }
    pub fn mark_session_unread(&self, id: &str, unread: bool) -> Result<Session> {
        let mut session = self.session(id)?;
        session.unread = unread;
        self.save(&session)?;
        Ok(session)
    }
    pub fn archive_session(&self, id: &str, archived: bool) -> Result<Session> {
        let mut session = self.session(id)?;
        if archived && session.status.active() {
            bail!("请先停止任务，再归档会话");
        }
        session.archived = archived;
        if archived {
            session.pinned_at = None;
        }
        self.save(&session)?;
        Ok(session)
    }
    pub fn save(&self, session: &Session) -> Result<()> {
        self.db.execute(
            "UPDATE sessions SET data=?2 WHERE id=?1",
            params![session.id, serde_json::to_string(session)?],
        )?;
        Ok(())
    }
    pub fn event(&self, id: &str, event: EventKind) -> Result<()> {
        self.db.execute(
            "INSERT INTO events(session_id,at,data) VALUES (?1,?2,?3)",
            params![id, now(), serde_json::to_string(&event)?],
        )?;
        Ok(())
    }
    pub fn state(&mut self, id: &str, status: Status, message: Option<String>) -> Result<()> {
        let mut session = self.session(id)?;
        if session.status.active()
            && matches!(status, Status::Completed | Status::Failed | Status::Stopped)
        {
            session.unread = true;
        }
        session.status = status.clone();
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE sessions SET data=?2 WHERE id=?1",
            params![id, serde_json::to_string(&session)?],
        )?;
        tx.execute(
            "INSERT INTO events(session_id,at,data) VALUES (?1,?2,?3)",
            params![
                id,
                now(),
                serde_json::to_string(&EventKind::State { status, message })?
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Checks durable request identity before current launch configuration is consulted.
    #[allow(clippy::too_many_arguments)]
    pub fn already_accepted(
        &self,
        id: &str,
        request_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<Effort>,
        provider_fingerprint: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<bool> {
        if request_id.is_empty()
            || request_id.len() > 100
            || text.trim().is_empty()
            || text.len() > 128 * 1024
        {
            bail!("任务内容或请求 ID 无效（输入上限 128 KiB）");
        }
        let existing = self
            .db
            .query_row(
                "SELECT session_id,text,model,effort,provider_fingerprint,permission_mode FROM requests WHERE id=?1",
                [request_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;
        if let Some((
            session,
            previous,
            previous_model,
            previous_effort,
            previous_provider,
            previous_permission,
        )) = existing
        {
            if session != id
                || previous != text
                || previous_model.as_deref() != model
                || previous_effort.as_deref() != effort.map(Effort::as_str)
                || previous_permission.as_deref() != permission_mode
            {
                bail!("请求 ID 已被其他任务使用");
            }
            if previous_provider.as_deref() != provider_fingerprint {
                bail!("此请求已接受，但 Provider 配置已改变；请核对原请求状态后再发送新消息");
            }
            return Ok(true);
        }
        Ok(false)
    }
    /// Returns false for an exact already-accepted request; conflicting reuse fails.
    #[allow(clippy::too_many_arguments)]
    pub fn begin(
        &mut self,
        id: &str,
        request_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<Effort>,
        provider_fingerprint: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<bool> {
        if self.already_accepted(
            id,
            request_id,
            text,
            model,
            effort,
            provider_fingerprint,
            permission_mode,
        )? {
            return Ok(false);
        }
        let mut session = self.session(id)?;
        if session.status.active() {
            bail!("会话已有运行中的任务");
        }
        if session.archived {
            bail!("请先取消归档再发送消息");
        }
        session.status = Status::Running;
        session.model = model.map(str::to_owned);
        session.effort = effort;
        session.permission_mode = permission_mode.map(str::to_owned);
        if !session.custom_title && session.title == "新任务" {
            session.title = text.chars().take(48).collect();
        }
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO requests(id,session_id,text,model,effort,provider_fingerprint,permission_mode) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![request_id, id, text, model, effort.map(Effort::as_str), provider_fingerprint, permission_mode],
        )?;
        tx.execute(
            "UPDATE sessions SET data=?2 WHERE id=?1",
            params![id, serde_json::to_string(&session)?],
        )?;
        for event in [
            EventKind::User {
                text: text.into(),
                request_id: request_id.into(),
            },
            EventKind::State {
                status: Status::Running,
                message: None,
            },
        ] {
            tx.execute(
                "INSERT INTO events(session_id,at,data) VALUES (?1,?2,?3)",
                params![id, now(), serde_json::to_string(&event)?],
            )?;
        }
        tx.commit()?;
        Ok(true)
    }
    /// Reverse pages avoid replaying every historical tool output to show the latest reply.
    pub fn history(
        &self,
        id: &str,
        before: Option<f64>,
    ) -> Result<(Vec<Event>, bool, bool, Option<f64>)> {
        if before.is_some_and(|v| !v.is_finite() || v < 0.0) {
            bail!("事件游标无效");
        }
        let mut statement = self.db.prepare(
            "SELECT seq,at,data FROM events WHERE session_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT 16385"
        )?;
        let mut rows = statement.query(params![id, before.unwrap_or(f64::MAX)])?;
        let mut events: Vec<Event> = Vec::new();
        let mut text_fragments: Vec<String> = Vec::new();
        let mut bytes = 0;
        let mut oldest = None;
        let mut count = 0;
        let mut turns = 0;
        let mut has_more = false;
        let mut split_text = false;
        while let Some(row) = rows.next()? {
            let data: String = row.get(2)?;
            let event: EventKind = serde_json::from_str(&data)?;
            let text = match &event {
                EventKind::Text { text } => Some(text),
                _ => None,
            };
            let joins = text.is_some()
                && events
                    .last()
                    .is_some_and(|e| matches!(e.event, EventKind::Text { .. }));
            let size = text.map_or(data.len() + id.len() + 96, |t| {
                t.len() + if joins { 0 } else { id.len() + 96 }
            });
            if turns == 2
                || count == 16384
                || (!joins && events.len() == 128)
                || (bytes + size > 256 * 1024 && !events.is_empty())
            {
                has_more = true;
                split_text = joins;
                break;
            }
            if !joins {
                flush_history_text(&mut events, &mut text_fragments);
            }
            oldest = Some(row.get::<_, i64>(0)? as f64);
            if matches!(event, EventKind::User { .. }) {
                turns += 1;
            }
            let event = match event {
                EventKind::Text { text } => {
                    text_fragments.push(text);
                    EventKind::Text {
                        text: String::new(),
                    }
                }
                other => other,
            };
            if !joins {
                events.push(Event {
                    seq: oldest.unwrap(),
                    session_id: id.into(),
                    at: row.get(1)?,
                    event,
                });
            }
            count += 1;
            bytes += size;
        }
        flush_history_text(&mut events, &mut text_fragments);
        events.reverse();
        let mut needs_earlier = has_more && split_text;
        if has_more && let Some(first) = oldest {
            // Only unresolved approvals in the current live turn force an earlier window.
            let pending: bool = self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM events a WHERE a.session_id=?1 AND a.seq<?2
                 AND json_extract(a.data,'$.kind')='approval'
                 AND a.seq>COALESCE((SELECT MAX(u.seq) FROM events u WHERE u.session_id=a.session_id
                 AND json_extract(u.data,'$.kind')='user'),0)
                 AND NOT EXISTS(SELECT 1 FROM events e WHERE e.session_id=a.session_id AND e.seq>a.seq
                 AND json_extract(e.data,'$.kind')='state' AND json_extract(e.data,'$.status') NOT IN ('running','waiting'))
                 AND NOT EXISTS(SELECT 1 FROM events r WHERE r.session_id=a.session_id AND r.seq>a.seq
                 AND json_extract(r.data,'$.kind')='approval_resolved'
                 AND json_extract(r.data,'$.request_id')=json_extract(a.data,'$.request_id')))",
                params![id, first], |r| r.get(0)
            )?;
            needs_earlier |= pending;
        }
        Ok((
            events,
            has_more,
            needs_earlier,
            if has_more { oldest } else { None },
        ))
    }
    pub fn events(&self, id: &str, after: f64) -> Result<(Vec<Event>, bool)> {
        if !after.is_finite() || after < 0.0 {
            bail!("事件游标无效");
        }
        let rows=self.db.prepare("SELECT seq,at,data FROM events WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT 201")?.query_map(params![id,after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,f64>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut events = Vec::new();
        let mut bytes = 0;
        for (seq, at, data) in rows {
            bytes += data.len();
            if events.len() == 200 || (bytes > 1024 * 1024 && !events.is_empty()) {
                return Ok((events, true));
            }
            events.push(Event {
                seq: seq as f64,
                session_id: id.into(),
                at,
                event: serde_json::from_str(&data)?,
            });
        }
        Ok((events, false))
    }
}
fn flush_history_text(events: &mut [Event], fragments: &mut Vec<String>) {
    if let Some(Event {
        event: EventKind::Text { text },
        ..
    }) = events.last_mut()
    {
        *text = fragments.drain(..).rev().collect();
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn history_compacts_stream_chunks_and_pages_with_raw_cursors_without_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::Store::open(&dir.path().join("history.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        // Large older tool output must not delay the latest compact reply.
        for i in 0..300 {
            store
                .event(
                    &session.id,
                    super::EventKind::Notice {
                        text: format!("old-{i}"),
                    },
                )
                .unwrap();
        }
        store
            .event(
                &session.id,
                super::EventKind::User {
                    text: "latest".into(),
                    request_id: "latest".into(),
                },
            )
            .unwrap();
        for _ in 0..3000 {
            store
                .event(
                    &session.id,
                    super::EventKind::Text {
                        text: "你好".into(),
                    },
                )
                .unwrap();
        }
        store
            .event(
                &session.id,
                super::EventKind::State {
                    status: super::Status::Completed,
                    message: None,
                },
            )
            .unwrap();
        let raw = store
            .db
            .query_row(
                "SELECT COUNT(*) FROM events WHERE session_id=?1",
                [&session.id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap();
        let (latest, more, needs, mut cursor) = store.history(&session.id, None).unwrap();
        assert!(more);
        assert!(!needs);
        assert!(latest.len() <= 128);
        assert_eq!(
            latest
                .iter()
                .filter_map(|e| match &e.event {
                    super::EventKind::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
            "你好".repeat(3000)
        );
        let newest = latest.last().unwrap().seq;
        assert!(store.events(&session.id, newest).unwrap().0.is_empty());
        let mut merged = latest;
        while more && cursor.is_some() {
            let (page, has_more, _, next) = store.history(&session.id, cursor).unwrap();
            assert!(page.last().unwrap().seq < cursor.unwrap());
            assert!(next.is_none_or(|n| n < cursor.unwrap()));
            merged.splice(0..0, page);
            cursor = if has_more { next } else { None };
        }
        assert_eq!(
            merged
                .iter()
                .filter(|e| matches!(e.event, super::EventKind::Notice { .. }))
                .count(),
            300
        );
        assert_eq!(
            store
                .db
                .query_row(
                    "SELECT COUNT(*) FROM events WHERE session_id=?1",
                    [&session.id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            raw
        );
        assert!(store.history(&session.id, Some(-1.0)).is_err());
    }
    #[test]
    fn bounded_history_preserves_split_text_and_pending_approvals_until_resolved_or_expired() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::Store::open(&dir.path().join("history.db")).unwrap();
        let p = store.add_project(dir.path()).unwrap();
        let s = store.create_session(p.id, "claude".into()).unwrap();
        store
            .event(
                &s.id,
                super::EventKind::Approval {
                    request_id: "a".into(),
                    tool_use_id: None,
                    tool: "Write".into(),
                    input: serde_json::json!({}),
                },
            )
            .unwrap();
        for _ in 0..300 {
            store
                .event(
                    &s.id,
                    super::EventKind::Notice {
                        text: "background".into(),
                    },
                )
                .unwrap();
        }
        assert!(store.history(&s.id, None).unwrap().2);
        store
            .event(
                &s.id,
                super::EventKind::ApprovalResolved {
                    request_id: "a".into(),
                    allow: true,
                },
            )
            .unwrap();
        assert!(!store.history(&s.id, None).unwrap().2);
        store
            .event(
                &s.id,
                super::EventKind::Approval {
                    request_id: "b".into(),
                    tool_use_id: None,
                    tool: "Read".into(),
                    input: serde_json::json!({}),
                },
            )
            .unwrap();
        for _ in 0..300 {
            store
                .event(
                    &s.id,
                    super::EventKind::Notice {
                        text: "background".into(),
                    },
                )
                .unwrap();
        }
        store
            .event(
                &s.id,
                super::EventKind::State {
                    status: super::Status::Failed,
                    message: None,
                },
            )
            .unwrap();
        assert!(!store.history(&s.id, None).unwrap().2);
        for _ in 0..400 {
            store
                .event(
                    &s.id,
                    super::EventKind::Text {
                        text: "x".repeat(1024),
                    },
                )
                .unwrap();
        }
        let (tail, more, split, cursor) = store.history(&s.id, None).unwrap();
        assert!(more && split);
        assert!(serde_json::to_vec(&tail).unwrap().len() < 270 * 1024);
        let (head, _, split, _) = store.history(&s.id, cursor).unwrap();
        assert!(!split);
        let text = head
            .iter()
            .chain(&tail)
            .filter_map(|e| match &e.event {
                super::EventKind::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(text.len(), 400 * 1024);
    }
    #[test]
    fn permission_survives_restart_and_conflicting_request_reuse_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permissions.db");
        let mut store = super::Store::open(&path).unwrap();
        let p = store.add_project(dir.path()).unwrap();
        let session = store.create_session(p.id, "claude".into()).unwrap();
        store
            .begin(
                &session.id,
                "permission",
                "hello",
                None,
                None,
                None,
                Some("plan"),
            )
            .unwrap();
        drop(store);
        let mut store = super::Store::open(&path).unwrap();
        assert_eq!(
            store
                .session(&session.id)
                .unwrap()
                .permission_mode
                .as_deref(),
            Some("plan")
        );
        assert!(
            !store
                .begin(
                    &session.id,
                    "permission",
                    "hello",
                    None,
                    None,
                    None,
                    Some("plan")
                )
                .unwrap()
        );
        assert!(
            store
                .begin(
                    &session.id,
                    "permission",
                    "hello",
                    None,
                    None,
                    None,
                    Some("bypassPermissions")
                )
                .is_err()
        );
        assert!(
            store
                .begin(&session.id, "permission", "hello", None, None, None, None)
                .is_err()
        );
        store
            .begin(&session.id, "native", "hello", None, None, None, None)
            .unwrap();
        assert!(
            store
                .session(&session.id)
                .unwrap()
                .permission_mode
                .is_none()
        );
    }

    use super::*;
    #[test]
    fn turn_fingerprint_is_durable_and_conflicting_retries_fail() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("state.db");
        let mut store = Store::open(&path).unwrap();
        let project = store.add_project(tmp.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        assert!(
            store
                .begin(
                    &session.id,
                    "snapshot",
                    "hello",
                    None,
                    None,
                    Some("digest-a"),
                    None
                )
                .unwrap()
        );
        drop(store);
        let mut reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.session(&session.id).unwrap().status,
            Status::Unknown
        );
        assert!(
            !reopened
                .begin(
                    &session.id,
                    "snapshot",
                    "hello",
                    None,
                    None,
                    Some("digest-a"),
                    None
                )
                .unwrap()
        );
        assert!(
            reopened
                .begin(
                    &session.id,
                    "snapshot",
                    "hello",
                    None,
                    None,
                    Some("digest-b"),
                    None
                )
                .is_err()
        );
        assert!(
            reopened
                .begin(&session.id, "snapshot", "hello", None, None, None, None)
                .is_err()
        );
    }
    #[test]
    fn session_organization_preserves_history_and_survives_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("state.db");
        let mut store = Store::open(&path).unwrap();
        let p = store.add_project(tmp.path()).unwrap();
        let s = store.create_session(p.id.clone(), "claude".into()).unwrap();
        assert!(store.rename_session(&s.id, "  ").is_err());
        assert!(store.rename_session(&s.id, "bad\nname").is_err());
        store.rename_session(&s.id, "新任务").unwrap();
        store.mark_session_unread(&s.id, true).unwrap();
        let pinned = store.pin_session(&s.id, true).unwrap().pinned_at;
        assert_eq!(store.pin_session(&s.id, true).unwrap().pinned_at, pinned);
        store
            .begin(
                &s.id,
                "request",
                "must not overwrite title",
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(store.session(&s.id).unwrap().title, "新任务");
        assert!(store.archive_session(&s.id, true).is_err());
        store.state(&s.id, Status::Completed, None).unwrap();
        let before = store.events(&s.id, 0.0).unwrap().0.len();
        store.archive_session(&s.id, true).unwrap();
        assert!(store.pinned_sessions().unwrap().is_empty());
        assert!(store.pin_session(&s.id, true).is_err());
        assert!(
            store
                .begin(&s.id, "blocked", "hello", None, None, None, None)
                .is_err()
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        let restored = store.session(&s.id).unwrap();
        assert!(restored.archived && restored.unread && restored.custom_title);
        assert_eq!(store.events(&s.id, 0.0).unwrap().0.len(), before);
        assert_eq!(store.sessions(&p.id).unwrap().len(), 1);
        store.archive_session(&s.id, false).unwrap();
        assert!(store.session(&s.id).unwrap().pinned_at.is_none());
        store.pin_session(&s.id, true).unwrap();
        store.remove_project(&p.id).unwrap();
        assert!(store.pinned_sessions().unwrap().is_empty());
    }
    #[test]
    fn turn_completion_persists_unread_until_acknowledged() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("state.db");
        let mut store = Store::open(&path).unwrap();
        let project = store.add_project(tmp.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        for (index, final_status) in [Status::Completed, Status::Failed, Status::Stopped]
            .into_iter()
            .enumerate()
        {
            store
                .begin(
                    &session.id,
                    &format!("request-{index}"),
                    "hello",
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap();
            assert!(!store.session(&session.id).unwrap().unread);
            store.state(&session.id, Status::Waiting, None).unwrap();
            assert!(!store.session(&session.id).unwrap().unread);
            store
                .state(&session.id, final_status.clone(), None)
                .unwrap();
            assert!(store.session(&session.id).unwrap().unread);
            drop(store);
            store = Store::open(&path).unwrap();
            assert!(store.session(&session.id).unwrap().unread);
            store.mark_session_unread(&session.id, false).unwrap();
            store.state(&session.id, final_status, None).unwrap();
            assert!(!store.session(&session.id).unwrap().unread);
        }
    }
    #[test]
    fn legacy_sessions_default_to_unarchived_and_unpinned() {
        let session: Session = serde_json::from_value(serde_json::json!({
            "id":"legacy", "project_id":"p", "title":"old", "agent":"claude",
            "native_id":null, "status":"ready", "created_at":1.0
        }))
        .unwrap();
        assert!(!session.archived && !session.unread && !session.custom_title);
        assert!(session.pinned_at.is_none());
        assert!(session.effort.is_none());
    }
    #[test]
    fn legacy_request_migration_preserves_duplicate_protection() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("legacy.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,text TEXT NOT NULL); INSERT INTO requests VALUES('old','session','hello');").unwrap();
        drop(db);
        let mut store = Store::open(&path).unwrap();
        assert!(
            !store
                .begin("session", "old", "hello", None, None, None, None)
                .unwrap()
        );
        assert!(
            store
                .begin("session", "old", "hello", Some("sonnet"), None, None, None)
                .is_err()
        );
        drop(store);
        let mut reopened = Store::open(&path).unwrap();
        assert!(
            reopened
                .begin(
                    "session",
                    "old",
                    "hello",
                    None,
                    Some(Effort::High),
                    None,
                    None
                )
                .is_err()
        );
        assert!(
            !reopened
                .begin("session", "old", "hello", None, None, None, None)
                .unwrap()
        );
    }
    #[test]
    fn deduplication_and_restart_never_infer_success() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("state.db");
        let mut store = Store::open(&path).unwrap();
        let p = store.add_project(tmp.path()).unwrap();
        assert_eq!(p.id, store.add_project(tmp.path()).unwrap().id);
        let s = store.create_session(p.id, "claude".into()).unwrap();
        assert!(
            store
                .begin(&s.id, "one", "hello", None, None, None, None)
                .unwrap()
        );
        assert!(
            !store
                .begin(&s.id, "one", "hello", None, None, None, None)
                .unwrap()
        );
        assert!(
            store
                .begin(&s.id, "one", "different", None, None, None, None)
                .is_err()
        );
        assert!(
            store
                .begin(&s.id, "two", "hello", None, None, None, None)
                .is_err()
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.session(&s.id).unwrap().status, Status::Unknown);
        let (events, _) = store.events(&s.id, 0.0).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(store.events(&s.id, events[0].seq).unwrap().0.len(), 2);
    }

    #[test]
    fn effort_persists_and_request_identity_includes_effort() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("effort.db");
        let mut store = Store::open(&path).unwrap();
        let p = store.add_project(tmp.path()).unwrap();
        let s = store.create_session(p.id, "claude".into()).unwrap();
        assert!(
            store
                .begin(
                    &s.id,
                    "effort",
                    "hello",
                    None,
                    Some(Effort::High),
                    None,
                    None
                )
                .unwrap()
        );
        assert!(
            !store
                .begin(
                    &s.id,
                    "effort",
                    "hello",
                    None,
                    Some(Effort::High),
                    None,
                    None
                )
                .unwrap()
        );
        assert!(
            store
                .begin(
                    &s.id,
                    "effort",
                    "hello",
                    None,
                    Some(Effort::Low),
                    None,
                    None
                )
                .is_err()
        );
        store.state(&s.id, Status::Completed, None).unwrap();
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.session(&s.id).unwrap().effort, Some(Effort::High));
        assert!(
            store
                .begin(&s.id, "automatic", "hello", None, None, None, None)
                .unwrap()
        );
        assert_eq!(store.session(&s.id).unwrap().effort, None);
    }
}
