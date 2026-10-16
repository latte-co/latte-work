import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { message, request } from "./api";
import type { FileEntry } from "./protocol";
import { usePollingSnapshot } from "./usePollingSnapshot";
import { useStatusIssues } from "./statusNotices";
import { closeReferencePreviews } from "./workspaceState";

export function ReferenceAccess({
  hostId,
  projectId,
  active,
  connected,
}: {
  hostId: string;
  projectId: string;
  active: boolean;
  connected: boolean;
}) {
  const scope = JSON.stringify([hostId, projectId]);
  const [open, setOpen] = useState(false);
  const [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++;
    setBusy(false);
    setError("");
    return () => {
      generation.current++;
    };
  }, [scope, active, connected]);
  const read = useCallback(async () => {
    const response = await request(hostId, {
      method: "reference_access",
      project_id: projectId,
    });
    if (response.kind !== "reference_access")
      throw new Error("无法读取预览权限，请更新 Server");
    return response;
  }, [hostId, projectId]);
  const snapshot = usePollingSnapshot(
    scope,
    active && connected && open,
    read,
    undefined,
    String(revision),
    0,
    0,
  );
  async function revoke(entry: FileEntry) {
    if (busy || !active || !connected) return;
    const version = generation.current;
    setBusy(true);
    setError("");
    try {
      const response = await request(hostId, {
        method: "revoke_reference_access",
        project_id: projectId,
        path: entry.path,
      });
      if (response.kind !== "ok") throw new Error("未能撤销预览权限");
      closeReferencePreviews(hostId, projectId, entry);
      if (generation.current === version) refresh((value) => value + 1);
    } catch (cause) {
      if (generation.current === version) setError(message(cause));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  useStatusIssues([
    {
      id: `reference-access:${scope}`,
      title: "项目外预览权限未能更新",
      error: active && open ? error || snapshot.error : "",
      pending: busy || snapshot.loading,
      action: { label: "刷新", run: () => refresh((value) => value + 1) },
    },
  ]);
  return (
    <details
      className="task-info-access"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ShieldCheck size={14} />
        项目外预览权限
        <ChevronRight size={12} className="task-info-access-chevron" />
      </summary>
      {open && (
        <>
          <div className="task-info-access-note">
            <p>
              本项目保留的只读预览范围，跨对话与重启保留。撤销会关闭相关预览，不影响其他来源授权。
            </p>
            <button
              className="icon-button"
              title="刷新预览权限"
              aria-label="刷新预览权限"
              disabled={!connected || busy || snapshot.loading}
              onClick={() => refresh((value) => value + 1)}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {!connected && <p className="task-info-empty">连接后可更新权限</p>}
          {connected && !snapshot.data && (
            <p className="task-info-empty">
              {snapshot.error ? "暂不可用" : "正在读取…"}
            </p>
          )}
          {snapshot.data && (
            <>
              {!snapshot.data.entries.length && (
                <p className="task-info-empty">暂无保留的预览权限</p>
              )}
              <ul className="task-info-list">
                {snapshot.data.entries.map((entry) => {
                  const Icon = entry.directory ? Folder : FileText;
                  return (
                    <li className="task-info-access-row" key={entry.path}>
                      <Icon size={16} />
                      <span>
                        <span
                          className="task-info-resource-title"
                          title={entry.name}
                        >
                          {entry.name}
                        </span>
                        <small title={entry.path}>
                          {entry.directory ? "目录及其子文件" : "单个文件"} ·{" "}
                          {entry.path}
                        </small>
                      </span>
                      <button
                        className="icon-button"
                        title={`撤销 ${entry.name} 的预览权限`}
                        aria-label={`撤销 ${entry.name} 的预览权限`}
                        disabled={!active || !connected || busy}
                        onClick={() => void revoke(entry)}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              {snapshot.data.truncated && (
                <p className="task-info-empty">
                  当前显示部分记录，撤销后可查看其余权限
                </p>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
