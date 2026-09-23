//! Versioned, agent-independent desktop/host wire contract.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const VERSION: u32 = 8;
pub const MAX_FRAME: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Stopped,
    Unknown,
}
impl Status {
    pub fn active(&self) -> bool {
        matches!(self, Self::Running | Self::Waiting)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent: String,
    pub native_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<Effort>,
    pub status: Status,
    pub created_at: f64,
    #[serde(default)]
    pub custom_title: bool,
    #[serde(default)]
    pub pinned_at: Option<f64>,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub archived: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
impl Effort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    User {
        text: String,
        request_id: String,
    },
    Text {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        content: Value,
        is_error: bool,
    },
    Approval {
        request_id: String,
        tool: String,
        input: Value,
    },
    ApprovalResolved {
        request_id: String,
        allow: bool,
    },
    State {
        status: Status,
        message: Option<String>,
    },
    Notice {
        text: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Event {
    pub seq: f64,
    pub session_id: String,
    pub at: f64,
    pub event: EventKind,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub provider_protocols: Vec<ProviderProtocol>,
    pub detail: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    AnthropicMessages,
    OpenaiChat,
    OpenaiResponses,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuth {
    Bearer,
    ApiKey,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
    pub auth: ProviderAuth,
    pub has_credential: bool,
    #[serde(default)]
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProviderTarget {
    pub ssh: String,
    pub server_path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentProviderBinding {
    pub agent: String,
    pub provider_id: String,
    pub provider_revision: String,
}
// Only used between host services over private local/SSH transport; never a UI response.
#[derive(Clone, Serialize, Deserialize, TS)]
pub struct ProviderSnapshot {
    pub provider: Provider,
    pub credential: String,
}
impl std::fmt::Debug for ProviderSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderSnapshot")
            .field("provider", &self.provider)
            .field("credential", &"[redacted]")
            .finish()
    }
}
#[derive(Clone, Serialize, Deserialize, TS)]
pub struct ProviderDraft {
    pub id: Option<String>,
    pub name: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
    pub auth: ProviderAuth,
    /// None preserves a saved credential; plaintext is write-only over the private host transport.
    pub credential: Option<String>,
}
impl std::fmt::Debug for ProviderDraft {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderDraft")
            .field("id", &self.id)
            .field("credential", &"[redacted]")
            .finish_non_exhaustive()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Request {
    Hello {
        version: u32,
    },
    Projects,
    Providers,
    Models {
        agent: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        project_id: Option<String>,
    },
    SaveProvider {
        provider: ProviderDraft,
    },
    DeleteProvider {
        id: String,
    },
    BindAgentProvider {
        agent: String,
        provider_id: Option<String>,
        target: Option<ProviderTarget>,
    },
    SyncAgentProvider {
        agent: String,
        snapshot: Option<ProviderSnapshot>,
    },
    AddProject {
        path: String,
        #[serde(default)]
        name: Option<String>,
    },
    RenameProject {
        project_id: String,
        name: String,
    },
    RemoveProject {
        project_id: String,
    },
    BrowseDirectories {
        path: Option<String>,
    },
    Sessions {
        project_id: String,
    },
    PinnedSessions,
    RenameSession {
        session_id: String,
        title: String,
    },
    PinSession {
        session_id: String,
        pinned: bool,
    },
    MarkSessionUnread {
        session_id: String,
        unread: bool,
    },
    ArchiveSession {
        session_id: String,
        archived: bool,
    },
    CreateSession {
        project_id: String,
        agent: String,
    },
    Send {
        session_id: String,
        request_id: String,
        text: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<Effort>,
    },
    Poll {
        session_id: String,
        after: f64,
    },
    Approve {
        session_id: String,
        request_id: String,
        allow: bool,
    },
    Cancel {
        session_id: String,
    },
    Files {
        project_id: String,
        path: String,
    },
    ReadFile {
        project_id: String,
        path: String,
    },
    Diff {
        project_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Models {
        models: Vec<String>,
        provider: Option<String>,
        default_model: Option<String>,
        effort_levels: Vec<Effort>,
        /// Display metadata only; keys remain the original selectable model IDs.
        #[serde(default)]
        model_labels: std::collections::BTreeMap<String, String>,
    },
    Providers {
        providers: Vec<Provider>,
        bindings: Vec<AgentProviderBinding>,
    },
    Hello {
        version: u32,
        server_id: String,
        agents: Vec<AgentInfo>,
    },
    Projects {
        projects: Vec<Project>,
    },
    Project {
        project: Project,
    },
    Sessions {
        sessions: Vec<Session>,
    },
    Session {
        session: Session,
    },
    Accepted {
        duplicate: bool,
    },
    Events {
        events: Vec<Event>,
        session: Session,
        has_more: bool,
    },
    Files {
        entries: Vec<FileEntry>,
    },
    Directories {
        path: String,
        parent: Option<String>,
        entries: Vec<FileEntry>,
        truncated: bool,
    },
    Content {
        text: String,
        truncated: bool,
    },
    Ok,
    Error {
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contract_uses_explicit_tag_and_rejects_unknown_method() {
        let request: Request = serde_json::from_str(r#"{"method":"hello","version":1}"#).unwrap();
        assert!(matches!(request, Request::Hello { version: 1 }));
        assert!(serde_json::from_str::<Request>(r#"{"method":"shell","command":"rm"}"#).is_err());
        assert!(!Status::Unknown.active());
        assert!(Status::Waiting.active());
    }
}

#[cfg(test)]
mod model_metadata_compatibility {
    use super::*;
    #[test]
    fn version_eight_requests_and_responses_without_labels_remain_valid() {
        let request: Request =
            serde_json::from_str(r#"{"method":"models","agent":"claude","model":null}"#).unwrap();
        assert!(matches!(
            request,
            Request::Models {
                project_id: None,
                ..
            }
        ));
        let response: Response = serde_json::from_str(r#"{"kind":"models","models":["sonnet"],"provider":null,"default_model":null,"effort_levels":[]}"#).unwrap();
        assert!(
            matches!(response, Response::Models { model_labels, .. } if model_labels.is_empty())
        );
    }
}
