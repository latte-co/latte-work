# Development

Requires Rust 1.97, Node 22+, macOS Command Line Tools. `make ci` also
requires actionlint and ShellCheck (install with your package manager). Host server supports macOS
and Linux; v0.1 desktop is validated on macOS. No Windows runtime claim.

`make setup`, `make dev` starts the native application. `make ci` runs the local
gate; `make package` builds an app without Developer ID signing and standalone release host server,
and on macOS also produces the verified drag-install DMG described below.
Use `make build` for a debug native app bundle. On macOS, both build modes
finish with project-owned ad-hoc signing and strict bundle verification. The CLI fixture never calls a model.

## CI and merge checks

`make test-unit` runs Rust crate-local and frontend reducer tests.
`make test-e2e` runs the final server binary through its real socket bridge with
a deterministic Claude CLI fixture. `make test-doc` runs Rust documentation
tests. `make test` runs all three layers; `make ci` also checks formatting,
generated protocol types, Clippy, workflow/shell scripts, the frontend build,
and Rustdoc. `make setup` uses public npm registry URLs recorded in the lockfile.

GitHub Actions runs host check/Clippy, UT, final-binary E2E, and release builds
on Linux and macOS. Frontend UT/build runs on Linux, macOS, and Windows;
Windows also checks, lints, and tests the portable Rust protocol and client.
The server uses Unix sockets and process groups, so Windows CI does not claim
server or native desktop support. A separate macOS job builds the native app.
`PR Gate` fails when any dependent job fails, is cancelled, or is skipped.
The repository ruleset must require `PR Gate` on `main` for this to block a
merge; a workflow file alone does not activate that remote rule.

Like Latte Code, dependencies and lint policy live in the Cargo workspace,
Make is the stable command surface, and Cargo/npm lockfiles are checked in.
Debug information is reduced; release builds use thin LTO. If sccache is on PATH,
Make enables it automatically. Do not globally install tools during setup.
Cargo target defaults to each checkout's target/ (avoids competing worktree
locks). Override CARGO_TARGET_DIR for a dedicated persistent build volume. CI
caches Cargo dependencies and npm content, separately per OS/toolchain/lockfile.
`make clean` never purges sccache, the Cargo registry, npm cache or runtime data.

The server owns projects, sessions, SQLite events and agent children. Exactly
one daemon holds an exclusive file lock per canonical state directory (the
standard user state directory is the default). Clients use a private Unix socket;
SSH runs the same binary's `connect` bridge. The bridge starts the daemon when
absent, then forwards bytes. Disconnecting a bridge does not stop the daemon.
Explicit state-directory overrides exist for tests and separate installations.

The desktop's local transport uses `connect-local`: it compares the running server's
executable SHA-256 with the bundled binary and requests an idle shutdown before
starting the new build. This identity is separate from wire protocol v1. The
private `server_status` / `prepare_upgrade` lifecycle handshake is available before
Hello and is not a WebView API. The latter binds to a server instance and closes
request admission atomically; running/waiting tasks and any open terminal veto it.
Local coordinators serialize via `upgrade.lock` and time out after 20 seconds.
SSH still uses `connect`, with no automatic remote replacement. Legacy daemons
without the lifecycle handshake require a one-time manual restart after tasks
finish and terminals close. Restarting only the desktop leaves them running.


Wire protocol changes: edit latte-work-protocol then run `make types` and
`make fmt`. Desktop presentation must not import or reproduce Claude wire types.

Read docs/architecture.md for boundaries and docs/remote.md for SSH installation.

The desktop icon source is `apps/desktop/src-tauri/icons/source.svg`. Run
`make icons` after editing it, and include the generated PNG and macOS ICNS.
Keep the rounded tile within the 80% canvas safe area for consistent Dock sizing.

Provider protocol smoke tests can use a real installed Claude CLI with disposable
localhost upstream fixtures: `python3 scripts/smoke-providers.py --binary /path/to/latte-work-server --claude /path/to/claude`. This optional native check
uses no paid model API; the automated `make ci` suite uses deterministic fixtures.
See docs/providers.md for module boundaries, persistence and compatibility limits.

## Sidebar terminal development

The terminal uses the v1 protocol contract on both the desktop and host. For isolated
native tests, a debug desktop accepts `LATTE_WORK_SERVER` pointing at a wrapper
that invokes the checkout's server with `--state-dir` in a temporary directory.
Do not replace a user's running daemon to perform smoke tests.

