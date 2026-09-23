# Latte Work

A small desktop workspace for coding agents, with local and SSH projects.

**Tauri 2 · React · Rust**. The first integration is the installed **Claude Code
CLI**, using its structured stream-json protocol and native session history.

## Start

```sh
make setup
make dev
```

Install and sign in to `claude` on each execution host before sending a task.
Create a project, select this computer or an SSH host, and choose its folder
(local system picker or remote directory browser). Then create a task and send
a prompt. You can also enter an absolute path. File
inspection and Git changes are available in the collapsible right panel.

The desktop automatically starts the bundled local server. Every connection to
the same host user shares **one server instance**. That server manages all
projects and multiple independent agent processes. Closing the desktop does not
stop host tasks. The same server binary and protocol are used over SSH.

## Version 0.1

- Local/SSH host connections and persistent project registration.
- Three resizable columns, project/session navigation, streaming Markdown.
- Claude CLI tool events, explicit permission responses, cancellation and resume.
- SQLite event replay, request deduplication, reconnect, interrupted-state recovery.
- Read-only text files and staged/unstaged Git diff, with bounded output.
- macOS desktop bundle; headless server for macOS/Linux.

The UI displays permission requests made by Claude; the CLI's existing allow
rules still apply. Register only projects you trust: print mode loads their
Claude configuration. The app does not bypass CLI permissions or manage login.

## Build and verify

```sh
make ci           # formatting, Clippy, tests, frontend build, docs
make build        # debug .app and server
make package      # release .app (no Developer ID signing) and server
make cache-info   # Cargo output path and optional sccache statistics
```

See [development](DEVELOPMENT.md), [architecture](docs/architecture.md),
[SSH setup](docs/remote.md), [UI design system](docs/design-system.md), and
[verification](docs/verification.md).

Not included in v0.1: integrated terminal, file editing, automatic remote binary
installation, other agent implementations, auto-updater, signing/notarization,
Windows support, or guaranteed continuation after a host daemon crashes.

模型服务在「设置 → Provider」统一管理，支持 Anthropic Messages、
OpenAI Chat Completions、OpenAI Responses 配置。在「设置 → 连接与 Agent」中关联兼容的
Provider；Claude Code 仅接受 Anthropic Messages，远端关联通过 SSH 同步。
详见 [Provider 与 Agent 配置](docs/providers.md)。

Provider 可配置默认模型和多个可选模型。在输入框底部选择本轮模型，下一次发送时生效；
会话记住已提交的选择，不影响其他会话。远程项目使用远端已同步的模型列表。
