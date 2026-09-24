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

First establish the normal SSH connection in your terminal so its host key is
verified:

```sh
ssh devbox
ssh devbox /absolute/path/to/latte-work-server --help
```

In Latte Work, open **设置 → SSH 连接 → 添加**. Enter a display name, SSH host,
and optional port. Leave the Server path empty to find an executable at
`~/.local/bin/latte-work-server` or on the remote noninteractive SSH `PATH`;
enter an absolute path if installed elsewhere. Detection does not install or
upgrade the remote binary. Choose one authentication
mode: **无身份验证** uses existing OpenSSH config/agent, **身份文件** selects a local
private key, and **密码** asks for a password. Save verifies the connection. You
can also reach this page from **创建项目 → 源文件夹 → 添加远程**. Then select the
saved host in the project form. Use **添加** to browse its folders, or enter an
absolute path, then create the project. Local and remote projects share the
sidebar; selecting a project routes files, Git and Claude to its host.

This build uses protocol v9 (including sidebar PTY terminals, model selection and directory browsing). Upgrade
the remote server from the same source before connecting; older daemons fail
the handshake explicitly. Stop an old daemon only after finishing its tasks.

A macOS binary cannot be copied to Linux. V0.1 does not automatically build,
upload or update remote binaries. Shared state is per operating-system user,
not across users. The desktop saves the host, port, authentication mode, identity
file path and optional binary path. Passwords are held only in desktop process memory,
never in `hosts.json` or the macOS Keychain. If a password host needs to
reconnect after an app restart, the desktop prompts for its password once and
reuses it for later reconnects during that run. Canceling the prompt leaves
that host disconnected; use its reconnect action to try again. Host key checking
stays enabled; unknown keys must be verified in a terminal first.

Remote Provider synchronization currently opens a separate SSH connection through
the local host service. It uses only the system OpenSSH configuration, so the
settings page disables synchronization when a host uses an explicit identity
file, password, or port. Project and Agent execution still use the configured
desktop SSH connection.
