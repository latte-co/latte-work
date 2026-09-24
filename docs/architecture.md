# Architecture

## Ownership

```
React UI → Tauri commands → latte-work-client
                              ├─ local server connect bridge
                              └─ OpenSSH → remote server connect bridge
                                                ↓
                                   singleton latte-work-server
                                     ├─ SQLite projects/sessions/events
                                     ├─ read-only files / Git
                                     └─ AgentAdapter → Claude CLI children
```

`latte-work-protocol` contains only serde wire types and TypeScript type export.
`latte-work-client` owns version handshakes, bounded frames, connection timeouts,
and local/SSH transport. It knows no Claude message formats.
`latte-work-server` owns all execution and durable host state. Its internal
`AgentAdapter` abstracts launch, initialization, input, permission responses and
native event decoding. `agents/claude.rs` is the first implementation. ACP and
Codex app-server can be independent future adapters without changing transports.
`apps/desktop` owns presentation, OS integration and saved host connections.

## One daemon per host user

Default state is `~/.local/share/latte-work`. `server.lock` is an OS file lock held
for the daemon lifetime. `connect` attaches to its private Unix socket, starting
`serve` only when necessary. Racing launch attempts are serialized by the lock;
losing bridges attach to the winning daemon. A bridge is not another server.
There is no per-project or per-session daemon. Multiple sessions can have
independent Claude processes. The explicit state-directory option creates an
isolated instance for testing or a separate installation, not ordinary projects.

Directory mode is 0700 and socket mode is 0600. There is no public TCP listener.
SSH uses the user's OpenSSH configuration and host-key verification. The desktop
can select a local identity file or provide a password through OpenSSH askpass;
the latter remains in process memory for the current app run and is never saved
in `hosts.json`.
Remote programs are shell-quoted and Host input rejects option injection.
Local and remote hosts use exactly the same command and protocol handlers.

## Durable lifecycle

A send transaction records a request ID, input event and Running state before
spawning. Repeating the same ID and body returns an accepted duplicate, without
launching another process. Conflicting reuse fails. Each session has at most one
active turn; different sessions can run concurrently.

A CLI process is launched per turn, and resumed with its persisted native session
ID on subsequent turns. It is a supervised process group, not a shell command.
An initialization acknowledgment is required before sending input. Stdout frames
are bounded to 1 MiB and stderr is drained. Initialization, writes, turns and
shutdown have deadlines. Cancellation terminates the entire process group; it
does not roll back changes. First version closes the process after the turn
result; detached agent jobs are not preserved beyond that boundary.

Events have monotonic sequence numbers and are stored on the host. Desktop polls
incrementally and deduplicates replay after reconnect. A completed turn requires
the native result event; malformed output or premature exit fails. On daemon
restart, previously active sessions become Unknown, never Completed. Host crashes
cannot guarantee cleanup of all descendants or recovery of an interrupted tool;
users must reconcile the project before continuing an Unknown session.

Permission requests are projected with fresh, opaque, single-use IDs. Only the
active session's control channel can resolve them, using the original tool input.
The browser cannot supply replacement tool inputs. Existing CLI permission rules
are honored; Latte Work is not a sandbox around Claude.

## Inspection and frontend

The conversation uses a presentation projection over durable protocol events.
Tool calls and results are paired by ID within a user turn; consecutive tools
share a collapsed, borderless summary. Assistant text separates activity groups,
and failures and approval controls remain outside them. Expanded operations
show both input and output in one bounded, scrollable region. Missing results
after interruption are marked unconfirmed, never inferred successful. Unmatched
results remain inspectable. This changes neither host history nor wire types.

Read-only file operations reject traversal and canonical symlink escapes and cap
text output. They are designed for trusted project directories, not as a hardened
filesystem sandbox against concurrent malicious renames. Git disables external
diff/textconv/fsmonitor and optional locks. Untracked paths appear in status;
untracked file contents are available through file preview.

