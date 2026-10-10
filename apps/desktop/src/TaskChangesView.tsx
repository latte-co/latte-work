import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { message, request } from "./api";
import type { ChangeSummary, Project, TaskChange } from "./protocol";
import { ChangesView } from "./ChangesView";
import { CodeView } from "./CodeView";
import { useStatusIssues } from "./statusNotices";
export function TaskChangesView({
  hostId,
  project,
  sessionId,
  requestId,
  initialPath,
  active,
}: {
  hostId: string;
  project: Project;
  sessionId?: string;
  requestId?: string;
  initialPath?: string;
  active: boolean;
}) {
  const [workspace, setWorkspace] = useState(!sessionId);
  const [summary, setSummary] = useState<ChangeSummary>();
  const [selected, select] = useState<TaskChange>();
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [partial, setPartial] = useState(false);
  const [revision, refresh] = useState(0);
  useStatusIssues([
    {
      id: `turn-changes:${hostId}:${sessionId}:${requestId}`,
      title: "本轮变更未能读取",
      error: active ? error : "",
      pending: active && loading,
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
  ]);
  const [turnNote, setTurnNote] = useState("");
  useEffect(() => {
    select(
      initialPath
        ? { path: initialPath, status: "M", added: null, removed: null }
        : undefined,
    );
  }, [initialPath, requestId, sessionId, hostId]);
  useEffect(() => {
    if (!active || workspace || !sessionId) return;
    let disposed = false;
    setLoading(true);
    setError("");
    setContent("");
    void request(
      hostId,
      selected
        ? requestId
          ? {
              method: "turn_change_diff",
              session_id: sessionId,
              request_id: requestId,
              path: selected.path,
            }
          : {
              method: "task_change_diff",
              session_id: sessionId,
              path: selected.path,
            }
        : requestId
          ? {
              method: "turn_change_summary",
              session_id: sessionId,
              request_id: requestId,
            }
          : {
              method: "change_summary",
              project_id: project.id,
              session_id: sessionId,
            },
    )
      .then((response) => {
        if (disposed) return;
        if (response.kind === "change_summary") setSummary(response.summary);
        else if (response.kind === "turn_changes") {
          setSummary(response.changes.summary);
          setTurnNote(
            response.changes.undo === "reverted"
              ? "本轮修改已撤销，以下仍显示原始变更快照。"
              : response.changes.undo === "unknown"
                ? "撤销状态待核对，以下显示原始变更快照。"
                : response.changes.background_pending
                  ? "后台任务仍在执行，快照记录主任务结束时的修改。"
                  : response.changes.interrupted
                    ? "本轮已中断，快照保留中断时已记录的修改。"
                    : "",
          );
        } else if (response.kind === "content") {
          setContent(response.text);
          setPartial(response.truncated);
        } else throw new Error("Server 不支持任务变更，请更新后重试");
      })
      .catch((cause) => {
        if (!disposed) setError(message(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    active,
    workspace,
    sessionId,
    hostId,
    project.id,
    requestId,
    selected,
    revision,
  ]);
  return (
    <>
      {!requestId && (
        <div className="change-scope-switch" role="group" aria-label="变更范围">
          <button
            aria-pressed={!workspace}
            disabled={!sessionId}
            onClick={() => setWorkspace(false)}
          >
            本任务
          </button>
          <button aria-pressed={workspace} onClick={() => setWorkspace(true)}>
            工作区
          </button>
        </div>
      )}
      {workspace ? (
        <ChangesView hostId={hostId} project={project} active={active} />
      ) : (
        <>
          <div className="workspace-file-heading">
            <span>
              {requestId ? "本轮变更" : "任务变更"}{" "}
              {summary && !summary.unavailable && (
                <span className="change-totals">
                  <b>+{summary.added}</b>
                  <em>-{summary.removed}</em>
                </span>
              )}
            </span>
            <button
              className="icon-button"
              title="刷新任务变更"
              aria-label="刷新任务变更"
              disabled={loading}
              onClick={() => refresh((v) => v + 1)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <p
            className="task-change-boundary"
            title={
              requestId
                ? "对比本轮请求前与结束时保存的文件内容。共享目录中的同期写入也可能包含在内。"
                : "对比首次请求前的文件基线。共享目录中的其他同期写入也可能包含在内。"
            }
          >
            {requestId
              ? "本轮开始到结束的变更快照"
              : "任务开始后的净变更 · 共享目录内可能包含其他写入"}
          </p>
          {turnNote && <p className="muted">{turnNote}</p>}
          {selected && (
            <button
              className="task-change-back"
              onClick={() => select(undefined)}
            >
              <ArrowLeft size={14} />
              返回{requestId ? "本轮" : "任务"}变更
            </button>
          )}
          {loading && <p className="muted">正在读取变更…</p>}
          {!selected && !loading && summary?.unavailable && (
            <p className="muted">{summary.unavailable}</p>
          )}
          {!selected &&
            !loading &&
            !summary?.unavailable &&
            !summary?.entries.length &&
            !error && (
              <p className="muted">
                {requestId ? "本轮" : "本任务"}尚无可确认的文件变更
              </p>
            )}
          {!selected &&
            summary?.entries.map((entry) => (
              <button
                className="task-source-row"
                key={entry.path}
                onClick={() => select(entry)}
              >
                <span>
                  {entry.status} · {entry.path}
                </span>
                <span className="change-totals">
                  {entry.added === null ? (
                    "二进制"
                  ) : (
                    <>
                      <b>+{entry.added}</b>
                      <em>-{entry.removed}</em>
                    </>
                  )}
                </span>
              </button>
            ))}
          {selected && content && <CodeView content={content} diff />}
          {(summary?.truncated || (selected && partial)) && (
            <p className="muted">
              仅显示已采集范围，部分文件或内容超出统计上限。
            </p>
          )}
        </>
      )}
    </>
  );
}
