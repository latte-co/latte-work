# Development

Requires Rust 1.97, Node 22+, macOS Command Line Tools. `make ci` also
requires actionlint and ShellCheck (install with your package manager). Host server supports macOS
and Linux; v0.1 desktop is validated on macOS. No Windows runtime claim.

`make setup`, `make dev` starts the native application. `make ci` runs the local
gate; `make package` builds an app without Developer ID signing and standalone release host server.
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
