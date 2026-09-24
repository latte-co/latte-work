//! Internal contract for one agent turn over bounded, UTF-8 line-framed stdio.
//! Adapters own wire encoding and protocol order, never process supervision or storage.
use crate::providers::LaunchConfig;
use anyhow::Result;
use latte_work_protocol::EventKind;
use serde_json::Value;
use tokio::process::Command;

pub struct AgentCommand {
    pub command: Command,
    /// Keep private launch files alive until the agent exits, including spawn errors.
    pub _settings: Option<tempfile::NamedTempFile>,
}

pub enum Input<'a> {
    /// Delivered exactly once after spawning; the adapter decides when to send the prompt.
    Start { prompt: &'a str },
    /// One complete line without its delimiter. Only the adapter interprets its payload.
    Message(&'a str),
    /// Delivered only after Runtime validates and consumes a pending public approval ID.
    Approval {
        id: &'a str,
        input: Value,
        allow: bool,
    },
}

pub enum Action {
    /// Already encoded bytes, including framing. Runtime only bounds and writes them.
    Write(Vec<u8>),
    /// Stop the startup deadline; this does not implicitly send any message.
    Ready,
    Event(EventKind),
    NativeSession(String),
    Approval {
        id: String,
        tool: String,
        input: Value,
    },
    /// Must follow explicit native completion evidence, never EOF or a successful exit.
    Finished {
        failed: bool,
        message: Option<String>,
    },
}

pub trait AgentAdapter: Send {
    /// Prepare launch resources; may retain resume/config context for later protocol steps.
    fn command(
        &mut self,
        binary: &str,
        cwd: &str,
        resume: Option<&str>,
        config: &LaunchConfig,
    ) -> Result<AgentCommand>;
    /// Return ordered, bounded actions in response to a host or protocol input.
    fn advance(&mut self, input: Input<'_>) -> Result<Vec<Action>>;
}