Focused checks: `cargo test -p latte-work-server --test e2e terminal_ --locked`
and `npm test` (frontend includes PTY output-cursor and no-input-replay
regressions). Native checks should cover Tab switching, panel hide/restore,
multiple shells, resizing, shell exit, and keyboard copy/paste.

## Agent adapter development

`crates/latte-work-server/src/agents/adapter.rs` defines the internal contract;
`agents/mod.rs` registers implementations, and `agents/claude.rs` implements the
only supported Agent. Keep protocol order and wire messages in the implementation.
Runtime consumes common actions and retains approval authorization, process
supervision and persistence. `Ready` must never implicitly send a prompt.

Focused checks: `cargo test -p latte-work-server --bin latte-work-server --locked`
for contract/adapter/runtime UT, followed by `make test-e2e` for real server/bridge
behavior with the deterministic CLI fixture. These do not measure coverage or
validate a live model service. Internal interface changes do not require a wire
protocol version increment.

## Composer references and native Agent commands

`agent_commands` is an additive protocol request scoped to agent and project. The
host launches a metadata-only adapter handshake with a 12-second deadline, bounded
frames/message count and at most two concurrent probes. No user prompt or Latte
session is created. Process groups are terminated after discovery, failure or timeout.
Only the Claude adapter knows the initialize response's command schema. Commands
are checked again against the actual turn's initialize response before sending the
original prompt, avoiding Claude's unknown-command fallback to an ordinary model turn.
The existing send request ID, persistence, resume, cancellation and approval flow are
shared by native commands. Terminal-only commands absent from the native SDK catalog
are not synthesized. Agent command effects and configuration scope remain native;
Latte's explicit model/effort selections continue to apply on each launched turn.

The `@` picker reuses the server's bounded, canonical project-file listing for local
and SSH hosts. It attaches relative path references for the Agent to read, not file
uploads or clipboard screenshots. A remote server must be updated for command discovery.
The `+` menu also accepts explicitly chosen files/folders outside the project:
native pickers are local-only, while manual absolute paths are resolved by the
selected execution host through `resolve_reference`. This bounded metadata-only
request returns a canonical absolute reference (or a project-relative path when
contained). It does not read contents, add allowed directories, change Agent
permissions, or relax `files`/`read_file` canonical containment. Remote hosts need
an updated server for this additive request. Late selection results are discarded
after project, host, session or composer state changes.
Focused tests: `npm test`, adapter/runtime unit tests and the final-binary
`agent_commands_discovery_dispatch_resume_and_unsupported_are_native` test. A real
CLI smoke check should separately verify discovery and a non-model native command.

## Remembered Agent selections

The desktop persists explicit model and effort choices per host / Agent in local
storage. New drafts restore those choices across projects and restarts; existing
sessions retain their own parameters. Reading a catalog or falling back from an
unsupported effort is not an explicit preference change. Selecting native defaults
persists null; missing effort leaves both CLI arguments and native effort environment
untouched, including when a Provider is bound. Claude resolves its own settings.
Focused checks: `useAgentPreferences.test.tsx`, `ModelPicker.test.tsx`, and the
final-binary `effort_is_applied_on_launch_resume_and_reset` test.

## Agent permission modes

The composer requests `agent_permissions` from the execution host. Each adapter
owns discovery, labels and launch mapping. Claude probes the installed CLI's
`--help` (5-second / 128 KiB limits, shared probe concurrency limit); only known,
advertised modes are offered. Account, model and managed-policy eligibility is
still enforced by the native Agent; rejection is surfaced, never replaced by a
different mode. Unsupported adapters fail explicitly.

A nullable `permission_mode` travels with each send, is stored with the Session
and participates in durable request identity. Null omits the CLI override.
Explicit choices are remembered per host / Agent; running turns cannot be changed.
Only the native CLI decides which tools require approval. Requests that reach the
host approval flow retain its single-use session-bound checks, even in bypass mode.
Permission changes do not edit native settings or expand sandbox/network policies.
The Hello capability `permission_settings` prevents a new client from sending
an override to an older server that would silently ignore the field. Remote hosts
must update their server; local and SSH transports share the same implementation.

## Clipboard attachments

Composer paste snapshots text/files before awaiting native work. Plain text stays
at the selection; more than 8,000 UTF-16 code units or 200 lines becomes a UTF-8
`.txt` attachment. File URLs from the macOS pasteboard are handled by native code;
a conflicting text snapshot takes precedence over a subsequently changed clipboard.
Images/video/documents are file references, not simulated vision/video processing.

