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
