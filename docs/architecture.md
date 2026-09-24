# Architecture

## Ownership

```
React UI → Tauri commands → latte-work-client
                              ├─ local server connect-local bridge
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
`AgentAdapter` is defined in `agents/adapter.rs`, separately from implementations.
The registry in `agents/mod.rs` constructs a fresh adapter by `session.agent` for
each turn and rejects unsupported IDs. Only Claude is implemented; its executable
discovery, launch configuration, wire encoding/decoding and protocol state live in
`agents/claude.rs`. The internal transport contract currently covers bounded UTF-8
line-framed stdio, not arbitrary future Agent transports.
`apps/desktop` owns presentation, OS integration and saved host connections.

## Adapter and Runtime boundary

The adapter receives `Start { prompt }`, a complete native `Message` line, or an
approval decision already authorized by Runtime. It returns ordered actions:
encoded bytes to write, readiness, native session identity, common events,
approval requests, or explicit completion. It cannot read the database, spawn a
child itself, or authorize approvals. Claude owns the sequence initialize →
acknowledgment → prompt, sends the prompt only once, and recognizes completion
from its native result message. Runtime never parses Claude JSON or sends a prompt
as a side effect of readiness; readiness only ends the startup timeout.

Runtime executes actions, supervises processes, bounds I/O, enforces deadlines,
handles cancellation, and persists session IDs/events/status. It maps native
approval requests to fresh public IDs and consumes an ID exactly once before
returning the original input and decision to the adapter. EOF or process exit
without explicit completion is a failure. Server API persists an accepted request
before launching Runtime, retaining the existing deduplication and restart rules.
The refactor does not change desktop/host protocol v1 or add another Agent.

## One daemon per host user

Default state is `~/.local/share/latte-work`. `server.lock` is an OS file lock held
for the daemon lifetime. `connect` attaches to its private Unix socket, starting
`serve` only when necessary. Racing launch attempts are serialized by the lock;
losing bridges attach to the winning daemon. A bridge is not another server.
The local `connect-local` bridge additionally compares executable SHA-256 fingerprints
using a private lifecycle handshake before the application Hello. Fingerprints
identify builds without changing protocol v1. `upgrade.lock` serializes local
coordinators. A mismatched server receives `prepare_upgrade` bound to its instance
ID; a write admission lock prevents new sends or terminal creation racing the idle
check. Running/waiting sessions, live run controls, or any open terminal block
replacement. An idle daemon drains, removes its socket and releases `server.lock`
before the bundled server starts. The coordinator verifies the replacement on the
actual socket it forwards. All waits are bounded; no requests are replayed.
Legacy servers without this handshake require a manual restart, never a forced
kill. SSH `connect` does not perform automatic upgrades.

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

## Protocol contract

Each connection must first send `hello { version: 1 }`. Version mismatches fail
before commands. A line is one JSON request or response; requests on a connection
are serialized, while separate hosts/connections run independently. Application
errors are typed response envelopes, distinct from broken transport errors.

The current development protocol baseline is v1. Feature work does not automatically
increment this number; incompatible contract changes need an explicit versioning decision.
Use desktop and host server builds from the same source revision. The v1 label alone
does not establish compatibility with earlier development snapshots.

Project creation selects a host and directory together. The sidebar merges host-scoped
project catalogs and caches them for offline display; server state remains authoritative.
Local folder selection uses the native Tauri dialog. Remote selection uses the
`browse_directories` request (directory metadata only, absolute paths, bounded output).
Project file previews still enforce the registered project root. Desktop and host
server must implement the same protocol contract; version mismatches fail the handshake.
An unsaved task draft selects a host-scoped project before its first send. The
desktop connects to that project's host and sends `create_session` and `send` to
the same host with the selected project ID. A disconnected host disables send;
switching project does not move an existing session or persist an empty draft.

The protocol supports project rename and reversible removal. Removal hides a registered
project from the catalog without deleting its directory, sessions, or events;
adding the same canonical directory restores its existing identity and history.
Projects with running or waiting sessions cannot be removed. Pinning is a local
desktop preference keyed by host and project ID. The desktop owns project context
menus and suppresses the WebView's default menus; Finder reveal is local-only and
resolves a registered project ID through the server before opening its directory.

The protocol supports host-owned model catalogs and a per-turn `send.model` selection.
Provider model lists travel with the existing SSH snapshot. The server validates
selection before accepting the request and only overrides that turn's launch
snapshot. Session JSON retains the selection; the requests table migration adds
a nullable model column so duplicate detection includes model identity while old
requests remain valid. Legacy Provider records default to an empty extra-model
list, with their existing model still available as the default.


## Session organization

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

## Per-turn reasoning effort

`send` and `Session` carry nullable, enum-validated `effort` (low, medium, high,
xhigh, max). Null requests automatic model effort. SQLite migrates the requests
ledger with a nullable effort column; duplicate request identity includes effort.
Legacy session JSON and request rows retain null. `models` accepts an optional
selected model and returns adapter effort levels. Known unsupported models are
rejected before accepting a turn; unknown custom model IDs defer to the CLI.
Both desktop and remote server builds must implement the effort fields. The desktop never launches or controls the CLI directly.

The model catalog also accepts an optional registered `project_id` and returns
optional/default-empty `model_labels`. These are additive display metadata:
older requests and responses remain valid, older Hosts fall back to raw model IDs,
and selection/send semantics are unchanged. Native labels are resolved on the
execution Host only when no Provider is bound; the UI does not read host settings.

## Interactive terminals

The protocol supports host-owned PTYs (`terminals`, `create_terminal`, `read_terminal`,
`write_terminal`, `resize_terminal`, `close_terminal`). Local and SSH use the same
requests. The server starts the host user's default login shell in a registered
project directory; the desktop only renders UTF-8 bytes with xterm.js. A terminal
is a full user shell, not the read-only file preview or an agent approval channel.

Creation uses a client UUID, is idempotent for that live terminal, and rejects
reuse in another project. On a lost creation response, the UI lists terminals
instead of spawning another shell. Input is serialized, bounded, and never
replayed on transport failure. Unknown/partially delivered input is shown explicitly.
The output cursor counts bytes; xterm's streaming decoder handles split Unicode.

Each host permits 16 open terminals (including exited tabs), each with a 1 MiB
output ring and 64 KiB read batches. Overrun is explicit. Input frames are at most
16 KiB, with bounded UI/server queues and a 2-second write deadline. Nonblocking
PTY I/O threads are cancellable. Dimensions are limited to 2–500 columns and
1–300 rows. Close hangs up the shell and kills its foreground job, with a bounded
shell kill fallback. Deliberately detached processes have ordinary shell semantics.

Sidebar state belongs only to the conversation ID. Local storage retains its
ordered tabs, selection, file location, visibility, expansion and width. First
open and closing the last tab both show the empty launcher. Draft conversations
have independent IDs; the first send copies their sidebar state to the persisted
conversation. Tabs retain their original host/project resource bindings when the
draft's target changes. Host/project are not part of the sidebar persistence key.

Tabs/emulators survive hiding and conversation switches. Host PTYs survive
client/SSH bridge disconnection. Reopening restores only that conversation's
saved terminal IDs; listing a project never imports other conversations' terminals.
They are ephemeral: output is not stored in SQLite, and a daemon restart never
recreates shells or replays commands. Closing a tab explicitly stops its PTY;
normal daemon shutdown closes all terminals. Remote hosts need a matching
server; version mismatch remains an explicit connection failure.

### Sidebar activity and unread state

The Host marks a session unread atomically with its transition from active to
completed, failed or stopped. Read acknowledgement is explicit and durable.
The desktop acknowledges the selected conversation only after polling all of its
available events while the window is visible and focused. Background completions
remain unread. The sidebar distinguishes running, waiting for approval and unread
states; collapsed projects aggregate running/waiting state. Other project lists
are refreshed serially every five seconds without launching agents or reconnect
prompts, so collapsing a project does not stop its status updates.

## Remote Provider execution

The local Provider store owns associations keyed by desktop host ID and Agent ID.
Desktop association changes do not contact or mutate the remote Provider catalog.
For model catalogs, the native client exports the selected Provider and forwards only
its metadata to the execution host. For each send it resolves the session's Agent,
exports a fresh selected snapshot and attaches it to that send over the existing SSH
connection. The WebView cannot export credentials or receive snapshot responses.

A turn explicitly chooses a snapshot or the remote CLI configuration, overriding any
legacy saved remote binding. The receiving host validates protocol, models and effort,
then persists the request before spawning. Snapshots are held in native memory and
CLI temporary settings only, never in the remote Provider catalog, request ledger or
events. Existing remote Provider data is preserved; migration does not delete it.

The request ledger stores a SHA-256 digest of the explicit turn configuration alongside
text, model and effort. Exact retries return the original acceptance; reusing an ID with
a changed snapshot, including changed credentials, fails. Reconnect does not replay a
send automatically. Daemon failure still produces Unknown state. Existing request rows
have a null digest and preserve their original deduplication behavior. Deploy desktop
and host server from the same source revision so both implement the turn override.
