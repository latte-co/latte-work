//! Stable daemon lifecycle messages, accepted before the application Hello.
//! These control messages are native-only and deliberately excluded from the WebView API.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Request {
    ServerStatus,
    PrepareUpgrade { server_id: String },
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
    Error {
        code: String,
        message: String,
    },
}
