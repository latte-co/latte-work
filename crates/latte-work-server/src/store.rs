//! SQLite is the source of truth for sessions and replayable presentation events.
use anyhow::{Context, Result, bail};
use latte_work_protocol::{
    ContentEncoding, Effort, Event, EventKind, Project, RecentCursor, RecentSession, Session,
    Status, Subagent, SubagentStatus, SubagentUpdate,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

// Presentation reads keep every stored byte on disk and bound only what goes
// over the wire, measured as serialized JSON — control characters can inflate
// a payload sixfold through escaping. Polls always emit at least one event, so
// an oversized legacy row can never block the cursor; larger payloads stream
// on demand instead.
/// Serialized events up to this size ride whole in poll and history batches.
const WHOLE_EVENT_WIRE: usize = 512 * 1024;
/// Oversized tool payloads preview their leading bytes; the rest loads on click.
const PREVIEW_BYTES: usize = 64 * 1024;
/// Previews themselves stay under this serialized size, escape inflation included.
const PREVIEW_WIRE: usize = 192 * 1024;
/// Reply prose rides whole up to this serialized bound instead of previewing:
/// merged reply text cannot be re-associated with one sequence number.
const TEXT_WHOLE_WIRE: usize = latte_work_protocol::MAX_FRAME - 512 * 1024;
/// Full payloads stream in chunks whose serialized form stays frame-safe.
const CHUNK_RAW: usize = 512 * 1024;
const CHUNK_WIRE: usize = latte_work_protocol::MAX_FRAME - 768 * 1024;
/// Poll and history never read stored rows larger than this; bigger rows
/// preview through their byte length alone and stream on explicit request.
const ROW_READ_BYTES: i64 = 2 * 1024 * 1024;
const PRESENTATION_MARKER: &str = "…（内容过大，已截断）";

/// The streamable payload of an event plus how a client should reassemble it:
/// `Text` chunks concatenate into displayable prose, `Json` must be parsed
/// once fully received.
fn presentation_payload(event: &EventKind) -> Result<(String, ContentEncoding)> {
    Ok(match event {
        EventKind::Text { text } | EventKind::Notice { text } => {
            (text.clone(), ContentEncoding::Text)
        }
        EventKind::ToolResult { content, .. } => match content {
            serde_json::Value::String(text) => (text.clone(), ContentEncoding::Text),
            other => (serde_json::to_string(other)?, ContentEncoding::Json),
        },
        other => (serde_json::to_string(other)?, ContentEncoding::Json),
    })
}

/// Keeps the leading `limit` payload bytes and marks the cut.
fn clip_head(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut head = text[..end].to_owned();
    head.push_str(PRESENTATION_MARKER);
    head
}

/// Builds the preview variant for an oversized payload; `size` discloses the
/// full payload length for kinds that degrade to a notice.
fn preview_event(event: &EventKind, head: String, size: usize) -> EventKind {
    match event {
        // Keep the leading bytes of oversized prose visible; the marker in
        // the clipped head already discloses the omission.
        EventKind::Text { .. } => EventKind::Text { text: head },
        EventKind::Notice { .. } => EventKind::Notice { text: head },
        EventKind::ToolResult {
            id: tool_id,
            is_error,
            ..
        } => EventKind::ToolResult {
            id: tool_id.clone(),
            content: serde_json::Value::String(head),
            is_error: *is_error,
        },
        _ => EventKind::Notice {
            text: format!("内容 {size} 字节超过展示上限，已省略；原始记录保留。"),
        },
    }
}

/// One parsed stream payload, shared by every chunk request for that event so
/// repeated chunks never re-read and re-parse the stored row.
struct CachedPayload {
    session: String,
    seq: i64,
    encoding: ContentEncoding,
    text: String,
}
#[derive(Default)]
struct PayloadCache {
    bytes: usize,
    entries: std::collections::VecDeque<std::sync::Arc<CachedPayload>>,
}
/// Cached stream payloads are bounded in total, so slicing stays cheap without
/// pinning unbounded memory.
const CACHE_BYTES: usize = 64 * 1024 * 1024;
pub struct Store {
    pub(crate) db: Connection,
    pub(crate) snapshot_dir: std::path::PathBuf,
    content_cache: std::cell::RefCell<PayloadCache>,
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
        CREATE TABLE IF NOT EXISTS native_title_secrets(session_id TEXT NOT NULL REFERENCES sessions(id), native_id TEXT NOT NULL, secret_hash BLOB NOT NULL, secret_bytes INTEGER NOT NULL, PRIMARY KEY(session_id,native_id,secret_hash));
        CREATE TABLE IF NOT EXISTS native_session_contexts(session_id TEXT NOT NULL REFERENCES sessions(id), native_id TEXT NOT NULL, fingerprint TEXT, PRIMARY KEY(session_id,native_id));
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), at REAL NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS subagents(session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, native_id TEXT NOT NULL, tool_use_id TEXT, active INTEGER NOT NULL, at REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,id));
        CREATE INDEX IF NOT EXISTS subagents_session ON subagents(session_id,active,at);
        CREATE INDEX IF NOT EXISTS subagents_native ON subagents(session_id,native_id);
        CREATE INDEX IF NOT EXISTS subagents_tool ON subagents(session_id,tool_use_id);
        CREATE TABLE IF NOT EXISTS subagent_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT NOT NULL, at REAL NOT NULL, data TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(session_id,task_id) REFERENCES subagents(session_id,id));
        CREATE INDEX IF NOT EXISTS subagent_events_task ON subagent_events(session_id,task_id,seq);
        CREATE TABLE IF NOT EXISTS subagent_history(session_id TEXT NOT NULL,task_id TEXT NOT NULL,source TEXT NOT NULL,seq REAL NOT NULL,at REAL NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,task_id,source,seq),FOREIGN KEY(session_id,task_id) REFERENCES subagents(session_id,id));
        CREATE TABLE IF NOT EXISTS subagent_history_sources(session_id TEXT NOT NULL,task_id TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(session_id,task_id),FOREIGN KEY(session_id,task_id) REFERENCES subagents(session_id,id));
        CREATE TABLE IF NOT EXISTS subagent_native_transcripts(session_id TEXT NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,task_id),FOREIGN KEY(session_id,task_id) REFERENCES subagents(session_id,id));
        CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
        CREATE TABLE IF NOT EXISTS turn_changes(session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL REFERENCES requests(id), baseline TEXT, data TEXT, PRIMARY KEY(session_id,request_id));
        CREATE TABLE IF NOT EXISTS task_baselines(session_id TEXT PRIMARY KEY REFERENCES sessions(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_sources(session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, data TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(session_id,id));
        CREATE TABLE IF NOT EXISTS observed_tools(session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, PRIMARY KEY(session_id,id));
        CREATE TABLE IF NOT EXISTS reference_access(project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, directory INTEGER NOT NULL, PRIMARY KEY(project_id,path));
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,text TEXT NOT NULL);")?;
        let migration = db.unchecked_transaction()?;
        migration.execute_batch("CREATE INDEX IF NOT EXISTS events_recent_activity_v2 ON events(session_id,seq DESC) WHERE json_extract(data,'$.kind') IN ('user','queued_message_sent','text','tool','tool_result','approval','approval_resolved','subagent');
        DROP INDEX IF EXISTS events_recent_activity;")?;
        migration.commit()?;
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
        db.execute_batch("CREATE INDEX IF NOT EXISTS requests_session_provider ON requests(session_id,provider_fingerprint);")?;
        crate::message_queue::initialize(&db)?;
        let snapshot_dir = crate::snapshot_storage::prepare(&path.with_extension("snapshots"))?;
        crate::snapshot_migration::migrate(&db, &snapshot_dir)?;
        let store = Self {
            db,
            snapshot_dir,
            content_cache: std::cell::RefCell::default(),
        };
        let forwarded = store
            .db
            .prepare("SELECT DISTINCT session_id FROM message_queue WHERE status='forwarded'")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in forwarded {
            store.uncertain_forwarded(&id)?;
            store.pause_queue(&id, Some("后台已重启，请核对已发送的消息"))?;
        }
        // Native child processes cannot survive a daemon restart, even if the main
        // turn had already completed while background work continued.
        let child_sessions = store
            .db
            .prepare("SELECT DISTINCT session_id FROM subagents WHERE active=1")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in child_sessions {
            store.end_subagents(&id, SubagentStatus::Unknown)?;
        }
        let pending = store
            .db
            .prepare("SELECT session_id,request_id FROM turn_changes WHERE baseline IS NOT NULL")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, request_id) in pending {
            let summary = latte_work_protocol::ChangeSummary {
                total_files: None,
                next_offset: None,
                offset: None,
                entries: vec![],
                added: 0,
                removed: 0,
                binary_files: 0,
                truncated: false,
                baseline_at: None,
                unavailable: Some("Server 已重启，此轮结束时的文件快照未知；请核对工作区。".into()),
            };
            store.event(
                &id,
                EventKind::TurnChanges {
                    changes: latte_work_protocol::TurnChanges {
                        request_id: request_id.clone(),
                        summary,
                        interrupted: true,
                        background_pending: false,
                        undo: latte_work_protocol::TurnUndoStatus::Unknown,
                    },
                },
            )?;
            store.db.execute(
                "UPDATE turn_changes SET baseline=NULL WHERE session_id=?1 AND request_id=?2",
                params![id, request_id],
            )?;
        }
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
        if let Err(error) = store.collect_snapshot_garbage() {
            eprintln!("snapshot cleanup skipped: {error}");
        }
        if let Err(error) = store.backfill_title_requested() {
            eprintln!("title-request backfill skipped: {error}");
        }
        Ok(store)
    }
    /// One-time upgrade for rows written before `title_requested` existed. A
    /// saved title that already differs from the stored first-prompt prefix
    /// without being a manual rename was produced by an earlier AI title, so
    /// its generation chance is consumed; rows still showing the prompt
    /// prefix — including sessions that were only opened and never messaged —
    /// keep the chance and self-heal on their next completed turn. The field
    /// is written explicitly so this scan touches each row at most once.
    fn backfill_title_requested(&self) -> Result<()> {
        let rows = self
            .db
            .prepare(
                "SELECT id,data FROM sessions WHERE json_extract(data,'$.title_requested') IS NULL",
            )?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut first_prompt = self
            .db
            .prepare("SELECT text FROM requests WHERE session_id=?1 ORDER BY rowid LIMIT 1")?;
        for (id, data) in rows {
            let Ok(mut session) = serde_json::from_str::<Session>(&data) else {
                continue;
            };
            session.title_requested = if session.native_id.is_some() {
                match first_prompt
                    .query_row(params![id], |row| row.get::<_, String>(0))
                    .optional()?
                    .map(|text| text.chars().take(48).collect::<String>())
                {
                    // Opening a native session alone already records its id, so
                    // only a title that moved past the placeholder proves a
                    // chance was consumed; rows that were merely opened keep
                    // theirs. Native history without a locally admitted turn
                    // and a moved-away title is still never regenerated over.
                    None => session.title != "新任务",
                    // A manual rename is not a generated title; only an
                    // un-customized title that left the prompt prefix behind
                    // is that proof.
                    Some(prefix) => !session.custom_title && session.title != prefix,
                }
            } else {
                false
            };
            self.save(&session)?;
        }
        Ok(())
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
    pub fn recent_sessions(
        &self,
        before: Option<&RecentCursor>,
    ) -> Result<(Vec<RecentSession>, Option<RecentCursor>)> {
        if before.is_some_and(|cursor| {
            !cursor.updated_at.is_finite()
                || cursor.updated_at < 0.0
                || cursor.id.is_empty()
                || cursor.id.len() > 128
        }) {
            bail!("最近记录游标无效");
        }
        // Lifecycle/reading metadata does not make an old conversation recent.
        // The partial event index also supports histories created before this feature.
        let rows = self.db.prepare("WITH recent AS (
            SELECT s.id,s.data,COALESCE((SELECT e.at FROM events e WHERE e.session_id=s.id
                AND json_extract(e.data,'$.kind') IN ('user','queued_message_sent','text','tool','tool_result','approval','approval_resolved','subagent')
                ORDER BY e.seq DESC LIMIT 1),json_extract(s.data,'$.created_at')) AS updated_at
            FROM sessions s WHERE COALESCE(json_extract(s.data,'$.archived'),0)=0
                AND s.project_id NOT IN (SELECT project_id FROM hidden_projects))
            SELECT data,updated_at FROM recent
            WHERE ?1 IS NULL OR updated_at<?1 OR (updated_at=?1 AND id<?2)
            ORDER BY updated_at DESC,id DESC LIMIT 101")?
            .query_map(params![before.map(|cursor|cursor.updated_at), before.map(|cursor|cursor.id.as_str())], |row| Ok((row.get::<_,String>(0)?, row.get::<_,f64>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut sessions = rows
            .into_iter()
            .map(|(data, updated_at)| {
                Ok(RecentSession {
                    session: serde_json::from_str(&data)?,
                    updated_at,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let has_more = sessions.len() > 100;
        sessions.truncate(100);
        let next = has_more.then(|| {
            let last = sessions.last().expect("full recent page");
            RecentCursor {
                updated_at: last.updated_at,
                id: last.session.id.clone(),
            }
        });
        Ok((sessions, next))
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
            title_requested: false,
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
    pub fn sync_live_native_title(&self, id: &str, title: &str) -> Result<Session> {
        // Explicit native names remain authoritative after a previous manual
        // rename. AI-generated titles use sync_native_title(..., false).
        self.sync_native_title(id, title, true)
    }
    /// Bind a one-way credential fingerprint before native output can be imported.
    /// A title contains at most 200 Unicode characters, hence at most 800 bytes.
    pub fn remember_title_credential(
        &self,
        id: &str,
        native: &str,
        credential: &str,
    ) -> Result<()> {
        if !credential.is_empty() && credential.len() <= 800 {
            use sha2::{Digest, Sha256};
            self.db.execute(
                "INSERT OR IGNORE INTO native_title_secrets(session_id,native_id,secret_hash,secret_bytes) VALUES (?1,?2,?3,?4)",
                params![id, native, Sha256::digest(credential.as_bytes()).to_vec(), credential.len() as i64],
            )?;
        }
        Ok(())
    }
    fn redact_native_title(&self, session: &Session, title: &str) -> Result<Option<String>> {
        use sha2::{Digest, Sha256};
        // Bound both reads and hashing. If an unusually long-lived session has
        // more matching credential fingerprints, decline the optional import.
        let secrets = self.db.prepare(
            "SELECT secret_hash,secret_bytes FROM native_title_secrets WHERE session_id=?1 AND native_id=?2 AND secret_bytes>0 AND secret_bytes<=?3 LIMIT 65",
        )?.query_map(params![session.id, session.native_id, title.len() as i64], |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, u32>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if secrets.len() > 64 {
            return Ok(None);
        }
        let mut hidden = vec![false; title.len()];
        for (hash, length) in secrets {
            let length = length as usize;
            for (start, _) in title.char_indices() {
                let end = start + length;
                if end <= title.len()
                    && title.is_char_boundary(end)
                    && Sha256::digest(&title.as_bytes()[start..end])[..] == hash
                {
                    hidden[start..end].fill(true);
                }
            }
        }
        let mut redacted = String::new();
        let mut masking = false;
        for (at, ch) in title.char_indices() {
            if hidden[at] {
                if !masking {
                    redacted.push_str("[redacted]");
                }
            } else {
                redacted.push(ch);
            }
            masking = hidden[at];
        }
        Ok(Some(redacted))
    }
    pub fn sync_native_title(&self, id: &str, title: &str, custom: bool) -> Result<Session> {
        let mut session = self.session(id)?;
        if title.trim().is_empty()
            || title.chars().count() > 200
            || title.chars().any(char::is_control)
        {
            return Ok(session);
        }
        let Some(title) = self.redact_native_title(&session, title)? else {
            return Ok(session);
        };
        if title.chars().count() > 200 || title.chars().any(char::is_control) {
            return Ok(session);
        }
        if session.custom_title && !custom {
            return Ok(session);
        }
        if session.title != title || (custom && !session.custom_title) {
            session.title = title;
            session.custom_title |= custom;
            // An imported or generated AI title consumes the session's one
            // generation chance, so a later turn never regenerates over it.
            if !custom {
                session.title_requested = true;
            }
            self.save(&session)?;
        }
        Ok(session)
    }
    pub fn validate_session_title(title: &str) -> Result<&str> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 100 || title.chars().any(char::is_control) {
            bail!("会话名称不能为空、超过 100 个字符或包含控制字符");
        }
        Ok(title)
    }
    pub fn rename_session(&self, id: &str, title: &str) -> Result<Session> {
        let title = Self::validate_session_title(title)?;
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
    /// Persist that the native title-generation request was sent, so a respawn
    /// never re-requests it for this session's lifetime.
    pub fn mark_title_requested(&self, id: &str) -> Result<Session> {
        let mut session = self.session(id)?;
        if session.title_requested {
            return Ok(session);
        }
        session.title_requested = true;
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
    pub fn subagents(&self, id: &str) -> Result<(Vec<Subagent>, bool)> {
        let mut tasks = self.db.prepare("SELECT data FROM subagents WHERE session_id=?1 ORDER BY active DESC,at DESC,id LIMIT 129")?.query_map([id], |row| row.get::<_, String>(0))?.map(|row| Ok(serde_json::from_str(&row?)?)).collect::<Result<Vec<Subagent>>>()?;
        let truncated = tasks.len() > 128;
        tasks.truncate(128);
        Ok((tasks, truncated))
    }
    pub fn end_subagents(&self, id: &str, status: SubagentStatus) -> Result<()> {
        let tasks = self
            .db
            .prepare("SELECT data FROM subagents WHERE session_id=?1 AND active=1")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<Vec<Subagent>>>()?;
        for task in tasks {
            self.event(
                id,
                EventKind::Subagent {
                    update: SubagentUpdate {
                        agent_type: None,
                        id: task.native_id,
                        tool_use_id: task.tool_use_id,
                        title: None,
                        status: Some(status),
                        summary: None,
                        last_tool: None,
                    },
                },
            )?;
        }
        Ok(())
    }
    pub fn subagent_event(
        &self,
        session_id: &str,
        tool_use_id: &str,
        event: EventKind,
    ) -> Result<()> {
        self.store_subagent_event(session_id, tool_use_id, event, |event| event)
    }
    pub fn redacted_subagent_event(
        &self,
        session_id: &str,
        tool_use_id: &str,
        event: EventKind,
        redactor: &crate::redaction::Redactor,
    ) -> Result<()> {
        self.store_subagent_event(session_id, tool_use_id, event, |event| {
            redactor.event(event)
        })
    }
    fn store_subagent_event(
        &self,
        session_id: &str,
        tool_use_id: &str,
        event: EventKind,
        redact: impl FnOnce(EventKind) -> EventKind,
    ) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        let task_id: String = tx.query_row("SELECT id FROM subagents WHERE session_id=?1 AND tool_use_id=?2 ORDER BY at DESC LIMIT 1", params![session_id, tool_use_id], |row| row.get(0)).optional()?.context("子智能体输出无法关联到原生任务")?;
        // Interpret native delivery receipts before redacting their prose. The
        // saved tool input already belongs to the redacted public history.
        let report = if let EventKind::ToolResult { id, .. } = &event {
            let tool:Option<String>=tx.query_row("SELECT data FROM subagent_history WHERE session_id=?1 AND task_id=?2 AND source='stream' AND json_extract(data,'$.kind')='tool' AND json_extract(data,'$.id')=?3 ORDER BY seq DESC LIMIT 1",params![session_id,task_id,id],|r|r.get(0)).optional()?;
            tool.map(|tool| -> Result<_> {
                Ok(crate::agents::confirmed_child_report(
                    &serde_json::from_str(&tool)?,
                    &event,
                ))
            })
            .transpose()?
            .flatten()
        } else {
            None
        };
        let event = redact(event);
        // Keep the full redacted stream separately from the legacy bounded snapshot.
        let seq: f64 = tx.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM subagent_history WHERE session_id=?1 AND task_id=?2 AND source='stream'",params![session_id,task_id],|row| row.get(0))?;
        tx.execute("INSERT INTO subagent_history(session_id,task_id,source,seq,at,data) VALUES (?1,?2,'stream',?3,?4,?5)",params![session_id,task_id,seq,now(),serde_json::to_string(&event)?])?;
        if let Some(text) = &report {
            tx.execute("INSERT INTO subagent_history(session_id,task_id,source,seq,at,data) VALUES (?1,?2,'stream',?3,?4,?5)",params![session_id,task_id,seq+1.0,now(),serde_json::to_string(&EventKind::Text{text:text.clone()})?])?;
        }
        let (mut event, mut truncated) = bounded_subagent_event(event)?;
        if let EventKind::Text { text } = &event {
            let previous: Option<(i64, String, bool)> = tx.query_row("SELECT seq,data,truncated FROM subagent_events WHERE session_id=?1 AND task_id=?2 ORDER BY seq DESC LIMIT 1", params![session_id, task_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
            if let Some((seq, data, partial)) = previous
                && let EventKind::Text { text: mut joined } = serde_json::from_str(&data)?
            {
                if !partial {
                    joined.push_str(text);
                }
                let bounded = bounded_subagent_event(EventKind::Text { text: joined })?;
                event = bounded.0;
                truncated |= partial || bounded.1;
                tx.execute(
                    "UPDATE subagent_events SET at=?2,data=?3,truncated=?4 WHERE seq=?1",
                    params![seq, now(), serde_json::to_string(&event)?, truncated],
                )?;
                tx.commit()?;
                return Ok(());
            }
        }
        tx.execute("INSERT INTO subagent_events(session_id,task_id,at,data,truncated) VALUES (?1,?2,?3,?4,?5)", params![session_id, task_id, now(), serde_json::to_string(&event)?, truncated])?;
        if let Some(text) = report {
            let (event, truncated) = bounded_subagent_event(EventKind::Text { text })?;
            tx.execute("INSERT INTO subagent_events(session_id,task_id,at,data,truncated) VALUES (?1,?2,?3,?4,?5)", params![session_id,task_id,now(),serde_json::to_string(&event)?,truncated])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn subagent(&self, session_id: &str, task_id: &str) -> Result<Subagent> {
        self.session(session_id)?;
        let data: String = self
            .db
            .query_row(
                "SELECT data FROM subagents WHERE session_id=?1 AND id=?2",
                params![session_id, task_id],
                |row| row.get(0),
            )
            .optional()?
            .context("此对话没有对应的子智能体")?;
        Ok(serde_json::from_str(&data)?)
    }
    pub fn native_subagent(&self, session_id: &str, native_id: &str) -> Result<Subagent> {
        let data: String = self.db.query_row("SELECT data FROM subagents WHERE session_id=?1 AND (native_id=?2 OR id=?2) ORDER BY at DESC LIMIT 1", params![session_id,native_id], |row| row.get(0)).optional()?.context("子智能体原生记录不存在")?;
        Ok(serde_json::from_str(&data)?)
    }
    pub fn child_native_ids(&self, session_id: &str) -> Result<std::collections::HashSet<String>> {
        let mut query = self.db.prepare(
            "SELECT native_id FROM subagents WHERE session_id=?1 ORDER BY at DESC LIMIT 512",
        )?;
        Ok(query
            .query_map([session_id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }
    /// Bind historical native reads to the accepted request before this child
    /// started. Only its digest is stored; credential snapshots stay ephemeral.
    pub fn child_provider_fingerprint(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<Option<Option<String>>> {
        let task = self.subagent(session_id, task_id)?;
        let Some(started) = task.started_at else {
            return Ok(None);
        };
        self.db.query_row("SELECT r.provider_fingerprint FROM requests r JOIN events e ON e.session_id=r.session_id AND json_extract(e.data,'$.request_id')=r.id WHERE r.session_id=?1 AND json_extract(e.data,'$.kind')='user' AND e.at<=?2 ORDER BY e.seq DESC LIMIT 1",params![session_id,started],|row|row.get(0)).optional().map_err(Into::into)
    }
    /// Native title records have no per-turn owner. Only read them when every
    /// accepted turn belongs to the available context; otherwise retain cache.
    pub fn native_title_context_matches(
        &self,
        session_id: &str,
        fingerprint: Option<&str>,
        allow_legacy_cli: bool,
    ) -> Result<bool> {
        self.db.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM requests WHERE session_id=?1 AND provider_fingerprint IS NOT ?2 AND NOT (?3 AND provider_fingerprint IS NULL))",
            params![session_id, fingerprint, allow_legacy_cli],
            |row| row.get(0),
        ).map_err(Into::into)
    }
    /// Preserve only the digest of the last verified native launch, never ENV.
    pub fn remember_native_context(
        &self,
        session_id: &str,
        native_id: &str,
        fingerprint: Option<&str>,
    ) -> Result<()> {
        self.db.execute("INSERT INTO native_session_contexts(session_id,native_id,fingerprint) VALUES (?1,?2,?3) ON CONFLICT(session_id,native_id) DO UPDATE SET fingerprint=excluded.fingerprint", params![session_id, native_id, fingerprint])?;
        Ok(())
    }
    pub fn native_rename_context_matches(
        &self,
        session_id: &str,
        native_id: &str,
        fingerprint: Option<&str>,
    ) -> Result<bool> {
        let saved: Option<Option<String>> = self.db.query_row("SELECT fingerprint FROM native_session_contexts WHERE session_id=?1 AND native_id=?2", params![session_id, native_id], |row| row.get(0)).optional()?;
        if let Some(saved) = saved {
            return Ok(saved.as_deref() == fingerprint);
        }
        // Older databases can prove the context only through accepted turns.
        // An empty ledger cannot establish where an open-only session lived.
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM requests WHERE session_id=?1)",
            [session_id],
            |row| row.get(0),
        )?;
        let cli =
            crate::providers::turn_fingerprint(Some(&latte_work_protocol::TurnProvider::Cli))?;
        Ok(exists
            && self.native_title_context_matches(
                session_id,
                fingerprint,
                fingerprint == cli.as_deref(),
            )?)
    }
    pub fn child_history_cursor(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<crate::agents::ChildHistoryCursor> {
        self.subagent(session_id, task_id)?;
        let data: Option<String> = self
            .db
            .query_row(
                "SELECT cursor FROM subagent_history_sources WHERE session_id=?1 AND task_id=?2",
                params![session_id, task_id],
                |row| row.get(0),
            )
            .optional()?;
        data.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
            .map(|c| c.unwrap_or_default())
    }
    pub fn cache_child_history(
        &self,
        session_id: &str,
        task_id: &str,
        page: &crate::agents::ChildHistoryPage,
    ) -> Result<()> {
        self.subagent(session_id, task_id)?;
        let tx = self.db.unchecked_transaction()?;
        for e in &page.events {
            if e.session_id != session_id {
                bail!("子智能体过程会话身份不匹配");
            }
            tx.execute("INSERT INTO subagent_history(session_id,task_id,source,seq,at,data) VALUES (?1,?2,'native',?3,?4,?5) ON CONFLICT(session_id,task_id,source,seq) DO NOTHING",params![session_id,task_id,e.seq,e.at,serde_json::to_string(&e.event)?])?;
        }
        tx.execute("INSERT INTO subagent_history_sources(session_id,task_id,cursor) VALUES (?1,?2,?3) ON CONFLICT(session_id,task_id) DO UPDATE SET cursor=excluded.cursor WHERE json_extract(subagent_history_sources.cursor,'$.offset')<=json_extract(excluded.cursor,'$.offset')",params![session_id,task_id,serde_json::to_string(&page.cursor)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn subagent_history(
        &self,
        session_id: &str,
        task_id: &str,
        after: Option<f64>,
        requested_source: Option<&str>,
        source_has_more: bool,
    ) -> Result<latte_work_protocol::Response> {
        let task = self.subagent(session_id, task_id)?;
        // Read the original, already-redacted parent tool input independently of UI history pages.
        let mut prompt: Option<String> = if let Some(tool) = task.tool_use_id {
            self.db.query_row(
                "SELECT json_extract(data,'$.input.prompt') FROM events WHERE session_id=?1 AND json_extract(data,'$.kind')='tool' AND json_extract(data,'$.name') IN ('Agent','Task') AND json_extract(data,'$.id')=?2 AND json_type(data,'$.input.prompt')='text' ORDER BY seq DESC LIMIT 1",
                params![session_id, tool], |row| row.get(0),
            ).optional()?.flatten()
        } else {
            None
        };
        if prompt.is_none() && self.session(session_id)?.agent == "opencode" {
            prompt = self
                .db
                .query_row(
                    "SELECT json_extract(data,'$.text') FROM subagent_history
                 WHERE session_id=?1 AND task_id=?2 AND source='native'
                 AND json_extract(data,'$.kind')='user'
                 ORDER BY seq LIMIT 1",
                    params![session_id, task_id],
                    |row| row.get(0),
                )
                .optional()?;
        }
        if prompt
            .as_ref()
            .is_some_and(|text| text.len() > latte_work_protocol::MAX_FRAME / 2)
        {
            bail!("子智能体任务指令超出传输范围，内容未截断");
        }
        if after.is_some_and(|v| !v.is_finite() || v < 0.0) {
            bail!("子智能体事件游标无效");
        }
        let native:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM subagent_history_sources WHERE session_id=?1 AND task_id=?2) AND EXISTS(SELECT 1 FROM subagent_history WHERE session_id=?1 AND task_id=?2 AND source='native')",params![session_id,task_id],|r|r.get(0))?;
        let stream:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM subagent_history WHERE session_id=?1 AND task_id=?2 AND source='stream')",params![session_id,task_id],|r|r.get(0))?;
        if !native && !stream {
            // Pre-upgrade snapshots are already redacted, but discarded fields
            // cannot be recovered if the owning native context is unavailable.
            let snapshot = self.subagent_transcript(session_id, task_id)?;
            let (events, incomplete) = crate::agents::normalize_child_transcript(
                &self.session(session_id)?.agent,
                snapshot,
            )?;
            let after = if requested_source == Some("legacy") {
                after
            } else {
                None
            };
            let mut page: Vec<Event> = events
                .into_iter()
                .filter(|e| e.seq > after.unwrap_or(-1.0))
                .take(129)
                .collect();
            let has_more = page.len() > 128;
            page.truncate(128);
            let after = page.last().map(|e| e.seq).or(after);
            return Ok(latte_work_protocol::Response::SubagentHistory {
                prompt,
                events: page,
                has_more,
                after,
                source_has_more: false,
                incomplete,
                source: "legacy".into(),
            });
        }
        let source = if native { "native" } else { "stream" };
        let after = if requested_source == Some(source) {
            after
        } else {
            None
        };
        let mut statement=self.db.prepare("SELECT seq,at,data FROM subagent_history WHERE session_id=?1 AND task_id=?2 AND source=?3 AND seq>?4 ORDER BY seq ASC LIMIT 129")?;
        let mut rows =
            statement.query(params![session_id, task_id, source, after.unwrap_or(-1.0)])?;
        let (mut events, mut bytes, mut has_more) = (Vec::new(), 0, false);
        while let Some(row) = rows.next()? {
            let data: String = row.get(2)?;
            let size = data.len() + session_id.len() + 128;
            if events.len() == 128 || (bytes + size > 256 * 1024 && !events.is_empty()) {
                has_more = true;
                break;
            }
            if size + prompt.as_ref().map_or(0, String::len) > latte_work_protocol::MAX_FRAME - 8192
            {
                bail!("单条子智能体事件超出传输范围，内容未截断");
            }
            bytes += size;
            events.push(Event {
                seq: row.get(0)?,
                session_id: session_id.into(),
                at: row.get(1)?,
                event: self.presentation_event(session_id, &data)?,
                content_size: None,
            });
        }
        let after = events.last().map(|e| e.seq).or(after);
        let cursor = self.child_history_cursor(session_id, task_id)?;
        let incomplete = native
            && ((cursor.has_more && !source_has_more)
                || (cursor.pending_tail && !self.subagent(session_id, task_id)?.status.active()));
        Ok(latte_work_protocol::Response::SubagentHistory {
            prompt,
            events,
            has_more,
            after,
            source_has_more,
            incomplete,
            source: source.into(),
        })
    }
    pub fn cache_subagent_transcript(
        &self,
        session_id: &str,
        task_id: &str,
        transcript: &crate::agents::ChildTranscript,
    ) -> Result<()> {
        self.subagent(session_id, task_id)?;
        if transcript.0.iter().any(|e| e.session_id != session_id) {
            bail!("子智能体过程会话身份不匹配");
        }
        let data = serde_json::to_string(transcript)?;
        if data.len() > 512 * 1024 || transcript.0.len() > 500 {
            bail!("子智能体过程超出缓存范围");
        }
        self.db.execute("INSERT INTO subagent_native_transcripts(session_id,task_id,data) VALUES (?1,?2,?3) ON CONFLICT(session_id,task_id) DO UPDATE SET data=excluded.data", params![session_id,task_id,data])?;
        Ok(())
    }
    /// Bounded child snapshot; streaming fragments are coalesced on write.
    pub fn subagent_transcript(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<(Vec<Event>, bool)> {
        self.session(session_id)?;
        let cached: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM subagent_native_transcripts WHERE session_id=?1 AND task_id=?2",
                params![session_id, task_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(cached) = cached {
            return Ok(serde_json::from_str(&cached)?);
        }
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM subagents WHERE session_id=?1 AND id=?2)",
            params![session_id, task_id],
            |row| row.get(0),
        )?;
        if !exists {
            bail!("此对话没有对应的子智能体");
        }
        let mut statement = self.db.prepare("SELECT seq,at,data,truncated FROM subagent_events WHERE session_id=?1 AND task_id=?2 ORDER BY seq DESC LIMIT 501")?;
        let mut rows = statement.query(params![session_id, task_id])?;
        let (mut events, mut bytes, mut truncated) = (Vec::new(), 0, false);
        while let Some(row) = rows.next()? {
            let data: String = row.get(2)?;
            if events.len() == 500 || bytes + data.len() + 128 > 256 * 1024 {
                truncated = true;
                break;
            }
            bytes += data.len() + 128;
            truncated |= row.get::<_, bool>(3)?;
            events.push(Event {
                seq: row.get::<_, i64>(0)? as f64,
                session_id: session_id.into(),
                at: row.get(1)?,
                event: self.presentation_event(session_id, &data)?,
                content_size: None,
            });
        }
        events.reverse();
        Ok((events, truncated))
    }
    pub fn event(&self, id: &str, mut event: EventKind) -> Result<()> {
        if matches!(&event, EventKind::TurnChanges { .. }) {
            crate::snapshot_storage::small_json(&event)?;
        }

        let at = now();
        let tx = self.db.unchecked_transaction()?;
        if let EventKind::Subagent { update } = &mut event {
            let data = tx.query_row("SELECT data FROM subagents WHERE session_id=?1 AND (id=?2 OR native_id=?2 OR (tool_use_id IS NOT NULL AND tool_use_id=?3)) ORDER BY at DESC LIMIT 1", params![id, update.id, update.tool_use_id], |row| row.get::<_, String>(0)).optional()?;
            let mut task = if let Some(data) = data {
                serde_json::from_str::<Subagent>(&data)?
            } else {
                Subagent {
                    id: update.id.clone(),
                    native_id: update.id.clone(),
                    tool_use_id: update.tool_use_id.clone(),
                    title: "子智能体".into(),
                    agent_type: None,
                    status: SubagentStatus::Unknown,
                    summary: None,
                    last_tool: None,
                    started_at: None,
                    updated_at: at,
                }
            };
            task.native_id = update.id.clone();
            if let Some(tool) = &update.tool_use_id {
                task.tool_use_id = Some(tool.clone());
            }
            if let Some(title) = &update.title {
                task.title = title.clone();
            }
            if let Some(agent_type) = &update.agent_type {
                task.agent_type = Some(agent_type.clone());
            }
            if let Some(status) = update.status {
                // Out-of-order progress cannot resurrect a confirmed terminal task.
                if task.status.active()
                    || task.status == SubagentStatus::Unknown
                    || !status.active()
                {
                    task.status = status;
                }
                if status.active() && task.started_at.is_none() {
                    task.started_at = Some(at);
                }
            }
            if let Some(summary) = &update.summary {
                task.summary = Some(summary.clone());
            }
            if let Some(tool) = &update.last_tool {
                task.last_tool = Some(tool.clone());
            }
            task.updated_at = at;
            tx.execute("INSERT INTO subagents(session_id,id,native_id,tool_use_id,active,at,data) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(session_id,id) DO UPDATE SET native_id=excluded.native_id,tool_use_id=excluded.tool_use_id,active=excluded.active,at=excluded.at,data=excluded.data", params![id, task.id, task.native_id, task.tool_use_id, task.status.active(), at, serde_json::to_string(&task)?])?;
            update.id = task.id;
        }
        tx.execute(
            "INSERT INTO events(session_id,at,data) VALUES (?1,?2,?3)",
            params![id, at, serde_json::to_string(&event)?],
        )?;
        index_event(&tx, id, &event)?;
        tx.commit()?;
        Ok(())
    }
    fn collect_snapshot_garbage(&self) -> Result<()> {
        let mut keys = std::collections::HashSet::new();
        for query in [
            "SELECT data FROM task_baselines",
            "SELECT baseline FROM turn_changes WHERE baseline IS NOT NULL",
        ] {
            let mut statement = self.db.prepare(query)?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let data: String = row.get(0)?;
                let mut snapshot: crate::task_changes::Snapshot = serde_json::from_str(&data)?;
                snapshot.attach(&self.snapshot_dir);
                snapshot.referenced_objects(&mut keys)?;
            }
        }
        let mut statement = self
            .db
            .prepare("SELECT data FROM turn_changes WHERE data IS NOT NULL")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let data: String = row.get(0)?;
            let mut turn: crate::task_changes::FrozenTurn = serde_json::from_str(&data)?;
            turn.attach(&self.snapshot_dir);
            turn.referenced_objects(&mut keys)?;
        }
        // Run only during startup, before any capture can publish new objects.
        // Unknown files and the append-only legacy archive are never touched.
        for entry in std::fs::read_dir(&self.snapshot_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(key) = name.to_str() else {
                continue;
            };
            if key.len() == 64
                && key.bytes().all(|b| b.is_ascii_hexdigit())
                && entry.file_type()?.is_file()
                && !keys.contains(key)
            {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
    pub fn baseline(&self, id: &str) -> Result<Option<crate::task_changes::Snapshot>> {
        self.session(id)?;
        self.db
            .query_row(
                "SELECT data FROM task_baselines WHERE session_id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|s| {
                let mut snapshot: crate::task_changes::Snapshot = serde_json::from_str(&s)?;
                snapshot.attach(&self.snapshot_dir);
                Ok::<_, anyhow::Error>(snapshot)
            })
            .transpose()
    }
    pub fn save_baseline(&self, id: &str, snapshot: &crate::task_changes::Snapshot) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO task_baselines(session_id,data) VALUES (?1,?2)",
            params![id, crate::snapshot_storage::small_json(snapshot)?],
        )?;
        Ok(())
    }
    pub fn save_turn_baseline(
        &self,
        id: &str,
        request_id: &str,
        baseline: &crate::task_changes::Snapshot,
    ) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO turn_changes(session_id,request_id,baseline) VALUES (?1,?2,?3)",
            params![
                id,
                request_id,
                crate::snapshot_storage::small_json(baseline)?
            ],
        )?;
        Ok(())
    }
    pub fn pending_turn(
        &self,
        id: &str,
    ) -> Result<Option<(String, crate::task_changes::Snapshot)>> {
        self.db.query_row("SELECT request_id,baseline FROM turn_changes WHERE session_id=?1 AND baseline IS NOT NULL ORDER BY rowid DESC LIMIT 1",[id],
            |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?
            .map(|(id,data)| {let mut snapshot:crate::task_changes::Snapshot=serde_json::from_str(&data)?;snapshot.attach(&self.snapshot_dir);Ok((id,snapshot))}).transpose()
    }
    pub fn finish_turn(&self, id: &str, turn: &crate::task_changes::FrozenTurn) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        let updated = tx.execute("UPDATE turn_changes SET baseline=NULL,data=?3 WHERE session_id=?1 AND request_id=?2 AND baseline IS NOT NULL",
            params![id,turn.changes.request_id,crate::snapshot_storage::small_json(turn)?])?;
        if updated == 1 {
            tx.execute(
                "INSERT INTO events(session_id,at,data) VALUES (?1,?2,?3)",
                params![
                    id,
                    now(),
                    crate::snapshot_storage::small_json(&EventKind::TurnChanges {
                        changes: turn.changes.clone()
                    })?
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn turn_changes(
        &self,
        id: &str,
        request_id: &str,
    ) -> Result<crate::task_changes::FrozenTurn> {
        self.session(id)?;
        let data: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM turn_changes WHERE session_id=?1 AND request_id=?2",
                params![id, request_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let mut turn: crate::task_changes::FrozenTurn =
            serde_json::from_str(&data.context("此轮尚未结束或没有保存变更快照")?)?;
        turn.attach(&self.snapshot_dir);
        Ok(turn)
    }
    pub fn last_turn_changes(&self, id: &str) -> Result<Option<crate::task_changes::FrozenTurn>> {
        self.session(id)?;
        let request_id: Option<String> = self.db.query_row(
            "SELECT request_id FROM turn_changes WHERE session_id=?1 AND data IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            [id], |row| row.get(0),
        ).optional()?;
        request_id
            .map(|request_id| self.turn_changes(id, &request_id))
            .transpose()
    }
    pub fn latest_request(&self, id: &str) -> Result<String> {
        self.db
            .query_row(
                "SELECT id FROM requests WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .map_err(Into::into)
    }
    pub fn update_turn(&self, id: &str, turn: &crate::task_changes::FrozenTurn) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        if tx.execute("UPDATE turn_changes SET data=?3 WHERE session_id=?1 AND request_id=?2 AND data IS NOT NULL",
            params![id,turn.changes.request_id,crate::snapshot_storage::small_json(turn)?])? != 1 { bail!("本轮变更记录缺失"); }
        tx.execute(
            "INSERT INTO events(session_id,at,data) VALUES (?1,?2,?3)",
            params![
                id,
                now(),
                crate::snapshot_storage::small_json(&EventKind::TurnChanges {
                    changes: turn.changes.clone()
                })?
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn first_request(&self, id: &str) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM requests WHERE session_id=?1",
            [id],
            |r| r.get::<_, u32>(0),
        )? == 1)
    }
    pub fn observe_tool(&self, session: &str, id: &str, name: &str) -> Result<()> {
        let tx = self.db.unchecked_transaction()?;
        index_tool(&tx, session, id, name)?;
        tx.commit()?;
        Ok(())
    }
    pub fn sources(&self, session: &str) -> Result<(Vec<latte_work_protocol::TaskSource>, bool)> {
        self.session(session)?;
        // Bounded lazy indexing supports older histories without inventing sources.
        let history = self.db.prepare("SELECT data FROM events WHERE session_id=?1 AND json_extract(data,'$.kind') IN ('user','queued_message_sent','tool') ORDER BY seq DESC LIMIT 257")?.query_map([session], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut partial = history.len() > 256;
        let tx = self.db.unchecked_transaction()?;
        for data in history.iter().take(256).rev() {
            let event: EventKind = serde_json::from_str(data)?;
            index_event(&tx, session, &event)?;
        }
        tx.commit()?;
        let rows = self
            .db
            .prepare(
                "SELECT data FROM task_sources WHERE session_id=?1 ORDER BY at DESC,id LIMIT 129",
            )?
            .query_map([session], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        partial |= rows.len() > 128;
        Ok((
            rows.iter()
                .take(128)
                .map(|row| serde_json::from_str(row).map_err(Into::into))
                .collect::<Result<_>>()?,
            partial,
        ))
    }
    pub fn grant_reference(&self, project: &str, path: &str, directory: bool) -> Result<()> {
        let changed = self.db.execute(
            "INSERT INTO reference_access(project_id,path,directory)
            SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM reference_access WHERE project_id=?1)<512
            OR EXISTS(SELECT 1 FROM reference_access WHERE project_id=?1 AND path=?2)
            ON CONFLICT(project_id,path) DO UPDATE SET directory=excluded.directory",
            params![project, path, directory],
        )?;
        if changed == 0 {
            bail!("可预览的项目外文件数量已达上限");
        }
        Ok(())
    }
    pub fn reference_access(
        &self,
        project: &str,
    ) -> Result<(Vec<latte_work_protocol::FileEntry>, bool)> {
        self.project(project)?;
        let mut query = self.db.prepare("SELECT path,directory FROM reference_access WHERE project_id=?1 ORDER BY path LIMIT 513")?;
        let rows = query.query_map([project], |r| {
            let path: String = r.get(0)?;
            Ok(latte_work_protocol::FileEntry {
                name: Path::new(&path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone()),
                path,
                directory: r.get(1)?,
            })
        })?;
        let mut entries = Vec::new();
        let mut bytes = 0;
        let mut truncated = false;
        for row in rows {
            let entry = row?;
            bytes += serde_json::to_vec(&entry)?.len();
            if entries.len() == 512 || bytes > latte_work_protocol::MAX_FRAME / 2 {
                truncated = true;
                break;
            }
            entries.push(entry);
        }
        Ok((entries, truncated))
    }
    pub fn revoke_reference_access(&self, project: &str, path: &str) -> Result<bool> {
        self.project(project)?;
        // Delete the recorded canonical key even if the file was moved or removed.
        let removed = self.db.execute(
            "DELETE FROM reference_access WHERE project_id=?1 AND path=?2",
            params![project, path],
        )?;
        Ok(removed != 0)
    }
    pub fn reference_allowed(&self, project: &str, target: &Path) -> Result<bool> {
        let rows = self
            .db
            .prepare("SELECT path,directory FROM reference_access WHERE project_id=?1 ORDER BY path LIMIT 512")?
            .query_map([project], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .iter()
            .any(|(path, dir)| target == Path::new(path) || (*dir && target.starts_with(path))))
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
            index_event(&tx, id, &event)?;
        }
        tx.execute("UPDATE message_queue SET status='dispatched' WHERE request_id=?1 AND session_id=?2 AND status IN ('pending','forwarded')", params![request_id,id])?;
        tx.commit()?;
        Ok(true)
    }
    fn presentation_event(&self, id: &str, data: &str) -> Result<EventKind> {
        let event: EventKind = serde_json::from_str(data)?;
        if matches!(event, EventKind::ToolResult { .. }) && data.contains("\"source\"") {
            return Ok(crate::agents::normalize_history_event(
                &self.session(id)?.agent,
                event,
            ));
        }
        Ok(event)
    }
    /// Presentation delivery for one stored event: payloads up to the whole
    /// threshold stream through unchanged; larger ones become bounded previews
    /// whose full bytes load separately in frame-safe chunks.
    /// Presentation delivery for one stored event, measured in serialized
    /// bytes: JSON escaping can inflate a payload sixfold, so decoded length
    /// alone cannot keep a response inside one frame. Returns the event, its
    /// full payload size when previewed, and the wire size for batch budgets.
    fn present_event(&self, id: &str, data: &str) -> Result<(EventKind, Option<usize>, usize)> {
        let event = self.presentation_event(id, data)?;
        let whole_limit = match &event {
            EventKind::Text { .. } | EventKind::Notice { .. } => TEXT_WHOLE_WIRE,
            _ => WHOLE_EVENT_WIRE,
        };
        let wire = serde_json::to_vec(&event)?.len();
        if wire <= whole_limit {
            return Ok((event, None, wire));
        }
        let (payload, _) = presentation_payload(&event)?;
        let size = payload.len();
        let mut head_limit = PREVIEW_BYTES.min(size);
        let (preview, wire) = loop {
            let head = clip_head(&payload, head_limit);
            let preview = preview_event(&event, head, size);
            let wire = serde_json::to_vec(&preview)?.len();
            // Escape-heavy heads shrink until their serialized form is bounded.
            if wire <= PREVIEW_WIRE || head_limit <= 32 {
                break (preview, wire);
            }
            head_limit = (head_limit / 2).max(32);
        };
        Ok((preview, Some(size), wire))
    }
    /// One stream payload per event, parsed once and shared across chunks so
    /// repeated requests slice a cached string instead of re-reading the row
    /// under the shared database lock.
    fn streamed_payload(&self, id: &str, seq: i64) -> Result<std::sync::Arc<CachedPayload>> {
        {
            let mut cache = self.content_cache.borrow_mut();
            if let Some(index) = cache
                .entries
                .iter()
                .position(|entry| entry.session == id && entry.seq == seq)
            {
                let entry = cache.entries.remove(index).unwrap();
                cache.entries.push_back(entry.clone());
                return Ok(entry);
            }
        }
        let data: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM events WHERE session_id=?1 AND seq=?2",
                params![id, seq],
                |row| row.get(0),
            )
            .optional()?;
        let Some(data) = data else {
            bail!("事件不存在");
        };
        let event = self.presentation_event(id, &data)?;
        let (text, encoding) = presentation_payload(&event)?;
        let entry = std::sync::Arc::new(CachedPayload {
            session: id.into(),
            seq,
            encoding,
            text,
        });
        let mut cache = self.content_cache.borrow_mut();
        cache.bytes += entry.text.len();
        cache.entries.push_back(entry.clone());
        while cache.bytes > CACHE_BYTES {
            let Some(evicted) = cache.entries.pop_front() else {
                break;
            };
            cache.bytes = cache.bytes.saturating_sub(evicted.text.len());
        }
        Ok(entry)
    }
    /// Streams one stored event's full payload in chunks. Offsets come from a
    /// previous response's `next`; any other value — including one landing
    /// inside a multibyte character — must fail instead of panicking while the
    /// shared database lock is held. Chunk sizes shrink until their serialized
    /// form stays frame-safe under escape inflation.
    pub fn event_content(
        &self,
        id: &str,
        seq: f64,
        offset: usize,
    ) -> Result<(ContentEncoding, String, usize, Option<usize>)> {
        if !seq.is_finite() || seq < 0.0 || seq.fract() != 0.0 {
            bail!("事件序号无效");
        }
        let entry = self.streamed_payload(id, seq as i64)?;
        let payload = entry.text.as_str();
        let total = payload.len();
        if offset > total || !payload.is_char_boundary(offset) {
            bail!("事件内容偏移无效");
        }
        let mut end = (offset + CHUNK_RAW).min(total);
        while end > offset && !payload.is_char_boundary(end) {
            end -= 1;
        }
        while end > offset {
            let fits = serde_json::to_string(&payload[offset..end])?.len() + 512 <= CHUNK_WIRE;
            if fits {
                break;
            }
            // Halve the candidate; a span of one character always fits.
            let mut half = offset + (end - offset) / 2;
            if half == offset {
                half = offset + payload[offset..].chars().next().unwrap().len_utf8();
            }
            while half < end && !payload.is_char_boundary(half) {
                half += 1;
            }
            if half >= end {
                bail!("事件内容分块异常");
            }
            end = half;
        }
        let chunk = payload[offset..end].to_owned();
        Ok((entry.encoding, chunk, total, (end < total).then_some(end)))
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
            "SELECT seq,at,octet_length(data),CASE WHEN octet_length(data)>?3 THEN NULL ELSE data END \
             FROM events WHERE session_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT 16385",
        )?;
        let mut rows = statement.query(params![id, before.unwrap_or(f64::MAX), ROW_READ_BYTES])?;
        let mut events: Vec<Event> = Vec::new();
        let mut text_fragments: Vec<String> = Vec::new();
        let mut bytes = 0;
        let mut oldest = None;
        let mut count = 0;
        let mut turns = 0;
        let mut has_more = false;
        let mut split_text = false;
        while let Some(row) = rows.next()? {
            let row_bytes = row.get::<_, i64>(2)?;
            let (event, content_size, wire) = match row.get::<_, Option<String>>(3)? {
                Some(data) => self.present_event(id, &data)?,
                // Rows past the read bound preview from their byte length
                // alone; their payload still streams on explicit request.
                None => {
                    let notice = EventKind::Notice {
                        text: format!(
                            "内容 {row_bytes} 字节超过读取上限，已省略展示；原始记录保留。"
                        ),
                    };
                    let wire = serde_json::to_vec(&notice)?.len();
                    (notice, Some(row_bytes as usize), wire)
                }
            };
            let text = match &event {
                EventKind::Text { text } => Some(text),
                _ => None,
            };
            let joins = text.is_some()
                && events
                    .last()
                    .is_some_and(|e| matches!(e.event, EventKind::Text { .. }));
            // Budget the serialized bytes actually delivered: previews stream
            // as bounded heads, so a huge stored row cannot monopolize the
            // window or inflate a response past one frame.
            let size = wire + if joins { 0 } else { id.len() + 96 };
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
                // Text placeholders merge fragments across sequence numbers, so
                // only discrete events keep their load-full identity here.
                let content_size = if matches!(event, EventKind::Text { .. }) {
                    None
                } else {
                    content_size
                };
                events.push(Event {
                    seq: oldest.unwrap(),
                    session_id: id.into(),
                    at: row.get(1)?,
                    event,
                    content_size,
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
        let mut statement = self.db.prepare(
            "SELECT seq,at,octet_length(data),CASE WHEN octet_length(data)>?3 THEN NULL ELSE data END \
             FROM events WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT 201",
        )?;
        let mut rows = statement.query(params![id, after, ROW_READ_BYTES])?;
        let mut events = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let row_bytes = row.get::<_, i64>(2)?;
            let (event, content_size, wire) = match row.get::<_, Option<String>>(3)? {
                Some(data) => self.present_event(id, &data)?,
                None => {
                    let notice = EventKind::Notice {
                        text: format!(
                            "内容 {row_bytes} 字节超过读取上限，已省略展示；原始记录保留。"
                        ),
                    };
                    let wire = serde_json::to_vec(&notice)?.len();
                    (notice, Some(row_bytes as usize), wire)
                }
            };
            // Budget the serialized bytes actually delivered; previews stream
            // as bounded heads. Always admit at least one event so an
            // oversized row can never stall the cursor behind the byte budget.
            let size = wire + id.len() + 96;
            if events.len() == 200 || (bytes + size > 1024 * 1024 && !events.is_empty()) {
                return Ok((events, true));
            }
            bytes += size;
            events.push(Event {
                seq: row.get::<_, i64>(0)? as f64,
                session_id: id.into(),
                at: row.get(1)?,
                event,
                content_size,
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
pub(crate) fn bounded_subagent_event(mut event: EventKind) -> Result<(EventKind, bool)> {
    fn clip(text: &mut String, limit: usize) -> bool {
        if text.len() <= limit {
            return false;
        }
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n…（内容已截断）");
        true
    }
    fn value(value: &mut serde_json::Value) -> Result<bool> {
        let mut encoded = serde_json::to_string(value)?;
        if encoded.len() <= 32 * 1024 {
            return Ok(false);
        }
        clip(&mut encoded, 16 * 1024);
        *value = serde_json::Value::String(encoded);
        Ok(true)
    }
    let truncated = match &mut event {
        EventKind::Text { text } | EventKind::Notice { text } => {
            if serde_json::to_string(text)?.len() > 32 * 1024 {
                clip(text, 16 * 1024);
                true
            } else {
                false
            }
        }
        EventKind::Tool { id, name, input } => {
            if id.len() > 256 {
                bail!("子智能体工具标识过长");
            }
            clip(name, 256) | value(input)?
        }
        EventKind::ToolResult { id, content, .. } => {
            if id.len() > 256 {
                bail!("子智能体工具标识过长");
            }
            value(content)?
        }
        EventKind::Progress { .. } => false,
        _ => bail!("不支持的子智能体过程事件"),
    };
    Ok((event, truncated))
}

fn index_event(tx: &rusqlite::Transaction<'_>, session: &str, event: &EventKind) -> Result<()> {
    if let EventKind::Tool { id, name, .. } = event {
        return index_tool(tx, session, id, name);
    }
    for source in crate::sources::event_sources(event) {
        index_source(tx, session, source)?;
    }
    Ok(())
}
fn index_tool(tx: &rusqlite::Transaction<'_>, session: &str, id: &str, name: &str) -> Result<()> {
    if id.is_empty() || id.len() > 512 {
        return Ok(());
    }
    if tx.execute(
        "INSERT OR IGNORE INTO observed_tools(session_id,id) VALUES (?1,?2)",
        params![session, id],
    )? == 0
    {
        return Ok(());
    }
    if let Some(source) = crate::sources::tool_source(name) {
        index_source(tx, session, source)?;
    }
    Ok(())
}
fn index_source(
    tx: &rusqlite::Transaction<'_>,
    session: &str,
    mut source: latte_work_protocol::TaskSource,
) -> Result<()> {
    if let Some(data) = tx
        .query_row(
            "SELECT data FROM task_sources WHERE session_id=?1 AND id=?2",
            params![session, source.id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        let previous: latte_work_protocol::TaskSource = serde_json::from_str(&data)?;
        source.uses = previous.uses.saturating_add(source.uses);
        for tool in previous.tools {
            if !source.tools.contains(&tool) && source.tools.len() < 64 {
                source.tools.push(tool);
            }
        }
    } else {
        let count: u32 = tx.query_row(
            "SELECT COUNT(*) FROM task_sources WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )?;
        if count >= 512 {
            return Ok(());
        }
    }
    tx.execute("INSERT INTO task_sources(session_id,id,data,at) VALUES (?1,?2,?3,?4) ON CONFLICT(session_id,id) DO UPDATE SET data=excluded.data,at=excluded.at",params![session,source.id,serde_json::to_string(&source)?,now()])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn native_rename_context_survives_restart_and_rejects_unknown_or_changed_launches() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite");
        let store = super::Store::open(&path).unwrap();
        let project = store.add_project(directory.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        assert!(
            !store
                .native_rename_context_matches(&session.id, "native", Some("B"))
                .unwrap()
        );
        store
            .remember_native_context(&session.id, "native", Some("B"))
            .unwrap();
        drop(store);
        let store = super::Store::open(&path).unwrap();
        assert!(
            store
                .native_rename_context_matches(&session.id, "native", Some("B"))
                .unwrap()
        );
        assert!(
            !store
                .native_rename_context_matches(&session.id, "native", Some("A"))
                .unwrap()
        );
        assert!(
            !store
                .native_rename_context_matches(&session.id, "other", Some("B"))
                .unwrap()
        );
        store
            .remember_native_context(&session.id, "native", Some("C"))
            .unwrap();
        assert!(
            !store
                .native_rename_context_matches(&session.id, "native", Some("B"))
                .unwrap()
        );
        assert!(
            store
                .native_rename_context_matches(&session.id, "native", Some("C"))
                .unwrap()
        );
    }

    #[test]
    fn legacy_handback_history_pages_keep_one_masked_event_per_identity() {
        use super::*;
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("state.sqlite")).unwrap();
        let project = store.add_project(directory.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        store
            .event(
                &session.id,
                EventKind::Subagent {
                    update: SubagentUpdate {
                        id: "child".into(),
                        tool_use_id: Some("parent-tool".into()),
                        agent_type: None,
                        title: None,
                        status: Some(SubagentStatus::Completed),
                        summary: None,
                        last_tool: None,
                    },
                },
            )
            .unwrap();
        let event = |seq, event| Event {
            seq,
            session_id: session.id.clone(),
            at: 0.0,
            event,
            content_size: None,
        };
        let prefix: Vec<_> = (0..125)
            .map(|i| {
                event(
                    i as f64,
                    EventKind::Notice {
                        text: "Earlier activity".into(),
                    },
                )
            })
            .chain([
                event(
                    125.0,
                    EventKind::Tool {
                        id: "handback".into(),
                        name: "SubagentHandback".into(),
                        input: serde_json::json!({"message":"All tests pass"}),
                    },
                ),
                event(
                    126.0,
                    EventKind::ToolResult {
                        id: "handback".into(),
                        content: serde_json::json!("{\"success\":true}"),
                        is_error: false,
                    },
                ),
            ])
            .collect();
        for variant in 0..3 {
            let mut cached = prefix.clone();
            if variant == 2 {
                cached.push(event(
                    126.0 + 1.0 / 64.0,
                    EventKind::Text {
                        text: "All tests pass".into(),
                    },
                ));
            }
            if variant != 0 {
                cached.push(event(
                    126.0 + 1.0 / 64.0,
                    EventKind::Text {
                        text: "All tests pas[redacted]".into(),
                    },
                ));
            }
            cached.push(event(
                127.0,
                EventKind::Notice {
                    text: "Later activity".into(),
                },
            ));
            let snapshot = (cached, false);
            let normalized =
                crate::agents::normalize_child_transcript("claude", snapshot.clone()).unwrap();
            assert!(
                normalized
                    .0
                    .windows(2)
                    .all(|pair| pair[0].seq < pair[1].seq)
            );
            store
                .cache_subagent_transcript(&session.id, "child", &snapshot)
                .unwrap();
            let (mut after, mut replay) = (None, Vec::new());
            loop {
                let latte_work_protocol::Response::SubagentHistory {
                    events,
                    after: cursor,
                    has_more,
                    source,
                    ..
                } = store
                    .subagent_history(&session.id, "child", after, Some("legacy"), false)
                    .unwrap()
                else {
                    panic!("history")
                };
                assert_eq!(source, "legacy");
                if after.is_none() {
                    assert_eq!(events.len(), 128);
                    assert!(
                        matches!(&events[127].event, EventKind::Text { text } if text == if variant == 0 { "All tests pass" } else { "All tests pas[redacted]" })
                    );
                }
                replay.extend(events);
                after = cursor;
                if !has_more {
                    break;
                }
            }
            assert_eq!(
                serde_json::to_value(&replay).unwrap(),
                serde_json::to_value(&normalized.0).unwrap()
            );
            assert_eq!(
                serde_json::to_value(
                    crate::agents::normalize_child_transcript("claude", normalized.clone())
                        .unwrap()
                )
                .unwrap(),
                serde_json::to_value(normalized).unwrap()
            );
        }
    }

    #[test]
    fn native_titles_require_one_known_context_across_the_session() {
        let directory = tempfile::tempdir().unwrap();
        let store = super::Store::open(&directory.path().join("state.sqlite")).unwrap();
        let project = store.add_project(directory.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let cli = crate::providers::turn_fingerprint(Some(&latte_work_protocol::TurnProvider::Cli))
            .unwrap()
            .unwrap();
        let matches = |fingerprint: &str, legacy| {
            store
                .native_title_context_matches(&session.id, Some(fingerprint), legacy)
                .unwrap()
        };
        assert!(matches(&cli, true));
        store.db.execute("INSERT INTO requests(id,session_id,text,provider_fingerprint) VALUES ('legacy',?1,'input',NULL)",[&session.id]).unwrap();
        assert!(matches(&cli, true));
        assert!(!matches("configured", false));
        store
            .db
            .execute(
                "UPDATE requests SET provider_fingerprint='configured' WHERE session_id=?1",
                [&session.id],
            )
            .unwrap();
        assert!(matches("configured", false));
        assert!(!matches(&cli, true));
        store.db.execute("INSERT INTO requests(id,session_id,text,provider_fingerprint) VALUES ('changed',?1,'input','other')",[&session.id]).unwrap();
        assert!(!matches("configured", false));
        assert!(!matches("other", false));
        assert!(!matches(&cli, true));
    }
    #[test]
    fn concurrent_preview_grants_cannot_exceed_the_limit() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("access.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        for i in 0..511 {
            store
                .grant_reference(&project.id, &format!("/outside/{i}"), false)
                .unwrap();
        }
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let workers: Vec<_> = (0..4)
            .map(|i| {
                let path = path.clone();
                let project = project.id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let other = Store::open(&path).unwrap();
                    barrier.wait();
                    other
                        .grant_reference(&project, &format!("/racing/{i}"), false)
                        .is_ok()
                })
            })
            .collect();
        let granted = workers
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>();
        assert_eq!(granted, 1);
        assert_eq!(store.reference_access(&project.id).unwrap().0.len(), 512);
    }
    #[test]
    fn activity_index_migration_keeps_history_and_survives_reopening() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        store
            .event(
                &session.id,
                EventKind::Text {
                    text: "preserved".into(),
                },
            )
            .unwrap();
        store.db.execute_batch("DROP INDEX events_recent_activity_v2; CREATE INDEX events_recent_activity ON events(session_id,seq);").unwrap();
        drop(store);
        for _ in 0..2 {
            let store = Store::open(&path).unwrap();
            assert_eq!(
                store
                    .db
                    .query_row(
                        "SELECT COUNT(*) FROM events WHERE session_id=?1",
                        [&session.id],
                        |row| row.get::<_, u32>(0)
                    )
                    .unwrap(),
                1
            );
            assert_eq!(store.db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('events_recent_activity','events_recent_activity_v2')", [], |row| row.get::<_, u32>(0)).unwrap(), 1);
        }
    }
    #[test]
    fn retained_preview_access_lists_fit_the_wire_budget_even_with_long_paths() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("access.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        for i in 0..512 {
            let path = format!("/{}{i}.md", "many\\folder/".repeat(300));
            store.grant_reference(&project.id, &path, false).unwrap();
        }
        let (entries, truncated) = store.reference_access(&project.id).unwrap();
        assert!(truncated && !entries.is_empty() && entries.len() < 512);
        let response = latte_work_protocol::Response::ReferenceAccess { entries, truncated };
        assert!(serde_json::to_vec(&response).unwrap().len() < latte_work_protocol::MAX_FRAME);
    }
    #[test]
    fn retained_preview_access_is_bounded_durable_and_revocable_without_the_file() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("access.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        for i in 0..512 {
            store
                .grant_reference(&project.id, &format!("/outside/{i:03}"), true)
                .unwrap();
        }
        assert!(
            store
                .grant_reference(&project.id, "/overflow", false)
                .is_err()
        );
        store
            .grant_reference(&project.id, "/outside/000", false)
            .unwrap();
        assert!(
            !store
                .reference_allowed(&project.id, Path::new("/outside/000/child.md"))
                .unwrap()
        );
        assert!(
            store
                .reference_allowed(&project.id, Path::new("/outside/001/child.md"))
                .unwrap()
        );
        assert!(
            !store
                .reference_allowed(&project.id, Path::new("/outside/001-other/child.md"))
                .unwrap()
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        let (entries, truncated) = store.reference_access(&project.id).unwrap();
        assert_eq!(entries.len(), 512);
        assert!(!truncated);
        assert_eq!(entries[0].path, "/outside/000");
        // Legacy versions could retain more than the new admission limit.
        store.db.execute("INSERT INTO reference_access(project_id,path,directory) VALUES (?1,'/legacy-a',0),(?1,'/legacy-b',0)", [&project.id]).unwrap();
        let (entries, truncated) = store.reference_access(&project.id).unwrap();
        assert_eq!(entries.len(), 512);
        assert!(truncated);
        store
            .revoke_reference_access(&project.id, "/legacy-a")
            .unwrap();
        store
            .revoke_reference_access(&project.id, "/legacy-b")
            .unwrap();
        store
            .revoke_reference_access(&project.id, "/outside/001")
            .unwrap();
        store
            .revoke_reference_access(&project.id, "/outside/001")
            .unwrap();
        assert!(
            !store
                .reference_allowed(&project.id, Path::new("/outside/001/child.md"))
                .unwrap()
        );
        store
            .grant_reference(&project.id, "/overflow", false)
            .unwrap();
        assert!(store.reference_access("missing-project").is_err());
        assert!(
            store
                .revoke_reference_access("missing-project", "/overflow")
                .is_err()
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(
            !store
                .reference_allowed(&project.id, Path::new("/outside/001"))
                .unwrap()
        );
    }
    #[test]
    fn native_names_follow_external_renames_while_generated_titles_preserve_manual_names() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("titles.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        assert_eq!(
            store
                .sync_native_title(&session.id, "Generated", false)
                .unwrap()
                .title,
            "Generated"
        );
        store.rename_session(&session.id, "Manual").unwrap();
        let current = store
            .sync_native_title(&session.id, "Later generated", false)
            .unwrap();
        assert_eq!(current.title, "Manual");
        assert!(current.custom_title);
        assert_eq!(
            store
                .sync_live_native_title(&session.id, "New manual")
                .unwrap()
                .title,
            "New manual"
        );
    }
    #[test]
    fn mark_title_requested_persists_across_reopen_and_defaults_false_for_legacy_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("title-requests.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let project_id = project.id.clone();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        assert!(!session.title_requested);
        store.mark_title_requested(&session.id).unwrap();
        assert!(store.session(&session.id).unwrap().title_requested);
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(
            store.session(&session.id).unwrap().title_requested,
            "the once marker survives a reopen"
        );
        // A legacy row written before the marker existed parses with the default.
        let legacy = serde_json::json!({
            "id": "legacy",
            "project_id": project_id,
            "title": "首条输入前缀",
            "agent": "claude",
            "native_id": null,
            "status": "ready",
            "created_at": 1.0
        });
        store
            .db
            .execute(
                "INSERT INTO sessions(id,project_id,data) VALUES ('legacy',?1,?2)",
                params![project_id, serde_json::to_string(&legacy).unwrap()],
            )
            .unwrap();
        let restored = store.session("legacy").unwrap();
        assert_eq!(restored.title, "首条输入前缀");
        assert!(!restored.title_requested);
    }
    #[test]
    fn sync_native_title_ai_writes_consume_the_generation_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("sync-titles.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let mut session = store.create_session(project.id, "claude".into()).unwrap();
        session.native_id = Some("current".into());
        store.save(&session).unwrap();
        assert!(!store.session(&session.id).unwrap().title_requested);
        // A generated or imported AI title consumes the one generation chance.
        let imported = store
            .sync_native_title(&session.id, "AI 标题", false)
            .unwrap();
        assert_eq!(imported.title, "AI 标题");
        assert!(imported.title_requested);
        // A manual native name never consumes it for a fresh session.
        let other = store
            .create_session(session.project_id, "claude".into())
            .unwrap();
        let manual = store.sync_native_title(&other.id, "Manual", true).unwrap();
        assert!(manual.custom_title);
        assert!(!manual.title_requested);
    }
    #[test]
    fn upgrade_backfill_marks_consumed_titles_and_keeps_prefix_chances() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backfill.db");
        {
            let store = Store::open(&path).unwrap();
            let project = store.add_project(dir.path()).unwrap();
            let project_id = project.id.clone();
            let legacy =
                |store: &Store, id: &str, native: Option<&str>, custom: bool, title: &str| {
                    let value = serde_json::json!({
                        "id": id, "project_id": project_id, "title": title,
                        "agent": "claude", "native_id": native, "custom_title": custom,
                        "status": "ready", "created_at": 1.0
                    });
                    store
                        .db
                        .execute(
                            "INSERT INTO sessions(id,project_id,data) VALUES (?1,?2,?3)",
                            params![id, project_id, serde_json::to_string(&value).unwrap()],
                        )
                        .unwrap();
                };
            legacy(
                &store,
                "prefix-native",
                Some("n1"),
                false,
                "修复消息发送后的输入框",
            );
            legacy(&store, "ai-native", Some("n2"), false, "AI 生成的标题");
            legacy(&store, "orphan-native", Some("n3"), false, "来源不明的标题");
            legacy(&store, "opened-native", Some("n4"), false, "新任务");
            legacy(&store, "renamed-native", Some("n5"), true, "手改的标题");
            legacy(&store, "non-native", None, false, "修复消息发送后的输入框");
            for (request_id, session_id) in [
                ("r1", "prefix-native"),
                ("r2", "ai-native"),
                ("r3", "renamed-native"),
            ] {
                store
                    .db
                    .execute(
                        "INSERT INTO requests(id,session_id,text) VALUES (?1,?2,?3)",
                        params![request_id, session_id, "修复消息发送后的输入框"],
                    )
                    .unwrap();
            }
        }
        let store = Store::open(&path).unwrap();
        let flag = |store: &Store, id: &str| store.session(id).unwrap().title_requested;
        assert!(
            !flag(&store, "prefix-native"),
            "prefix titles keep the chance"
        );
        assert!(flag(&store, "ai-native"), "earned AI titles are consumed");
        assert!(
            flag(&store, "orphan-native"),
            "native history without a local turn is never regenerated over"
        );
        assert!(
            !flag(&store, "opened-native"),
            "sessions that were only opened keep their generation chance"
        );
        assert!(
            !flag(&store, "renamed-native"),
            "manual renames are not read as generated titles"
        );
        assert!(!flag(&store, "non-native"));
    }
    #[test]
    fn redacted_native_titles_survive_reimport_and_restart_without_raw_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("redacted-titles.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let mut session = store.create_session(project.id, "claude".into()).unwrap();
        session.native_id = Some("current".into());
        store.save(&session).unwrap();
        store
            .remember_title_credential(&session.id, "current", "private-token")
            .unwrap();
        assert_eq!(
            store
                .sync_native_title(&session.id, "Fix private-token", false)
                .unwrap()
                .title,
            "Fix [redacted]"
        );
        assert_eq!(
            store
                .sync_native_title(&session.id, "Other private-token", false)
                .unwrap()
                .title,
            "Other [redacted]"
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        for custom in [false, true] {
            assert_eq!(
                store
                    .sync_native_title(&session.id, "Fix private-token", custom)
                    .unwrap()
                    .title,
                "Fix [redacted]"
            );
        }
        store
            .remember_title_credential(&session.id, "current", "密钥🙂")
            .unwrap();
        assert_eq!(
            store
                .sync_native_title(&session.id, "修复密钥🙂 与 private-token", true)
                .unwrap()
                .title,
            "修复[redacted] 与 [redacted]"
        );
        let data: String = store
            .db
            .query_row("SELECT group_concat(data) FROM sessions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let redactions: String = store
            .db
            .query_row(
                "SELECT group_concat(hex(secret_hash)) FROM native_title_secrets",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!data.contains("private-token") && !redactions.contains("private-token"));
        let mut replaced = store.session(&session.id).unwrap();
        replaced.native_id = Some("other".into());
        replaced.custom_title = false;
        store.save(&replaced).unwrap();
        assert_eq!(
            store
                .sync_native_title(&session.id, "Fix private-token", false)
                .unwrap()
                .title,
            "Fix private-token",
            "a redaction rule belongs only to its original native identity"
        );
    }
    #[test]
    fn subagent_transcripts_coalesce_streams_keep_aliases_and_survive_restart() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("children.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        for (native, tool) in [
            ("tool:first", "first"),
            ("native-first", "first"),
            ("tool:second", "second"),
        ] {
            store
                .event(
                    &session.id,
                    EventKind::Subagent {
                        update: SubagentUpdate {
                            agent_type: None,
                            id: native.into(),
                            tool_use_id: Some(tool.into()),
                            title: None,
                            status: Some(SubagentStatus::Running),
                            summary: None,
                            last_tool: None,
                        },
                    },
                )
                .unwrap();
        }
        let parent_count = store.events(&session.id, 0.0).unwrap().0.len();
        for (tool, text) in [("first", "一"), ("second", "other"), ("first", "二")] {
            store
                .subagent_event(&session.id, tool, EventKind::Text { text: text.into() })
                .unwrap();
        }
        let (first, truncated) = store
            .subagent_transcript(&session.id, "tool:first")
            .unwrap();
        assert!(!truncated);
        assert_eq!(first.len(), 1);
        assert!(matches!(&first[0].event, EventKind::Text { text } if text == "一二"));
        let second = store
            .subagent_transcript(&session.id, "tool:second")
            .unwrap()
            .0;
        assert!(matches!(&second[0].event, EventKind::Text { text } if text == "other"));
        assert_eq!(
            store.events(&session.id, 0.0).unwrap().0.len(),
            parent_count
        );
        let other = store
            .create_session(session.project_id.clone(), "claude".into())
            .unwrap();
        assert!(store.subagent_transcript(&other.id, "tool:first").is_err());
        assert!(
            store
                .subagent_event(
                    &other.id,
                    "first",
                    EventKind::Text {
                        text: "wrong session".into()
                    }
                )
                .is_err()
        );
        drop(store);
        let restored = Store::open(&path).unwrap();
        assert_eq!(
            restored
                .subagent_transcript(&session.id, "tool:first")
                .unwrap()
                .0
                .len(),
            1
        );
        assert_eq!(
            restored.subagents(&session.id).unwrap().0[0].status,
            SubagentStatus::Unknown
        );
    }

    #[test]
    fn full_child_stream_history_pages_without_losing_records_or_long_fields() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("history.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        store
            .event(
                &session.id,
                EventKind::Subagent {
                    update: SubagentUpdate {
                        agent_type: None,
                        id: "child".into(),
                        tool_use_id: Some("p".into()),
                        title: None,
                        status: Some(SubagentStatus::Running),
                        summary: None,
                        last_tool: None,
                    },
                },
            )
            .unwrap();
        for i in 0..600 {
            store
                .subagent_event(
                    &session.id,
                    "p",
                    EventKind::Tool {
                        id: format!("tool-{i}"),
                        name: "Read".into(),
                        input: serde_json::json!({"text":"参数".repeat(100)}),
                    },
                )
                .unwrap();
        }
        let report = "中文完整报告".repeat(20_000);
        store
            .subagent_event(
                &session.id,
                "p",
                EventKind::Tool {
                    id: "report".into(),
                    name: "SubagentHandback".into(),
                    input: serde_json::json!({"message":report}),
                },
            )
            .unwrap();
        store
            .subagent_event(
                &session.id,
                "p",
                EventKind::ToolResult {
                    id: "report".into(),
                    content: serde_json::json!("{\"success\":true}"),
                    is_error: false,
                },
            )
            .unwrap();
        let mut after = None;
        let mut found = Vec::new();
        loop {
            let response = store
                .subagent_history(&session.id, "child", after, Some("stream"), false)
                .unwrap();
            assert!(serde_json::to_vec(&response).unwrap().len() < latte_work_protocol::MAX_FRAME);
            let latte_work_protocol::Response::SubagentHistory {
                events,
                has_more,
                after: next,
                incomplete,
                ..
            } = response
            else {
                panic!("history");
            };
            assert!(!incomplete);
            assert!(next > after);
            found.extend(events);
            after = next;
            if !has_more {
                break;
            }
        }
        assert_eq!(found.len(), 603);
        assert!(matches!(&found[600].event,EventKind::Tool{input,..} if input["message"]==report));
        assert!(matches!(&found[602].event,EventKind::Text{text} if text==&report));
        assert!(
            store
                .subagent_history(&session.id, "other", None, None, false)
                .is_err()
        );
        assert!(
            store
                .subagent_history(&session.id, "child", Some(f64::NAN), None, false)
                .is_err()
        );
        drop(store);
        let reopened = Store::open(&dir.path().join("history.db")).unwrap();
        assert!(
            matches!(reopened.subagent_history(&session.id,"child",after,Some("stream"),false).unwrap(),latte_work_protocol::Response::SubagentHistory{events,has_more:false,..} if events.is_empty())
        );
    }

    #[test]
    fn subagent_transcripts_bound_content_and_records_without_inventing_results() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("children.db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        store
            .event(
                &session.id,
                EventKind::Subagent {
                    update: SubagentUpdate {
                        agent_type: None,
                        id: "child".into(),
                        tool_use_id: Some("p".into()),
                        title: None,
                        status: Some(SubagentStatus::Running),
                        summary: None,
                        last_tool: None,
                    },
                },
            )
            .unwrap();
        store
            .subagent_event(
                &session.id,
                "p",
                EventKind::Text {
                    text: "中".repeat(100_000),
                },
            )
            .unwrap();
        let (events, partial) = store.subagent_transcript(&session.id, "child").unwrap();
        assert!(partial);
        assert!(serde_json::to_vec(&events).unwrap().len() < 128 * 1024);
        for i in 0..501 {
            store
                .subagent_event(
                    &session.id,
                    "p",
                    EventKind::Tool {
                        id: format!("t{i}"),
                        name: "Read".into(),
                        input: serde_json::json!({}),
                    },
                )
                .unwrap();
        }
        let (events, partial) = store.subagent_transcript(&session.id, "child").unwrap();
        assert!(partial);
        assert_eq!(events.len(), 500);
        assert!(
            events
                .iter()
                .all(|e| matches!(e.event, EventKind::Tool { .. }))
        );
        assert!(
            store
                .subagent_event(
                    &session.id,
                    "p",
                    EventKind::State {
                        status: Status::Completed,
                        message: None
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn recent_history_pages_all_visible_projects_and_ignores_read_metadata() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recent.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let other_dir = dir.path().join("other");
        std::fs::create_dir(&other_dir).unwrap();
        let other = store.add_project(&other_dir).unwrap();
        let mut ids = Vec::new();
        for i in 0..105 {
            let mut session = store
                .create_session(
                    if i % 2 == 0 {
                        project.id.clone()
                    } else {
                        other.id.clone()
                    },
                    "claude".into(),
                )
                .unwrap();
            session.created_at = 10.0;
            store.save(&session).unwrap();
            ids.push(session.id);
        }
        // Existing history is projected without rewriting session data.
        store
            .event(
                &ids[0],
                EventKind::Text {
                    text: "older conversation, new reply".into(),
                },
            )
            .unwrap();
        store
            .db
            .execute("UPDATE events SET at=20 WHERE session_id=?1", [&ids[0]])
            .unwrap();
        store.mark_session_unread(&ids[1], false).unwrap();
        store.rename_session(&ids[1], "metadata only").unwrap();
        store.pin_session(&ids[1], true).unwrap();
        store
            .event(
                &ids[1],
                EventKind::State {
                    status: Status::Ready,
                    message: None,
                },
            )
            .unwrap();
        let (first, next) = store.recent_sessions(None).unwrap();
        assert_eq!(first.len(), 100);
        assert_eq!(first[0].session.id, ids[0]);
        assert_eq!(first[0].updated_at, 20.0);
        assert!(first.iter().any(|row| row.session.project_id == other.id));
        let (second, end) = store.recent_sessions(next.as_ref()).unwrap();
        assert_eq!(second.len(), 5);
        assert!(end.is_none());
        let loaded: std::collections::HashSet<_> = first
            .iter()
            .chain(second.iter())
            .map(|row| row.session.id.clone())
            .collect();
        assert_eq!(loaded.len(), 105);
        store.archive_session(&ids[0], true).unwrap();
        store.remove_project(&other.id).unwrap();
        let (visible, _) = store.recent_sessions(None).unwrap();
        assert!(
            visible
                .iter()
                .all(|row| row.session.project_id == project.id && !row.session.archived)
        );
        assert!(!visible.iter().any(|row| row.session.id == ids[0]));
        assert!(
            store
                .recent_sessions(Some(&RecentCursor {
                    updated_at: -1.0,
                    id: "x".into()
                }))
                .is_err()
        );
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.recent_sessions(None).unwrap().0.len(), visible.len());
    }
    #[test]
    fn subagents_merge_native_identity_and_survive_history_windows_and_restart() {
        use super::*;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("children.db");
        let mut store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store
            .create_session(project.id.clone(), "claude".into())
            .unwrap();
        let other = store
            .create_session(project.id.clone(), "claude".into())
            .unwrap();
        store.event(&session.id, EventKind::Tool { id: "tool".into(), name: "Agent".into(), input: serde_json::json!({"prompt":"Inspect the exact changes. Original input."}) }).unwrap();
        store
            .event(
                &other.id,
                EventKind::Tool {
                    id: "tool".into(),
                    name: "Agent".into(),
                    input: serde_json::json!({"prompt":"Wrong session"}),
                },
            )
            .unwrap();
        let update = |id: &str, status| EventKind::Subagent {
            update: SubagentUpdate {
                agent_type: (id == "tool:tool").then(|| "review:code-reviewer".into()),
                id: id.into(),
                tool_use_id: Some("tool".into()),
                title: Some("检查代码".into()),
                status: Some(status),
                summary: None,
                last_tool: None,
            },
        };
        store
            .event(&session.id, update("tool:tool", SubagentStatus::Running))
            .unwrap();
        store
            .event(&session.id, update("native", SubagentStatus::Running))
            .unwrap();
        for _ in 0..140 {
            store
                .event(
                    &session.id,
                    EventKind::Notice {
                        text: "later".into(),
                    },
                )
                .unwrap();
        }
        let (tasks, _) = store.subagents(&session.id).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "tool:tool");
        assert_eq!(tasks[0].native_id, "native");
        assert_eq!(tasks[0].agent_type.as_deref(), Some("review:code-reviewer"));
        assert!(store.subagents(&other.id).unwrap().0.is_empty());
        store.state(&session.id, Status::Completed, None).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.subagents(&session.id).unwrap().0[0]
                .agent_type
                .as_deref(),
            Some("review:code-reviewer")
        );
        assert_eq!(
            store.subagents(&session.id).unwrap().0[0].status,
            SubagentStatus::Unknown
        );
        assert!(
            matches!(store.subagent_history(&session.id, "tool:tool", None, None, false).unwrap(), latte_work_protocol::Response::SubagentHistory { prompt: Some(prompt), .. } if prompt == "Inspect the exact changes. Original input.")
        );
        store
            .end_subagents(&session.id, SubagentStatus::Stopped)
            .unwrap();
        store
            .event(&session.id, update("native", SubagentStatus::Completed))
            .unwrap();
        store
            .event(&session.id, update("native", SubagentStatus::Running))
            .unwrap();
        assert_eq!(
            store.subagents(&session.id).unwrap().0[0].status,
            SubagentStatus::Completed
        );
        assert_eq!(
            store.subagents(&session.id).unwrap().0[0]
                .agent_type
                .as_deref(),
            Some("review:code-reviewer")
        );
        for n in 0..130 {
            store
                .event(
                    &session.id,
                    EventKind::Subagent {
                        update: SubagentUpdate {
                            agent_type: None,
                            id: format!("child-{n}"),
                            tool_use_id: None,
                            title: None,
                            status: Some(SubagentStatus::Completed),
                            summary: None,
                            last_tool: None,
                        },
                    },
                )
                .unwrap();
        }
        let (tasks, truncated) = store.subagents(&session.id).unwrap();
        assert_eq!(tasks.len(), 128);
        assert!(truncated);
    }

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

#[cfg(test)]
mod source_tests {
    use super::*;
    #[test]
    fn legacy_claude_image_results_are_projected_without_rewriting_saved_events() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        let native = serde_json::json!([{"type":"text","text":"image follows"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]);
        store
            .event(
                &session.id,
                EventKind::ToolResult {
                    id: "read".into(),
                    content: native.clone(),
                    is_error: false,
                },
            )
            .unwrap();
        for events in [
            store.events(&session.id, 0.0).unwrap().0,
            store.history(&session.id, None).unwrap().0,
        ] {
            assert!(events.iter().any(|event| matches!(&event.event,EventKind::ToolResult{content,..} if content[1]["data_base64"] == "iVBORw0KGgo=" && content[1].get("source").is_none())));
        }
        let raw: String = store
            .db
            .query_row(
                "SELECT data FROM events WHERE session_id=?1 ORDER BY seq DESC LIMIT 1",
                [&session.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(raw.contains("source"));
    }
    #[tokio::test]
    async fn last_saved_turn_is_session_scoped_and_ignores_old_undo_updates_and_pending_turns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        let mut store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store
            .create_session(project.id.clone(), "claude".into())
            .unwrap();
        let other = store.create_session(project.id, "claude".into()).unwrap();
        assert!(store.last_turn_changes(&session.id).unwrap().is_none());
        assert!(store.last_turn_changes("missing").is_err());
        for id in ["first", "second"] {
            store
                .begin(&session.id, id, "edit", None, None, None, None)
                .unwrap();
            let before = crate::task_changes::Snapshot::unavailable("fixture".into());
            store.save_turn_baseline(&session.id, id, &before).unwrap();
            let turn = crate::task_changes::FrozenTurn::freeze(
                id.into(),
                before,
                crate::task_changes::Snapshot::unavailable("fixture".into()),
                false,
                false,
            )
            .await
            .unwrap();
            store.finish_turn(&session.id, &turn).unwrap();
            store.state(&session.id, Status::Completed, None).unwrap();
        }
        let mut older = store.turn_changes(&session.id, "first").unwrap();
        older.changes.undo = latte_work_protocol::TurnUndoStatus::Reverted;
        store.update_turn(&session.id, &older).unwrap();
        store
            .begin(&session.id, "pending", "edit", None, None, None, None)
            .unwrap();
        store
            .save_turn_baseline(
                &session.id,
                "pending",
                &crate::task_changes::Snapshot::unavailable("fixture".into()),
            )
            .unwrap();
        assert_eq!(
            store
                .last_turn_changes(&session.id)
                .unwrap()
                .unwrap()
                .changes
                .request_id,
            "second"
        );
        assert!(store.last_turn_changes(&other.id).unwrap().is_none());
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store
                .last_turn_changes(&session.id)
                .unwrap()
                .unwrap()
                .changes
                .request_id,
            "second"
        );
    }
    #[tokio::test]
    async fn turn_snapshots_and_uncertain_undo_persist_but_inflight_capture_recovers_as_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        assert!(
            std::process::Command::new("git")
                .current_dir(&root)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
        std::fs::write(root.join("a.txt"), "before\n").unwrap();
        let path = dir.path().join("store.db");
        let mut store = Store::open(&path).unwrap();
        let project = store.add_project(&root).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        store
            .begin(&session.id, "r1", "edit", None, None, None, None)
            .unwrap();
        let before = crate::task_changes::Snapshot::capture(&root).await.unwrap();
        store
            .save_turn_baseline(&session.id, "r1", &before)
            .unwrap();
        store
            .save_turn_baseline(
                &session.id,
                "r1",
                &crate::task_changes::Snapshot::unavailable("duplicate".into()),
            )
            .unwrap();
        std::fs::write(root.join("a.txt"), "after\n").unwrap();
        let (_, saved) = store.pending_turn(&session.id).unwrap().unwrap();
        let after = crate::task_changes::Snapshot::capture(&root).await.unwrap();
        let mut turn =
            crate::task_changes::FrozenTurn::freeze("r1".into(), saved, after, false, false)
                .await
                .unwrap();
        store.finish_turn(&session.id, &turn).unwrap();
        store.finish_turn(&session.id, &turn).unwrap();
        store.state(&session.id, Status::Completed, None).unwrap();
        turn.changes.undo = latte_work_protocol::TurnUndoStatus::Unknown;
        store.update_turn(&session.id, &turn).unwrap();
        drop(store);
        let mut store = Store::open(&path).unwrap();
        let saved = store.turn_changes(&session.id, "r1").unwrap();
        assert_eq!(
            saved.changes.undo,
            latte_work_protocol::TurnUndoStatus::Unknown
        );
        assert!(saved.patch("a.txt").await.unwrap().0.contains("-before"));
        assert!(store.pending_turn(&session.id).unwrap().is_none());
        store
            .begin(&session.id, "r2", "next", None, None, None, None)
            .unwrap();
        store
            .save_turn_baseline(&session.id, "r2", &before)
            .unwrap();
        drop(store);
        std::fs::write(root.join("a.txt"), "changed while offline\n").unwrap();
        let store = Store::open(&path).unwrap();
        assert_eq!(store.session(&session.id).unwrap().status, Status::Unknown);
        assert!(store.pending_turn(&session.id).unwrap().is_none());
        let events = store.events(&session.id, 0.).unwrap().0;
        let changes: Vec<_> = events
            .iter()
            .filter_map(|e| {
                if let EventKind::TurnChanges { changes } = &e.event {
                    Some(changes)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            changes.iter().filter(|c| c.request_id == "r1").count(),
            2,
            "one result plus one unknown undo intent"
        );
        let unknown = changes.iter().find(|c| c.request_id == "r2").unwrap();
        assert!(
            unknown.interrupted
                && unknown.summary.unavailable.is_some()
                && unknown.summary.entries.is_empty()
        );
        assert!(store.turn_changes(&session.id, "r2").is_err());
    }
    #[test]
    fn baselines_and_observed_sources_persist_without_recounting_tools() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store
            .create_session(project.id.clone(), "claude".into())
            .unwrap();
        let baseline = crate::task_changes::Snapshot::unavailable("legacy".into());
        store.save_baseline(&session.id, &baseline).unwrap();
        store
            .save_baseline(
                &session.id,
                &crate::task_changes::Snapshot::unavailable("replacement".into()),
            )
            .unwrap();
        store
            .observe_tool(&session.id, "one", "mcp__docs__read")
            .unwrap();
        store
            .observe_tool(&session.id, "one", "mcp__docs__read")
            .unwrap();
        store
            .observe_tool(&session.id, "child:two", "mcp__docs__search")
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store
                .baseline(&session.id)
                .unwrap()
                .unwrap()
                .unavailable
                .as_deref(),
            Some("legacy")
        );
        let (sources, truncated) = store.sources(&session.id).unwrap();
        assert!(!truncated);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].uses, 2);
        assert_eq!(sources[0].tools.len(), 2);
    }
}

#[cfg(test)]
mod large_snapshot_tests {
    use super::*;
    use crate::task_changes::{FrozenTurn, Snapshot};
    use tokio::io::AsyncReadExt;
    #[test]
    fn event_content_rejects_mid_character_offsets_and_keeps_other_sessions_live() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store
            .create_session(project.id.clone(), "claude".into())
            .unwrap();
        let other = store.create_session(project.id, "claude".into()).unwrap();
        let record = |store: &Store, session: &str, body: &str| -> f64 {
            store
                .event(
                    session,
                    EventKind::ToolResult {
                        id: "exec".into(),
                        content: serde_json::json!(body),
                        is_error: false,
                    },
                )
                .unwrap();
            store
                .db
                .query_row(
                    "SELECT MAX(seq) FROM events WHERE session_id=?1",
                    params![session],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap() as f64
        };
        let cjk = record(&store, &session.id, &"中文负载".repeat(60_000));
        let emoji = record(&store, &session.id, &"\u{1F600}".repeat(40_000));
        // Offsets landing inside multibyte characters must fail before slicing
        // instead of panicking with the shared database lock held.
        for (seq, offset) in [(cjk, 1), (cjk, 4), (emoji, 2), (emoji, 3)] {
            assert!(store.event_content(&session.id, seq, offset).is_err());
        }
        // Valid boundaries keep streaming, and a rejected request never
        // poisons access for other sessions.
        assert!(matches!(
            store.event_content(&session.id, cjk, 0),
            Ok((ContentEncoding::Text, _, _, Some(_)))
        ));
        store
            .event(
                &other.id,
                EventKind::Text {
                    text: "still alive".into(),
                },
            )
            .unwrap();
        let (events, _) = store.events(&other.id, 0.0).unwrap();
        assert!(matches!(
            events.as_slice(),
            [Event {
                event: EventKind::Text { text },
                ..
            }] if text == "still alive"
        ));
    }
    #[test]
    fn escape_inflation_stays_frame_safe_in_previews_and_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        // 400k NUL bytes decode under the whole threshold but serialize to
        // 2.4 MB; wire budgets must preview instead of blowing the frame.
        for body in ["\0".repeat(400_000), "\\".repeat(300_000)] {
            store
                .event(
                    &session.id,
                    EventKind::ToolResult {
                        id: "exec".into(),
                        content: serde_json::json!(body),
                        is_error: false,
                    },
                )
                .unwrap();
        }
        let (events, _) = store.events(&session.id, 0.0).unwrap();
        assert_eq!(events.len(), 2);
        for event in &events {
            let wire = serde_json::to_vec(&event).unwrap().len();
            assert!(wire <= PREVIEW_WIRE, "preview wire {wire}");
            assert!(event.content_size.is_some());
        }
        assert!(serde_json::to_vec(&events).unwrap().len() < latte_work_protocol::MAX_FRAME);
        // Chunks shrink until each serialized chunk fits a frame on its own.
        for (index, body) in ["\0".repeat(400_000), "\\".repeat(300_000)]
            .into_iter()
            .enumerate()
        {
            let seq = events[index].seq;
            let mut assembled = String::new();
            let mut offset = 0;
            loop {
                let (_, chunk, total, next) =
                    store.event_content(&session.id, seq, offset).unwrap();
                assert_eq!(total, body.len());
                assert!(
                    serde_json::to_string(&chunk).unwrap().len() + 512 <= CHUNK_WIRE,
                    "chunk wire exceeds frame budget"
                );
                assembled.push_str(&chunk);
                match next {
                    Some(next_offset) => offset = next_offset,
                    None => break,
                }
            }
            assert_eq!(assembled, body);
        }
    }
    #[test]
    fn oversized_events_preview_stream_content_and_keep_polls_advancing() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("state.sqlite")).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store
            .create_session(project.id.clone(), "claude".into())
            .unwrap();
        // Multibyte payload forces chunk boundaries inside UTF-8 sequences.
        let body = "结果行·".repeat(52_000);
        assert!(body.len() > WHOLE_EVENT_WIRE && body.len() < latte_work_protocol::MAX_FRAME);
        store
            .event(
                &session.id,
                EventKind::ToolResult {
                    id: "exec-oversized".into(),
                    content: serde_json::json!(body),
                    is_error: false,
                },
            )
            .unwrap();
        let tool_seq = store.db.last_insert_rowid() as f64;
        let entries:Vec<_>=(0..20_000).map(|n|serde_json::json!({"path":format!("{n:05}-{}", "a".repeat(180)),"status":"A","added":1,"removed":0})).collect();
        let old=serde_json::json!({"kind":"turn_changes","changes":{"request_id":"legacy","summary":{"entries":entries,"added":20000,"removed":0,"binary_files":0,"truncated":false,"baseline_at":1,"unavailable":null},"interrupted":false,"background_pending":false,"undo":"ready"}}).to_string();
        assert!(old.len() > latte_work_protocol::MAX_FRAME);
        store
            .db
            .execute(
                "INSERT INTO events(session_id,at,data) VALUES (?1,1,?2)",
                params![session.id, old],
            )
            .unwrap();
        let legacy_seq = store.db.last_insert_rowid() as f64;
        store
            .event(
                &session.id,
                EventKind::Text {
                    text: "visible final reply".into(),
                },
            )
            .unwrap();
        store
            .event(
                &session.id,
                EventKind::State {
                    status: Status::Completed,
                    message: None,
                },
            )
            .unwrap();
        // The oversized tool result previews with its leading bytes and keeps
        // its full payload addressable; the frame-breaking legacy row degrades
        // to a notice. Previewed rows bill their bounded heads, so one poll
        // now carries the whole tail instead of one row per round.
        let (events, more) = store.events(&session.id, 0.0).unwrap();
        assert!(!more);
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].seq, tool_seq);
        let preview = match (&events[0].event, events[0].content_size) {
            (
                EventKind::ToolResult {
                    content: serde_json::Value::String(head),
                    ..
                },
                Some(size),
            ) if head.ends_with(PRESENTATION_MARKER)
                && head.starts_with(&body[..head.len() - PRESENTATION_MARKER.len()])
                && head.len() <= PREVIEW_BYTES + PRESENTATION_MARKER.len()
                && size == body.len() =>
            {
                head.clone()
            }
            other => panic!("preview mismatch: {other:?}"),
        };
        assert!(preview.len() < 96 * 1024);
        assert_eq!(events[1].seq, legacy_seq);
        assert!(matches!(&events[1].event, EventKind::Notice { .. }));
        assert!(events[1].content_size.is_some());
        assert!(
            matches!(&events[2].event, EventKind::Text { text } if text == "visible final reply")
        );
        assert!(events[2].content_size.is_none());
        assert!(matches!(
            events[3].event,
            EventKind::State {
                status: Status::Completed,
                ..
            }
        ));
        assert!(
            store
                .events(&session.id, events[3].seq)
                .unwrap()
                .0
                .is_empty()
        );
        // Whole-size events still split across poll batches without ever
        // stalling the cursor.
        let budget_session = store.create_session(project.id, "claude".into()).unwrap();
        let whole = "整行".repeat(66_666);
        assert!(whole.len() < WHOLE_EVENT_WIRE);
        for n in 0..3 {
            store
                .event(
                    &budget_session.id,
                    EventKind::ToolResult {
                        id: format!("exec-{n}"),
                        content: serde_json::json!(whole),
                        is_error: false,
                    },
                )
                .unwrap();
        }
        let (batch, more) = store.events(&budget_session.id, 0.0).unwrap();
        assert!(more && batch.len() == 2, "batch={}", batch.len());
        assert!(batch.iter().all(|e| e.content_size.is_none()));
        let (rest, more) = store
            .events(&budget_session.id, batch.last().unwrap().seq)
            .unwrap();
        assert!(!more && rest.len() == 1);
        let (history, ..) = store.history(&session.id, None).unwrap();
        assert!(history.iter().any(|e| e.seq == legacy_seq
            && matches!(e.event, EventKind::Notice { .. })
            && e.content_size.is_some()));
        let preserved: String = store
            .db
            .query_row("SELECT data FROM events WHERE seq=?1", [legacy_seq], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(preserved, old);
        // Streamed chunks reassemble to the exact stored payload, with
        // boundaries snapped to UTF-8 character edges.
        let mut assembled = String::new();
        let mut offset = 0;
        let mut chunks = 0;
        loop {
            let (encoding, chunk, total, next) =
                store.event_content(&session.id, tool_seq, offset).unwrap();
            assert_eq!(encoding, ContentEncoding::Text);
            assert_eq!(total, body.len());
            assert!(chunk.len() <= CHUNK_RAW);
            assembled.push_str(&chunk);
            chunks += 1;
            match next {
                Some(next_offset) => {
                    assert!(next_offset > offset);
                    offset = next_offset;
                }
                None => break,
            }
        }
        assert!(chunks > 1, "payload must span multiple chunks");
        assert_eq!(assembled, body);
        assert!(matches!(
            store.event_content(&session.id, legacy_seq, 0),
            Ok((ContentEncoding::Json, _, _, _))
        ));
        assert!(
            store
                .event_content(&session.id, tool_seq, body.len() + 1)
                .is_err()
        );
        assert!(store.event_content(&session.id, tool_seq + 0.5, 0).is_err());
        assert!(store.event_content(&session.id, 999_999.0, 0).is_err());
    }
    #[tokio::test]
    async fn large_file_bytes_stay_on_disk_and_small_references_survive_restart_and_undo() {
        use std::io::{Seek, SeekFrom, Write};
        let state = tempfile::tempdir().unwrap();
        let project_root = tempfile::tempdir().unwrap();
        let root = project_root.path();
        let path = state.path().join("state.sqlite");
        let mut store = Store::open(&path).unwrap();
        let project = store.add_project(root).unwrap();
        let mut session = store.create_session(project.id, "claude".into()).unwrap();
        store
            .begin(&session.id, "large-turn", "edit", None, None, None, None)
            .unwrap();
        let mut file = std::fs::File::create(root.join("large.bin")).unwrap();
        file.set_len(32 * 1024 * 1024).unwrap();
        let before = Snapshot::capture_stored(root, &store.snapshot_dir)
            .await
            .unwrap();
        assert!(serde_json::to_string(&before).unwrap().len() < 1024);
        store.save_baseline(&session.id, &before).unwrap();
        store
            .save_turn_baseline(&session.id, "large-turn", &before)
            .unwrap();
        let baseline_bytes: i64 = store
            .db
            .query_row("SELECT octet_length(baseline) FROM turn_changes", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(baseline_bytes < 1024);
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(b"x").unwrap();
        file.sync_all().unwrap();
        let after = Snapshot::capture_stored(root, &store.snapshot_dir)
            .await
            .unwrap();
        let turn = FrozenTurn::freeze("large-turn".into(), before, after, false, false)
            .await
            .unwrap();
        assert!(serde_json::to_string(&turn).unwrap().len() < 2048);
        store.finish_turn(&session.id, &turn).unwrap();
        session.status = Status::Completed;
        store.save(&session).unwrap();
        let orphan = crate::snapshot_storage::save_file(
            &store.snapshot_dir,
            tokio::io::repeat(12).take(12345),
        )
        .await
        .unwrap();
        let orphan_path = orphan.path().unwrap();
        std::fs::write(store.snapshot_dir.join("keep.txt"), "not an object").unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(!orphan_path.exists());
        assert!(store.snapshot_dir.join("keep.txt").exists());
        let turn = store.turn_changes(&session.id, "large-turn").unwrap();
        turn.validate_undo(root).unwrap();
        assert!(turn.patch("large.bin").await.unwrap().0.contains("Binary"));
        turn.restore(root).unwrap();
        let mut restored = std::fs::File::open(root.join("large.bin")).unwrap();
        restored.seek(SeekFrom::End(-1)).unwrap();
        let mut byte = [1];
        std::io::Read::read_exact(&mut restored, &mut byte).unwrap();
        assert_eq!(byte, [0]);
        assert!(store.pending_turn(&session.id).unwrap().is_none());
        assert!(store.baseline(&session.id).unwrap().is_some());
    }
    #[tokio::test]
    async fn legacy_large_rows_archive_exactly_and_migrate_only_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.sqlite");
        let mut store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        store
            .begin(&session.id, "legacy", "edit", None, None, None, None)
            .unwrap();
        let snapshot = Snapshot::unavailable("legacy".into());
        let baseline = serde_json::to_string(&snapshot).unwrap() + &" ".repeat(1024 * 1024);
        let frozen = FrozenTurn::freeze("legacy".into(), snapshot.clone(), snapshot, false, false)
            .await
            .unwrap();
        let data = serde_json::to_string(&frozen).unwrap() + &" ".repeat(1024 * 1024);
        store
            .db
            .execute(
                "INSERT INTO task_baselines(session_id,data) VALUES (?1,?2)",
                params![session.id, baseline],
            )
            .unwrap();
        store.db.execute("INSERT INTO turn_changes(session_id,request_id,baseline,data) VALUES (?1,'legacy',?2,?3)",params![session.id,baseline,data]).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(store.pending_turn(&session.id).unwrap().is_none());
        assert!(
            store
                .baseline(&session.id)
                .unwrap()
                .unwrap()
                .unavailable
                .is_some()
        );
        assert!(
            store
                .turn_changes(&session.id, "legacy")
                .unwrap()
                .changes
                .summary
                .unavailable
                .is_some()
        );
        let archive: Vec<(String, String, String)> = store
            .db
            .prepare("SELECT source_table,source_column,path FROM snapshot_legacy_archive")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(archive.len(), 3);
        for (table, column, name) in archive {
            let bytes =
                std::fs::read_to_string(store.snapshot_dir.join("legacy").join(name)).unwrap();
            assert_eq!(
                &bytes,
                if table == "turn_changes" && column == "data" {
                    &data
                } else {
                    &baseline
                }
            );
        }
        drop(store);
        let store = Store::open(&path).unwrap();
        let count: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM snapshot_legacy_archive", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);
    }
}

#[cfg(test)]
mod legacy_snapshot_compatibility {
    use super::*;
    use crate::task_changes::{FrozenTurn, Snapshot};
    #[tokio::test]
    async fn complete_legacy_snapshots_keep_historical_diff_and_undo_after_migration() {
        let state = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let path = state.path().join("state.sqlite");
        let mut store = Store::open(&path).unwrap();
        let saved_project = store.add_project(project.path()).unwrap();
        let mut session = store
            .create_session(saved_project.id, "claude".into())
            .unwrap();
        store
            .begin(&session.id, "old-format", "edit", None, None, None, None)
            .unwrap();
        let old = "before\n".repeat(50_000);
        let new = "after\n".repeat(50_000);
        std::fs::write(project.path().join("source.txt"), &old).unwrap();
        let before = Snapshot::capture(project.path()).await.unwrap();
        std::fs::write(project.path().join("source.txt"), &new).unwrap();
        let after = Snapshot::capture(project.path()).await.unwrap();
        let turn = FrozenTurn::freeze("old-format".into(), before.clone(), after, false, false)
            .await
            .unwrap();
        let original = serde_json::to_string(&turn).unwrap();
        assert!(original.len() > crate::snapshot_storage::RECORD_LIMIT);
        store
            .db
            .execute(
                "INSERT INTO task_baselines(session_id,data) VALUES (?1,?2)",
                params![session.id, serde_json::to_string(&before).unwrap()],
            )
            .unwrap();
        store
            .db
            .execute(
                "INSERT INTO turn_changes(session_id,request_id,data) VALUES (?1,'old-format',?2)",
                params![session.id, original],
            )
            .unwrap();
        session.status = Status::Completed;
        store.save(&session).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        let turn = store.turn_changes(&session.id, "old-format").unwrap();
        assert!(turn.changes.summary.unavailable.is_none());
        assert!(!turn.changes.summary.truncated);
        assert_eq!(
            turn.changes.undo,
            latte_work_protocol::TurnUndoStatus::Ready
        );
        let patch = turn.patch("source.txt").await.unwrap().0;
        assert!(patch.contains("-before") && patch.contains("+after"));
        let summary = store
            .baseline(&session.id)
            .unwrap()
            .unwrap()
            .summary(project.path())
            .await
            .unwrap();
        assert_eq!(summary.entries[0].path, "source.txt");
        assert!(summary.unavailable.is_none());
        turn.validate_undo(project.path()).unwrap();
        turn.restore(project.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(project.path().join("source.txt")).unwrap(),
            old
        );
        let largest: i64 = store
            .db
            .query_row(
                "SELECT MAX(octet_length(data)) FROM turn_changes",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(largest < crate::snapshot_storage::RECORD_LIMIT as i64);
    }
    #[test]
    fn very_large_legacy_blob_is_streamed_to_archive_without_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.sqlite");
        let store = Store::open(&path).unwrap();
        let project = store.add_project(dir.path()).unwrap();
        let session = store.create_session(project.id, "claude".into()).unwrap();
        const SIZE: i64 = 96 * 1024 * 1024 + 1;
        store
            .db
            .execute(
                "INSERT INTO task_baselines(session_id,data) VALUES (?1,zeroblob(?2))",
                params![session.id, SIZE],
            )
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(
            store
                .baseline(&session.id)
                .unwrap()
                .unwrap()
                .unavailable
                .unwrap()
                .contains("归档")
        );
        let name: String = store
            .db
            .query_row("SELECT path FROM snapshot_legacy_archive", [], |r| r.get(0))
            .unwrap();
        let archive = store.snapshot_dir.join("legacy").join(name);
        assert_eq!(std::fs::metadata(&archive).unwrap().len(), SIZE as u64);
        let mut file = std::fs::File::open(archive).unwrap();
        let mut bytes = [1; 65536];
        let mut total = 0;
        loop {
            let count = std::io::Read::read(&mut file, &mut bytes).unwrap();
            if count == 0 {
                break;
            }
            assert!(bytes[..count].iter().all(|b| *b == 0));
            total += count as i64;
        }
        assert_eq!(total, SIZE);
        let size: i64 = store
            .db
            .query_row("SELECT octet_length(data) FROM task_baselines", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(size < 1024);
    }
}
