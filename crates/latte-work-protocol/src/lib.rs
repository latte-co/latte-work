//! Versioned, agent-independent desktop/host wire contract.
pub mod lifecycle;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const VERSION: u32 = 1;
pub const MAX_FRAME: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
}
/// Ephemeral PTY owned by the host daemon; never restored after daemon restart.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TerminalInfo {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub exited: bool,
    pub exit_code: Option<u32>,
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
    #[serde(default)]
    pub permission_mode: Option<String>,
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
/// Presentation-only execution phase; never contains reasoning text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    Waiting,
    Thinking,
    Replying,
}

/// Latest main-agent request input, never cumulative billing usage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ContextUsage {
    pub model: String,
    pub used_tokens: f64,
    pub window_tokens: Option<f64>,
}
/// Main-agent totals for a single submitted turn. Missing telemetry stays unknown.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TurnUsage {
    pub input_tokens: Option<f64>,
    pub cache_read_tokens: Option<f64>,
    pub cache_write_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub model_time_ms: Option<f64>,
    pub steps: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    Progress {
        phase: ExecutionPhase,
    },
    Usage {
        context: Option<ContextUsage>,
        totals: Option<TurnUsage>,
    },
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tool_use_id: Option<String>,
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
/// Adapter-owned native permission choice; IDs are never translated by the UI.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentPermissionMode {
    pub id: String,
    pub label: String,
    pub description: String,
    pub elevated: bool,
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
    None,
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
    #[serde(default)]
    pub model_labels: std::collections::BTreeMap<String, String>,
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
// Only used by native clients and host services over private transport; never a UI response.
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
/// An explicit per-turn override, independent of the receiving host's saved bindings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "snapshot", rename_all = "snake_case")]
pub enum TurnProvider {
    Cli,
    Snapshot(ProviderSnapshot),
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
    #[serde(default)]
    pub model_labels: std::collections::BTreeMap<String, String>,
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
/// A command reported by the selected native Agent in the project context.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentSlashCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub description: String,
    pub argument_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Request {
    Hello {
        version: u32,
    },
    Projects,
    Terminals {
        project_id: String,
    },
    CreateTerminal {
        project_id: String,
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    ReadTerminal {
        terminal_id: String,
        after: f64,
    },
    WriteTerminal {
        terminal_id: String,
        data: Vec<u8>,
    },
    ResizeTerminal {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    CloseTerminal {
        terminal_id: String,
    },
    Providers,
    AgentPermissions {
        agent: String,
    },
    AgentCommands {
        agent: String,
        project_id: String,
    },
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
    ProvidersForHost {
        host_id: String,
    },
    ForgetHostProviders {
        host_id: String,
    },
    BindHostAgentProvider {
        host_id: String,
        agent: String,
        provider_id: Option<String>,
    },
    /// Native-only export of the current local association for a remote host.
    ExportHostAgentProvider {
        host_id: String,
        agent: String,
    },
    ModelsForProvider {
        agent: String,
        model: Option<String>,
        project_id: Option<String>,
        provider: Option<Provider>,
    },
    Session {
        session_id: String,
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
        #[serde(default)]
        #[ts(optional)]
        provider: Option<TurnProvider>,
        session_id: String,
        request_id: String,
        text: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<Effort>,
        #[serde(default)]
        permission_mode: Option<String>,
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
    BeginAttachment {
        name: String,
        #[ts(type = "number")]
        size: u64,
    },
    AttachmentChunk {
        id: String,
        #[ts(type = "number")]
        offset: u64,
        data: Vec<u8>,
    },
    FinishAttachment {
        id: String,
    },
    AbortAttachment {
        id: String,
    },
    ResolveReference {
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
    Changes {
        project_id: String,
    },
    ChangeDiff {
        project_id: String,
        path: String,
        section: ChangeSection,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ChangeSection {
    Unstaged,
    Staged,
    Untracked,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GitChange {
    pub path: String,
    pub previous_path: Option<String>,
    pub section: ChangeSection,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Changes {
        entries: Vec<GitChange>,
        truncated: bool,
    },
    AgentPermissions {
        modes: Vec<AgentPermissionMode>,
    },
    AgentCommands {
        commands: Vec<AgentSlashCommand>,
    },
    Terminals {
        terminals: Vec<TerminalInfo>,
    },
    Terminal {
        terminal: TerminalInfo,
    },
    TerminalOutput {
        terminal: TerminalInfo,
        data: Vec<u8>,
        next: f64,
        has_more: bool,
        truncated: bool,
    },
    Models {
        models: Vec<String>,
        provider: Option<String>,
        default_model: Option<String>,
        effort_levels: Vec<Effort>,
        /// Display metadata only; keys remain the original selectable model IDs.
        #[serde(default)]
        model_labels: std::collections::BTreeMap<String, String>,
    },
    /// Native-only response. Must never be forwarded to the WebView.
    ProviderSnapshot {
        snapshot: Option<ProviderSnapshot>,
        #[serde(default)]
        configured: bool,
    },
    Providers {
        providers: Vec<Provider>,
        bindings: Vec<AgentProviderBinding>,
    },
    Hello {
        version: u32,
        server_id: String,
        agents: Vec<AgentInfo>,
        #[serde(default)]
        permission_settings: bool,
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
    AttachmentUpload {
        id: String,
    },
    FileReference {
        entry: FileEntry,
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
    fn requests_and_responses_without_labels_remain_valid() {
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
