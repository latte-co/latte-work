import { ProjectDialog } from "./ProjectDialog";
import { X, Server, ArrowRight } from "lucide-react";
import type { Workbench } from "./useWorkbench";
export function HostDialogs({ state }: { state: Workbench }) {
  const {
    modal,
    busy,
    setModal,
    error,
    addHost,
    ssh,
    setSsh,
    serverPath,
    setServerPath,
  } = state;
  if (modal === "project") return <ProjectDialog state={state} />;
  return (
    modal === "host" && (
      <div
        className="modal-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !busy) setModal(null);
        }}
      >
        <section
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="连接 SSH 主机"
        >
          <button
            className="modal-close icon-button"
            disabled={busy}
            aria-label="关闭"
            onClick={() => setModal("project")}
          >
            <X size={18} />
          </button>
          <div className="modal-icon">
            <Server size={23} />
          </div>
          <h2>连接 SSH 主机</h2>
          <form onSubmit={(e) => void addHost(e)}>
            <p>使用现有 SSH 配置，连接远程主机上的 Latte Work Server。</p>
            <label>
              SSH Host
              <input
                autoFocus
                required
                placeholder="devbox 或 user@hostname"
                value={ssh}
                onChange={(e) => setSsh(e.target.value)}
              />
            </label>
            <label>
              远程 Server 的绝对路径
              <input
                required
                placeholder="/home/user/.local/bin/latte-work-server"
                value={serverPath}
                onChange={(e) => setServerPath(e.target.value)}
              />
            </label>
            <p className="form-note">
              先在远程安装对应平台的 Server，并在终端完成 SSH 首次连接。Server
              会按需启动，同一 Host 的所有项目共用一个实例。
            </p>
            {error && <div className="form-error">{error}</div>}
            <button className="primary wide" disabled={busy}>
              {busy ? "正在验证连接…" : "连接主机"}
              <ArrowRight size={16} />
            </button>
          </form>
        </section>
      </div>
    )
  );
}
