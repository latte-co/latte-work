//! Stable daemon lifecycle messages, accepted before the application Hello.
//! These control messages are native-only and deliberately excluded from the WebView API.
use serde::{Deserialize, Serialize};

/// One live resource claimed by a specific desktop App instance. Not durable chat state.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Resource {
    AgentSession(String),
    Terminal(String),
}
impl Resource {
    pub fn id(&self) -> &str {
        match self {
            Self::AgentSession(id) | Self::Terminal(id) => id,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Request {
    ServerStatus,
    PrepareUpgrade {
        server_id: String,
    },
    ClaimResources {
        owner_id: String,
        resources: Vec<Resource>,
    },
    AdoptResources {
        server_id: String,
        previous_owner_id: String,
        owner_id: String,
        resources: Vec<Resource>,
    },
    CloseOwnedResources {
        server_id: String,
        owner_id: String,
        resources: Vec<Resource>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    ServerStatus {
        server_id: String,
        build_id: String,
        draining: bool,
    },
    UpgradeReady,
    ResourcesClaimed,
    ResourcesClosed,
    ResourcesAdopted {
        resources: Vec<Resource>,
    },
    Error {
        code: String,
        message: String,
    },
}
