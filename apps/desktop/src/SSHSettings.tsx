import { useEffect, useState } from "react";
import { FolderOpen, Globe2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { chooseIdentityFile, message, type Host } from "./api";
import type { Workbench } from "./useWorkbench";

type Auth = NonNullable<Host["auth"]>;
type Draft = {
  id: string;
  name: string;
  ssh: string;
  port: string;
  serverPath: string;
  auth: Auth;
  identityFile: string;
  password: string;
};

function draftFor(host?: Host): Draft {
  return {
    id: host?.id ?? crypto.randomUUID(),
    name: host?.name ?? "",
    ssh: host?.ssh ?? "",
    port: host?.port?.toString() ?? "",
    serverPath: host?.server_path ?? "",
    auth: host?.auth ?? "none",
    identityFile: host?.identity_file ?? "",
    password: "",
  };
}

const authOptions: { id: Auth; label: string }[] = [
  { id: "none", label: "无身份验证" },
  { id: "identity_file", label: "身份文件" },
  { id: "password", label: "密码" },
];

export function SSHSettings({
  state,
  onBusy,
}: {
  state: Workbench;
  onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [workingHost, setWorkingHost] = useState("");
  const [error, setError] = useState("");
  const hosts = state.hosts.filter((host) => host.ssh);
  useEffect(() => {
    if (!draft) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !busy &&
        !document.querySelector(".ssh-password-modal")
      ) {
        event.stopImmediatePropagation();
        setDraft(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [draft, busy]);
  function update(patch: Partial<Draft>) {
    setDraft((value) => value && { ...value, ...patch });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    setError("");
    const port = draft.port.trim() ? Number(draft.port.trim()) : null;
    if (
      port !== null &&
      (!Number.isInteger(port) || port < 1 || port > 65535)
    ) {
      setError("SSH 端口必须是 1–65535");
      return;
    }
    const existing = hosts.find((host) => host.id === draft.id);
    if (
      draft.auth === "password" &&
      !draft.password &&
      (existing?.auth !== "password" ||
        existing.ssh !== draft.ssh.trim() ||
        (existing.port ?? null) !== port)
    ) {
      setError("请输入本次连接使用的 SSH 密码");
      return;
    }
    const host: Host = {
      id: draft.id,
      name: draft.name.trim(),
      ssh: draft.ssh.trim(),
      port,
      server_path: draft.serverPath.trim(),
      auth: draft.auth,
      identity_file:
        draft.auth === "identity_file" ? draft.identityFile.trim() : null,
    };
    setBusy(true);
    onBusy(true);
    try {
      await state.saveSshHost(
        host,
        draft.auth === "password" ? draft.password : undefined,
      );
      setDraft(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  async function remove(host: Host) {
    if (
      !window.confirm(
        `移除 SSH 连接「${host.name}」？此设备上的项目将从侧边栏隐藏。`,
      )
    )
      return;
    setWorkingHost(host.id);
    onBusy(true);
    setError("");
    try {
      await state.removeSshHost(host.id);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setWorkingHost("");
      onBusy(false);
    }
  }
  async function pickIdentityFile() {
    try {
      const path = await chooseIdentityFile();
      if (path) update({ identityFile: path });
    } catch (cause) {
      setError(message(cause));
    }
  }
  return (
    <div className="settings-panel-content ssh-settings">
      <div className="ssh-settings-heading">
        <div>
          <h2>SSH 连接</h2>
          <p>
            管理远程项目使用的 SSH 主机。远程设备需先安装 Latte Work Server。
          </p>
        </div>
        <button
          className="primary ssh-add"
          onClick={() => {
            setError("");
            setDraft(draftFor());
          }}
        >
          <Plus size={16} /> 添加
        </button>
      </div>
      {hosts.length ? (
        <div className="ssh-host-list">
          {hosts.map((host) => {
            const status = state.hostErrors[host.id];
            const checked = Object.hasOwn(state.hostErrors, host.id);
            return (
              <div className="ssh-host-row" key={host.id}>
                <Globe2 size={18} aria-hidden="true" />
                <div className="ssh-host-main">
                  <strong>{host.name}</strong>
                  <small title={host.ssh ?? ""}>
                    {host.ssh}
                    {host.port ? `:${host.port}` : ""} ·{" "}
                    {
                      authOptions.find(
                        (option) => option.id === (host.auth ?? "none"),
                      )?.label
                    }
                  </small>
                  <span
                    className={
                      status ? "ssh-status ssh-status-error" : "ssh-status"
                    }
                  >
                    {workingHost === host.id
                      ? "正在处理…"
                      : status
                        ? `连接失败：${status}`
                        : checked
                          ? "已连接"
                          : "等待连接"}
                  </span>
                </div>
                <div className="ssh-host-actions">
                  <button
                    className="secondary"
                    disabled={!!workingHost || busy}
                    onClick={() => {
                      void state.refreshHost(host);
                    }}
                    title="重新连接"
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    className="secondary"
                    disabled={!!workingHost || busy}
                    onClick={() => {
                      setError("");
                      setDraft(draftFor(host));
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="secondary"
                    disabled={!!workingHost || busy}
                    aria-label={`移除 ${host.name}`}
                    onClick={() => void remove(host)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="ssh-empty">尚未添加 SSH 连接。</p>
      )}
      <p className="form-note">
        无身份验证使用现有 OpenSSH 配置或 SSH
        Agent。首次连接请先在终端确认主机指纹。密码仅在本次应用运行期间保留；重启后连接时会提示重新输入。
      </p>
      {!draft && error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {draft && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setDraft(null);
          }}
        >
          <section
            className="modal ssh-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              hosts.some((host) => host.id === draft.id)
                ? "编辑 SSH 连接"
                : "添加 SSH 连接"
            }
          >
            <button
              className="modal-close icon-button"
              disabled={busy}
              aria-label="关闭"
              onClick={() => setDraft(null)}
            >
              <X size={18} />
            </button>
            <h2>
              {hosts.some((host) => host.id === draft.id)
                ? "编辑 SSH 连接"
                : "添加 SSH 连接"}
            </h2>
            <form onSubmit={(event) => void save(event)}>
              <label>
                显示名称
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </label>
              <label>
                主机名
                <input
                  required
                  placeholder="host.com 或 user@host.com"
                  value={draft.ssh}
                  onChange={(event) => update({ ssh: event.target.value })}
                />
              </label>
              <label>
                SSH 端口（可选）
                <input
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="22"
                  value={draft.port}
                  onChange={(event) => update({ port: event.target.value })}
                />
              </label>
              <label>
                远程 Server 路径（可选）
                <input
                  placeholder="自动查找远程 Server"
                  value={draft.serverPath}
                  onChange={(event) =>
                    update({ serverPath: event.target.value })
                  }
                />
                <small>
                  留空时自动查找远端 ~/.local/bin/latte-work-server 及 PATH。
                  其他安装位置可填写绝对路径。
                </small>
              </label>
              <div className="ssh-auth-label">身份验证</div>
              <div
                className="ssh-auth-options"
                role="radiogroup"
                aria-label="身份验证方式"
              >
                {authOptions.map((option) => (
                  <label
                    key={option.id}
                    className={draft.auth === option.id ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="ssh-auth"
                      checked={draft.auth === option.id}
                      onChange={() => update({ auth: option.id })}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              {draft.auth === "identity_file" && (
                <label>
                  身份文件
                  <div className="ssh-file-field">
                    <input
                      required
                      placeholder="/Users/name/.ssh/id_ed25519"
                      value={draft.identityFile}
                      onChange={(event) =>
                        update({ identityFile: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void pickIdentityFile()}
                      aria-label="选择身份文件"
                    >
                      <FolderOpen size={17} />
                    </button>
                  </div>
                </label>
              )}
              {draft.auth === "password" && (
                <label>
                  SSH 密码
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      hosts.some(
                        (host) =>
                          host.id === draft.id && host.auth === "password",
                      )
                        ? "留空则使用本次运行已输入的密码"
                        : undefined
                    }
                    value={draft.password}
                    onChange={(event) =>
                      update({ password: event.target.value })
                    }
                  />
                  <small>
                    密码不会写入连接配置。应用重启后连接时会提示重新输入。
                  </small>
                </label>
              )}
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  取消
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? "正在连接…" : "保存并连接"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
