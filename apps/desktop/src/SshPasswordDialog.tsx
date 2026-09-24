import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { message, type Host } from "./api";

export function SshPasswordDialog({
  host,
  submit,
  cancel,
}: {
  host: Host;
  submit: (password: string) => Promise<void>;
  cancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, cancel]);
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      await submit(password);
      setPassword("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop ssh-password-backdrop">
      <section
        className="modal ssh-password-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`连接 ${host.name}`}
      >
        <button
          className="modal-close icon-button"
          aria-label="稍后连接"
          disabled={busy}
          onClick={cancel}
        >
          <X size={18} />
        </button>
        <h2>连接 {host.name}</h2>
        <p>请输入 SSH 密码以连接 {host.ssh}。本次运行期间重连无需再次输入。</p>
        <form onSubmit={(event) => void connect(event)}>
          <label>
            SSH 密码
            <input
              autoFocus
              required
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <p className="form-note">密码仅保留在应用内存中，关闭应用后清除。</p>
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
              onClick={cancel}
            >
              稍后
            </button>
            <button className="primary" disabled={busy || !password}>
              {busy ? "正在连接…" : "连接"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
