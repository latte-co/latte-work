import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, MoreHorizontal } from "lucide-react";
import type {
  GitInfo,
  GitReview,
  GitReviewScope,
  Project,
  TurnChanges,
} from "./protocol";
import { request, message } from "./api";
import { ReviewOptions } from "./ReviewOptions";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { Select } from "./Select";
import { useStatusIssues } from "./statusNotices";
const scopes = [
  { value: "lastTurn", label: "上一轮" },
  { value: "branch", label: "分支" },
  { value: "worktree", label: "未提交" },
  { value: "unstaged", label: "未暂存" },
  { value: "staged", label: "已暂存" },
];
type ReviewScope = GitReviewScope | "lastTurn";
type Snapshot = {
  scope: ReviewScope;
  context: string;
  review: GitReview;
  turn?: TurnChanges;
  sessionId?: string;
};
export function ChangesView({
  hostId,
  project,
  active,
  sessionId,
  lastTurnVersion,
}: {
  hostId: string;
  project: Project;
  active: boolean;
  sessionId?: string;
  lastTurnVersion?: string;
}) {
  const [info, setInfo] = useState<GitInfo>();
  const [scope, setScope] = useState<ReviewScope>("branch");
  const [base, setBase] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const review =
    snapshot?.scope === scope &&
    snapshot.context === JSON.stringify([hostId, project.id]) &&
    (scope !== "lastTurn" || snapshot.sessionId === sessionId)
      ? snapshot.review
      : undefined;
  const turn = scope === "lastTurn" && review ? snapshot?.turn : undefined;
  const [selected, select] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, refresh] = useState(0);
  useStatusIssues([
    {
      id: `changes:${hostId}:${project.id}:${scope}`,
      title: `${project.name} 的变更未能读取`,
      error: active ? error : "",
      pending: active && loading,
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
  ]);
  const [fullContext, setFullContext] = useState(false);
  const [more, setMore] = useState(false);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const closeMore = useCallback((restoreFocus = true) => {
    setMore(false);
    if (restoreFocus) moreTrigger.current?.focus();
  }, []);
  const gitMode = scope !== "lastTurn";
  const turnRevision = gitMode ? 0 : revision;
  const infoContext = useRef("");
  const selection = useRef(selected);
  selection.current = selected;
  useEffect(() => {
    infoContext.current = "";
    setInfo(undefined);
    setBase("");
    setSnapshot(undefined);
    select("");
    setError("");
  }, [hostId, project.id]);
  useEffect(() => {
    if (!active || !gitMode) return;
    setLoading(true);
    setError("");
    let disposed = false;
    void request(hostId, { method: "git_info", project_id: project.id })
      .then((response) => {
        if (response.kind !== "git_info")
          throw new Error("Server 不支持分支审阅，请更新后重试");
        if (!disposed) {
          infoContext.current = JSON.stringify([hostId, project.id]);
          setInfo({ ...response.info });
          setBase(
            (previous) => previous || response.info.default_base || "HEAD",
          );
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setError(message(cause));
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [active, hostId, project.id, revision, gitMode]);
  useEffect(() => {
    if (
      !active ||
      (scope !== "lastTurn" &&
        (!info ||
          infoContext.current !== JSON.stringify([hostId, project.id]) ||
          (scope === "branch" && !base)))
    )
      return;
    let disposed = false;
    setLoading(true);
    setError("");
    setSnapshot(undefined);
    setMore(false);
    if (scope === "lastTurn" && !sessionId) {
      setLoading(false);
      select("");
      return;
    }
    void request(
      hostId,
      scope === "lastTurn"
        ? {
            method: "last_turn_changes",
            session_id: sessionId!,
          }
        : {
            method: "git_review",
            project_id: project.id,
            scope,
            base: scope === "branch" ? base : null,
          },
    )
      .then((response) => {
        if (disposed) return;
        if (
          scope === "lastTurn" &&
          response.kind === "last_turn_changes" &&
          !response.changes
        ) {
          select("");
          return;
        }
        const changes =
          response.kind === "last_turn_changes"
            ? (response.changes ?? undefined)
            : undefined;
        const result: GitReview | undefined =
          scope === "lastTurn"
            ? changes && {
                base: null,
                head: null,
                entries: changes.summary.entries.map((entry) => ({
                  ...entry,
                  previous_path: null,
                  binary: false,
                  untracked: false,
                })),
                added: changes.summary.added,
                removed: changes.summary.removed,
                truncated: changes.summary.truncated,
              }
            : response.kind === "git_review"
              ? response.review
              : undefined;
        if (!result)
          throw new Error(
            scope === "lastTurn"
              ? "Server 不支持回合快照，请更新后重试"
              : "Server 不支持 Git 审阅，请更新后重试",
          );
        if (!disposed) {
          setSnapshot({
            scope,
            context: JSON.stringify([hostId, project.id]),
            review: result,
            turn: changes,
            sessionId,
          });
          setError(changes?.summary.unavailable ?? "");
          select(
            result.entries.some((file) => file.path === selection.current)
              ? selection.current
              : (result.entries[0]?.path ?? ""),
          );
        }
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
    hostId,
    project.id,
    scope,
    base,
    info,
    sessionId,
    lastTurnVersion,
    turnRevision,
  ]);
  const loadDiff = useCallback(
    async (path: string) => {
      const response = await request(
        hostId,
        scope === "lastTurn"
          ? {
              method: "turn_change_diff",
              session_id: snapshot!.sessionId!,
              request_id: turn!.request_id,
              path,
            }
          : {
              method: "git_review_diff",
              project_id: project.id,
              scope,
              base: review!.base,
              head: review!.head,
              path,
              full_context: fullContext,
            },
      );
      if (response.kind !== "content") throw new Error("无法读取文件差异");
      return response;
    },
    [hostId, project.id, scope, snapshot, turn, review, fullContext],
  );
  const options = info
    ? [
        ...info.refs.map((ref) => ({ value: ref.full_name, label: ref.name })),
        { value: "HEAD", label: "当前提交" },
      ]
    : [];
  const onScope = (value: string) => {
    setScope(value as ReviewScope);
    select("");
  };
  const scopeControl = (
    <>
      <Select
        label="变更范围"
        compact
        value={scope}
        options={scopes}
        onChange={onScope}
        disabled={!active}
      />
      {scope === "branch" ? (
        <div className="git-review-comparison">
          <span title={info?.head ?? ""}>
            {info?.branch ?? (info?.head ? "分离 HEAD" : "分支")}
          </span>
          <ArrowRight size={14} />
          <Select
            label="比较基准"
            compact
            value={base}
            options={options}
            onChange={setBase}
            disabled={!active || !info}
            minMenuWidth={200}
            searchable
            searchPlaceholder="搜索分支"
          />
        </div>
      ) : null}
    </>
  );
  return (
    <ReviewWorkspace
      key={JSON.stringify([
        hostId,
        project.id,
        scope,
        scope === "lastTurn" ? sessionId : null,
      ])}
      scopeControl={scopeControl}
      files={review?.entries ?? []}
      added={review?.added ?? 0}
      removed={review?.removed ?? 0}
      active={active}
      initialPath={selected}
      loading={loading || (gitMode && !info && !error)}
      unavailable={error || undefined}
      emptyLabel={
        scope === "lastTurn" && !turn
          ? "当前对话尚无已保存的回合快照"
          : "此范围没有变更"
      }
      loadDiff={loadDiff}
      refresh={() => refresh((v) => v + 1)}
      additionalActions={
        <button
          ref={moreTrigger}
          className="icon-button"
          title="更多差异选项"
          aria-label="更多差异选项"
          aria-haspopup="menu"
          aria-expanded={more}
          disabled={!review?.entries.length || !active}
          onClick={() => setMore((v) => !v)}
        >
          <MoreHorizontal size={16} />
        </button>
      }
      overlay={
        more && active && moreTrigger.current ? (
          <ReviewOptions
            trigger={moreTrigger.current}
            fullContext={fullContext}
            frozen={scope === "lastTurn"}
            choose={() => setFullContext((v) => !v)}
            close={closeMore}
          />
        ) : null
      }
      notices={
        <>
          {turn &&
            (turn.undo === "reverted" ||
              turn.undo === "unknown" ||
              turn.interrupted ||
              turn.background_pending) && (
              <p className="panel-notice">
                {[
                  turn.undo === "reverted"
                    ? "本轮修改已撤销，仍显示原始快照。"
                    : turn.undo === "unknown"
                      ? "撤销状态待核对，仍显示原始快照。"
                      : "",
                  turn.interrupted ? "本轮已中断，保留已记录的修改。" : "",
                  turn.background_pending
                    ? "采集快照时后台任务尚未结束，保留当时已记录的修改。"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              </p>
            )}
          {review?.truncated && (
            <p className="panel-notice">部分文件或统计超出采集范围。</p>
          )}
          {gitMode && info?.truncated && (
            <p className="panel-notice">分支列表仅显示部分结果。</p>
          )}
        </>
      }
      boundary={
        scope === "lastTurn"
          ? "对比上一轮开始与结束时保存的内容；后续修改不会改变快照。共享目录中的同期写入也可能包含在内。"
          : scope === "branch"
            ? "对比当前提交与基准分支的共同祖先；未提交的修改在未提交范围查看。"
            : scope === "worktree"
              ? "当前工作区相对 HEAD 的净变更，包含暂存及未跟踪文件。"
              : scope === "staged"
                ? "暂存区相对 HEAD 的变更。"
                : "工作区相对暂存区的变更，包含未跟踪文件。"
      }
    />
  );
}
