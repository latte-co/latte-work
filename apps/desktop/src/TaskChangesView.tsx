import { useCallback, useEffect, useState } from "react";
import { message, request } from "./api";
import type {
  ChangeSummary,
  GitReviewFile,
  Project,
  TurnChanges,
} from "./protocol";
import { ChangesView } from "./ChangesView";
import { ReviewWorkspace } from "./ReviewWorkspace";
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
  const context = JSON.stringify([hostId, project.id, sessionId, requestId]);
  const [loaded, setLoaded] = useState<{
    context: string;
    revision: number;
    summary: ChangeSummary;
    turn?: TurnChanges;
  }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, refresh] = useState(0);
  const snapshot =
    loaded?.context === context && loaded.revision === revision
      ? loaded
      : undefined;
  useStatusIssues([
    {
      id: `turn-changes:${context}`,
      title: "本轮变更未能读取",
      error: active ? error : "",
      pending: active && loading,
      action: { label: "重试", run: () => refresh((v) => v + 1) },
    },
  ]);
  useEffect(() => {
    if (!active || workspace || !sessionId) return;
    let disposed = false;
    setLoading(true);
    setError("");
    void request(
      hostId,
      requestId
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
        if (response.kind === "turn_changes")
          setLoaded({
            context,
            revision,
            summary: response.changes.summary,
            turn: response.changes,
          });
        else if (response.kind === "change_summary")
          setLoaded({ context, revision, summary: response.summary });
        else throw new Error("Server 不支持任务变更，请更新后重试");
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
    hostId,
    project.id,
    sessionId,
    requestId,
    revision,
    context,
  ]);
  const loadDiff = useCallback(
    async (path: string) => {
      const response = await request(
        hostId,
        requestId
          ? {
              method: "turn_change_diff",
              session_id: sessionId!,
              request_id: requestId,
              path,
            }
          : { method: "task_change_diff", session_id: sessionId!, path },
      );
      if (response.kind !== "content") throw new Error("无法读取文件差异");
      return response;
    },
    [hostId, sessionId, requestId, revision],
  );
  const summary = snapshot?.summary,
    turn = snapshot?.turn;
  const entries: GitReviewFile[] =
    summary?.entries.map((entry) => ({
      ...entry,
      previous_path: null,
      binary: false,
      untracked: false,
    })) ?? [];
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
        <ReviewWorkspace
          key={context}
          scopeControl={
            <span className="review-snapshot-scope">
              {requestId ? "本轮变更" : "任务变更"}
            </span>
          }
          files={entries}
          added={summary?.added ?? 0}
          removed={summary?.removed ?? 0}
          active={active}
          initialPath={initialPath}
          loading={loading || (!snapshot && !error)}
          unavailable={error || summary?.unavailable || undefined}
          emptyLabel={
            summary?.truncated
              ? "采集范围内没有已记录的文件变更"
              : `${requestId ? "本轮" : "本任务"}没有文件变更`
          }
          loadDiff={loadDiff}
          refresh={() => refresh((v) => v + 1)}
          notices={
            <>
              {turn && (
                <>
                  {turn.undo === "reverted" ? (
                    <p className="panel-notice">
                      本轮修改已撤销，以下仍显示原始变更快照。
                    </p>
                  ) : turn.undo === "unknown" ? (
                    <p className="panel-notice">
                      撤销状态待核对，以下显示原始变更快照。
                    </p>
                  ) : null}
                  {turn.background_pending ? (
                    <p className="panel-notice">
                      采集快照时后台任务尚未结束，此处保留当时已记录的修改。
                    </p>
                  ) : turn.interrupted ? (
                    <p className="panel-notice">
                      本轮已中断，快照保留中断时已记录的修改。
                    </p>
                  ) : null}
                </>
              )}
              {summary?.truncated && (
                <p className="panel-notice">部分文件或内容超出快照采集范围。</p>
              )}
            </>
          }
          boundary={
            requestId
              ? "对比本轮开始与结束时保存的内容；后续修改不会改变快照。共享目录中的同期写入也可能包含在内。"
              : "任务开始后的净变更；共享目录内可能包含其他写入。"
          }
        />
      )}
    </>
  );
}