The desktop stages all pasted bytes in the local host's private `paste-tmp/`
directory under its state directory. An SSH task then receives a streamed copy in
that host's own `paste-tmp/`; only the destination path is attached. The native
adapter does not run Agents or change their permissions. macOS file URLs are
revalidated against the current pasteboard before opening. Local pasted directories
are references only; remote directory transfer is explicitly unsupported.

The additive `begin_attachment` / `attachment_chunk` / `finish_attachment` /
`abort_attachment` protocol bounds chunks to 64 KiB, each file to 64 MiB, concurrent
uploads to 8, and each host's managed cache to 2 GiB / 4,096 entries. Offsets and
declared sizes must match. Files become visible only after complete writes and
fsync; private cache directories use 0700 and files 0600. Incomplete in-memory
uploads expire after ten minutes on subsequent admissions; completed files remain
available for saved prompts and retries. They are not automatically deleted on
session close. Remote servers must be updated before using clipboard transfers.

Tests: `pasteAttachments.test.ts`, `Composer.test.tsx`, server attachment unit tests,
and final-binary `pasted_attachments_are_chunked_host_owned_and_abortable`. Report
native clipboard tests and actual remote-host execution separately.

## App-owned Provider configuration

`latte-work-config` owns App Provider definitions and per-host/Agent choices. It has
no runtime Agent or Server dependency. Tauri accesses it on a blocking worker using
a short-lived OS file lock. UI Provider CRUD must use `provider_request`, never
`host_request` or a local Server connection. Only model discovery and execution
contact the selected host. Each desktop send chooses an explicit snapshot or CLI
configuration, including for the local host. See `docs/providers.md` for read-only
legacy migration, paths and confidentiality requirements.

## Read-only change inspection and presentation metadata

`changes` returns bounded, project-relative `GitChange` entries grouped by staged,
unstaged and untracked status. `change_diff` returns one file's bounded content;
tracked files use literal Git pathspecs with external diff and textconv disabled,
and untracked previews use the existing canonical project containment checks.
The legacy `diff` request remains available, with status scoped to the same project
as its patches. New clients explicitly report unsupported requests on older
servers; use a matching remote Server revision for the structured view.

Approval events may include optional `tool_use_id` metadata from the adapter.
It only links presentation to a known tool call. Authorization remains bound to
the existing public approval request ID, session and single-use runtime decision.
Histories without this metadata still display explicit approval outcomes, but do
not guess which parallel tool an old decision belongs to.

## macOS window and application lifetime

The red close button hides the window and preserves its WebView and drafts. Dock
reopening restores and focuses it. A small macOS Objective-C delegate hook routes Cocoa Dock termination through
the event-backed Quit menu because Tao 0.35 does not expose a cancellable
applicationShouldTerminate callback. It adds only that missing method and leaves
Tao window/reopen handling intact; Rust contains no unsafe code.

Dock Quit and Command-Q first stop turns sent
by this App instance, including ambiguous send outcomes, through each host's normal
Cancel protocol. New requests are blocked while quitting. Exit requires observing
a terminal session state after cancellation; a 30-second overall deadline or an
unreachable host keeps the App open and reports the failure for reconnection/retry.
No force-quit fallback silently leaves a running Agent behind. OS force kill/crash
cannot run this cleanup and remains outside this graceful-exit guarantee.

Explicit Quit first emits a native `app-close-requested` transaction. Every mounted
Tab registers `useAppClose`, including hidden tabs: terminal panes await PTY close;
file/change panes pause refresh. Tabs own their cleanup; unmounting or hiding a
window is not a shutdown signal. Failures are named and prevent exit, and an
abort notification resumes tabs that can resume. Native code waits for the matching
transaction acknowledgement (stale acknowledgements cannot approve a later Quit),
blocks new work, and retains ownership tracking for ambiguous terminal creation.
The native fallback closes any remaining App-owned terminals and stops owned Agent
turns before dropping connections. The entire flow has a 30-second deadline.

The local daemon receives the existing instance-bound idle/drain handshake after
cleanup; busy/shared resources veto daemon exit without being killed. Remote daemons
remain alive. No unrelated sessions or terminal IDs are enumerated and killed.
App transport pipes close on exit; connect-local and SSH bridges end on EOF.
Reopening reconciles events without replaying prompts.


