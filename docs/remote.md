# SSH host setup

The remote host needs OpenSSH, the matching `latte-work-server` executable and an
installed/authenticated Claude Code CLI. No browser runtime, Node frontend,
public service port, or Tauri dependency is needed for the server.

Build on the target OS/architecture from this source checkout (Rust 1.97 and a C
compiler for bundled SQLite):

```sh
cargo build --release -p latte-work-server --locked
install -m 755 target/release/latte-work-server "$HOME/.local/bin/latte-work-server"
```

Create `~/.local/bin` first if needed. Verify `claude --version` and complete
`claude` login on that host. The service checks `LATTE_WORK_CLAUDE`, then
`~/.local/bin/claude`, then PATH. If PATH differs in noninteractive SSH, start the
service with an explicit absolute CLI path:

```sh
LATTE_WORK_CLAUDE=/absolute/path/to/claude \
  ~/.local/bin/latte-work-server serve
```

Normally no manual service start is needed: the Desktop's `connect` bridge
starts it on demand, detached from that SSH connection. To diagnose startup,
run `serve` in a terminal. To stop an existing daemon for an upgrade, send
SIGTERM to its verified PID after stopping/finishing tasks; SIGTERM cancels
remaining tasks and closes the service. Do not delete its runtime database.

First establish the normal SSH connection in your terminal so host keys and
noninteractive key authentication work:

```sh
ssh devbox
ssh -o BatchMode=yes devbox /absolute/path/to/latte-work-server --help
```

In Latte Work, open **添加项目 → 创建项目**. Under **源文件夹**, open the
device menu and select **添加远程**. Enter `devbox` and the remote server's
absolute path. After the handshake, the project form selects that host. Use
**添加** to browse its folders, or enter an absolute path, then create the
project. Local and remote projects share the sidebar; selecting a project
routes files, Git and Claude to its host.

This build uses protocol v7 for session organization (including model selection, Provider configuration and directory browsing). Upgrade
the remote server from the same source before connecting; older daemons fail
the handshake explicitly. Stop an old daemon only after finishing its tasks.

A macOS binary cannot be copied to Linux. V0.1 does not automatically build,
upload or update remote binaries. Password/interactive SSH authentication must
be set up externally. Shared state is per operating-system user, not across
users. The app saves only SSH aliases and binary paths, never passwords.