The frontend never executes shell commands. Generated TypeScript protocol types
come from Rust. React renders Markdown without raw HTML, and CSP disallows remote
scripts and frames. Host connection failures do not imply agent failure. Only
server state can mark a task completed.

## Protocol evolution

Each connection must first send `hello { version: 8 }`. Version mismatches fail
before commands. A line is one JSON request or response; requests on a connection
are serialized, while separate hosts/connections run independently. Application
errors are typed response envelopes, distinct from broken transport errors.

Project creation selects a host and directory together. The sidebar merges host-scoped
project catalogs and caches them for offline display; server state remains authoritative.
Local folder selection uses the native Tauri dialog. Remote selection uses the v2
`browse_directories` request (directory metadata only, absolute paths, bounded output).
Project file previews still enforce the registered project root. Upgrade both desktop
and host server for protocol v8; an old server fails the handshake explicitly.
An unsaved task draft selects a host-scoped project before its first send. The
desktop connects to that project's host and sends `create_session` and `send` to
the same host with the selected project ID. A disconnected host disables send;
switching project does not move an existing session or persist an empty draft.

Protocol v5 adds project rename and reversible removal. Removal hides a registered
project from the catalog without deleting its directory, sessions, or events;
adding the same canonical directory restores its existing identity and history.
Projects with running or waiting sessions cannot be removed. Pinning is a local
desktop preference keyed by host and project ID. The desktop owns project context
menus and suppresses the WebView's default menus; Finder reveal is local-only and
resolves a registered project ID through the server before opening its directory.

Protocol v6 adds host-owned model catalogs and a per-turn `send.model` selection.
Provider model lists travel with the existing SSH snapshot. The server validates
selection before accepting the request and only overrides that turn's launch
snapshot. Session JSON retains the selection; the requests table migration adds
a nullable model column so duplicate detection includes model identity while old
requests remain valid. Legacy Provider records default to an empty extra-model
list, with their existing model still available as the default.


## Session organization (protocol v7)

Each host persists session title, explicit-title flag, pin timestamp, manual unread
flag, and archive flag in the existing session JSON. Legacy records default to
unarchived/unpinned/read. Organization requests run under the existing database
lock; no agent-native transcript or working directory is modified. Archive rejects
active runs, clears the pin, and prevents new sends until restored. Restore does
not re-pin. The pinned-session endpoint excludes hidden projects and caps pins at
100 per host. Desktop combines saved hosts into one global pinned section ordered
by pin time, retaining the original project row and namespacing IDs by host.

The desktop refreshes pinned sessions and the selected project's list every five
seconds. Its local pin cache preserves shortcuts while a host is unavailable;
mutations are acknowledged by the owning server. Read/unread is manual; opening
an unread conversation marks it read. Archived records are accessible from the
project's archived-list toggle and remain read-only until restored. Markdown copy
loads paginated history with size/time/page bounds and copies user/assistant text,
without raw tool payloads; exceeding a bound reports an error rather than silently
copying a truncated conversation. The last fetched page defines the live snapshot.

## Per-turn reasoning effort (protocol v8)

`send` and `Session` carry nullable, enum-validated `effort` (low, medium, high,
xhigh, max). Null requests automatic model effort. SQLite migrates the requests
ledger with a nullable effort column; duplicate request identity includes effort.
Legacy session JSON and request rows retain null. `models` accepts an optional
selected model and returns adapter effort levels. Known unsupported models are
rejected before accepting a turn; unknown custom model IDs defer to the CLI.
Both desktop and remote servers must use protocol v8 to avoid silently dropping
this option. The desktop never launches or controls the CLI directly.

The v8 model catalog also accepts an optional registered `project_id` and returns
optional/default-empty `model_labels`. These are additive display metadata:
older requests and responses remain valid, older Hosts fall back to raw model IDs,
and selection/send semantics are unchanged. Native labels are resolved on the
execution Host only when no Provider is bound; the UI does not read host settings.