## macOS drag-install packaging

- `make package`: build the release server and desktop, ad-hoc sign, then create the DMG.
- `make package-dmg`: package the existing signed release app without rebuilding it.
- Output: `$CARGO_TARGET_DIR/release/bundle/dmg/Latte-Work-<version>-<arch>.dmg`
  and the adjacent `.dmg.sha256`. The default target directory is this checkout's `target/`.
  Version and architecture come from the app bundle and Mach-O binary, not hardcoded release names.

`scripts/package-dmg.sh` provisions a private Python venv in the target directory
using `scripts/dmg-requirements.txt` (pinned versions). macOS, Python 3 with venv/pip,
Command Line Tools and network access on first use are required. It never installs
global Python packages; unchanged dependencies are reused offline.

`scripts/package-dmg.py` owns the 600×400 white installation window, large app and
Applications icons, and center arrow. All staging and alias paths are canonicalized
before creating Finder metadata, avoiding the `/var` versus `/private/var` alias bug.
It validates the background reference, arrow pixels, icon positions, hidden window
chrome, Applications symlink, image checksum and strict bundle signature. It remounts
the compressed image read-only at a different path, checks the layout again, and
compares the desktop/server binary hashes with the source bundle.

The existing output is replaced only after validation succeeds. Temporary mounts
are detached on failure; failed staging directories are retained for diagnosis.
Run packaging serially within a checkout: do not run `make prepare`, debug builds
or another packaging process concurrently, since they share the bundled server.
Native Finder visual acceptance is separate from structural validation: double-click
the resulting DMG and check the arrow and icon layout. Opening its directory in an
existing Finder window can inherit that window's view settings. No Apple notarization
or Developer ID signature is implied.

## Context and usage telemetry

The additive `usage` event is persisted and replayed with normal session events,
shared by local/SSH transports; update the remote server to receive it. Old
histories remain unknown. Presentation filters telemetry before merging streamed
text. The composer exposes one neutral ring with a click/keyboard statistics panel.

Claude assistant input + cache-read + cache-write tokens describe the latest
main-agent request input snapshot, not a live tokenizer or cumulative context.
Per-step output tokens are placeholders and are excluded. Result `modelUsage`
provides contextWindow only for the exact reported model; its cumulative token
counts and subagent totals are never used for context occupancy. Compaction/reset
invalidates the snapshot until a subsequent request. Result usage and API duration
are displayed for the latest submitted turn; sending clears those totals.
Cache hit rate = cache-read / (uncached input + cache-read + cache-write).
Missing capacity/counters remain unknown, including older CLI/provider responses.
Context breakdown, tool duration, TTFT and generation TPS are not fabricated from
wall time. Sources: [SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
and [SDK wire types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py).

The additive `progress` event carries only waiting/thinking/replying phases.
Claude thinking block/delta events map to thinking without storing their text;
phase changes are deduplicated and subagent phase events ignored. See the
[streaming event contract](https://platform.claude.com/docs/en/build-with-claude/streaming).
The UI combines phases with current-turn pending tool IDs, explicit approval,
connection and cancel state. Silence never implies thinking; terminal sessions
remove the status line. Both progress and usage are excluded before text merging.

## Agent Shell environment

At daemon startup, the host Server captures exported variables from the user's
default shell (`SHELL`, falling back to the account shell), using `-ilc` in the
home directory. zsh, bash, sh/dash and fish are supported; each shell follows its
own startup-file rules (Bash login profiles must source `.bashrc` if desired).
The snapshot stays in memory and is reused for Agent discovery, permission probes,
command discovery and execution. It does not mutate the daemon environment or
Claude settings. Local and SSH Servers capture independently on their own hosts.

Shell exports overlay inherited variables; host identity, cwd and `LATTE_WORK_*`
controls remain authoritative. Adapter-specific environment removals/overrides and
the explicit per-turn Provider settings apply afterwards. Shell aliases/functions
and project-directory hooks are not imported. New shell configuration is loaded
on Server restart. For service managers or curated environments, set
`LATTE_WORK_AGENT_ENV=inherit` before starting Server to skip shell initialization.

Capture has a 3-second timeout, a 512 KiB output cap and process-group cleanup.
Startup output is discarded using a unique NUL-delimited marker, not logged.
Failure retains the inherited environment and adds a diagnostic to Agent details.
Environment values, including credentials, are never persisted in the snapshot.
