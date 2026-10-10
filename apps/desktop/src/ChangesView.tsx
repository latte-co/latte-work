import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Columns2,
  MoreHorizontal,
  FileDiff,
  PanelRight,
  RefreshCw,
  Search,
  WrapText,
} from "lucide-react";
import type {
  GitInfo,
  GitReview,
  GitReviewFile,
  GitReviewScope,
  Project,
  TurnChanges,
} from "./protocol";
import { request, message } from "./api";
import { ReviewOptions } from "./ReviewOptions";
import { ReviewDiff } from "./ReviewDiff";
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
const statuses: Record<string, string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  R: "重命名",
  C: "复制",
  U: "冲突",
  T: "类型变化",
};
function Stats({ file }: { file: GitReviewFile }) {
  return file.binary ? (
    <small>二进制</small>
  ) : file.added === null ? (
    <small>未统计</small>
  ) : (
    <span className="change-totals">
      <b>+{file.added}</b>
      <em>-{file.removed}</em>
    </span>
  );
}
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
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [diffError, setDiffError] = useState("");
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [content, setContent] = useState("");
  const [partial, setPartial] = useState(false);
  const [revision, refresh] = useState(0);
  useStatusIssues([
    {
      id: `changes:${hostId}:${project.id}:${scope}`,
      title: `${project.name} 的变更未能读取`,
      error: active ? error : "",
      pending: active && loading,
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
    {
      id: `change-diff:${hostId}:${project.id}:${selected}`,
      title: `${selected} 的差异未能读取`,
      error: active ? diffError : "",
      pending: active && diffLoading,
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
  ]);
  const [split, setSplit] = useState(false);
  const [filesVisible, setFilesVisible] = useState(true);
  const [fullContext, setFullContext] = useState(false);
  const [wrap, setWrap] = useState(true);
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
    setFilter("");
    setError("");
    setContent("");
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
    setContent("");
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
                  binary: entry.added === null,
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
  useEffect(() => {
    setContent("");
    setDiffError("");
    setPartial(false);
    if (!active || !review || !selected) {
      setDiffLoading(false);
      return;
    }
    let disposed = false;
    setDiffLoading(true);
    void request(
      hostId,
      scope === "lastTurn"
        ? {
            method: "turn_change_diff",
            session_id: snapshot!.sessionId!,
            request_id: turn!.request_id,
            path: selected,
          }
        : {
            method: "git_review_diff",
            project_id: project.id,
            scope,
            base: review.base,
            head: review.head,
            path: selected,
            full_context: fullContext,
          },
    )
      .then((response) => {
        if (response.kind !== "content") throw new Error("无法读取文件差异");
        if (!disposed) {
          setContent(response.text);
          setPartial(response.truncated);
        }
      })
      .catch((cause) => {
        if (!disposed) setDiffError(message(cause));
      })
      .finally(() => {
        if (!disposed) setDiffLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    active,
    hostId,
    project.id,
    scope,
    selected,
    review,
    snapshot,
    fullContext,
  ]);
  const filtered = useMemo(
    () =>
      review?.entries.filter((file) =>
        `${file.path} ${file.previous_path ?? ""}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      ) ?? [],
    [review, filter],
  );
  const file = review?.entries.find((file) => file.path === selected);
  const options = info
    ? [
        ...info.refs.map((ref) => ({ value: ref.full_name, label: ref.name })),
        { value: "HEAD", label: "当前提交" },
      ]
    : [];
  const onScope = (value: string) => {
    setScope(value as ReviewScope);
    setFilter("");
    select("");
  };
  return (
    <div className="git-review">
      <div className="git-review-toolbar">
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
        ) : (
          <span className="git-review-scope-label">
            {scope === "lastTurn"
              ? "上一轮已保存的变更快照"
              : scope === "worktree"
                ? "HEAD → 工作区"
                : scope === "staged"
                  ? "HEAD → 暂存区"
                  : "暂存区 → 工作区"}
          </span>
        )}
        <div className="git-review-actions">
          <button
            ref={moreTrigger}
            className="icon-button"
            title="更多差异选项"
            aria-label="更多差异选项"
            aria-haspopup="menu"
            aria-expanded={more}
            disabled={!file || !active}
            onClick={() => setMore((value) => !value)}
          >
            <MoreHorizontal size={16} />
          </button>
          <button
            className="icon-button"
            title="刷新变更"
            aria-label="刷新变更"
            disabled={!active || loading}
            onClick={() => refresh((v) => v + 1)}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            title="自动换行"
            aria-label="自动换行"
            aria-pressed={wrap}
            onClick={() => setWrap((v) => !v)}
          >
            <WrapText size={16} />
          </button>
          <button
            className="icon-button"
            title="并排差异"
            aria-label="并排差异"
            aria-pressed={split}
            onClick={() => setSplit((v) => !v)}
          >
            <Columns2 size={16} />
          </button>
          <button
            className="icon-button"
            title="文件列表"
            aria-label="文件列表"
            aria-pressed={filesVisible}
            onClick={() => setFilesVisible((v) => !v)}
          >
            <PanelRight size={16} />
          </button>
        </div>
      </div>
      {more && file && active && moreTrigger.current && (
        <ReviewOptions
          trigger={moreTrigger.current}
          fullContext={fullContext}
          frozen={scope === "lastTurn"}
          choose={() => setFullContext((value) => !value)}
          close={closeMore}
        />
      )}
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
                ? "后台任务尚未结束，快照记录主任务结束时的修改。"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        )}
      {review?.truncated && (
        <p className="panel-notice">
          部分文件或统计超出读取上限，仅显示已读取的范围。
        </p>
      )}
      {gitMode && info?.truncated && (
        <p className="panel-notice">分支列表仅显示部分结果。</p>
      )}
      <div className={`git-review-body${filesVisible ? "" : " files-hidden"}`}>
        <div className="git-review-content">
          {loading || (gitMode && !info && !error) ? (
            <p className="panel-empty" role="status">
              正在读取变更…
            </p>
          ) : error ? null : !review?.entries.length ? (
            <p className="panel-empty">
              {error
                ? "无法读取变更"
                : scope === "lastTurn" && !turn
                  ? "当前对话尚无已保存的回合快照"
                  : "此范围没有变更"}
            </p>
          ) : file ? (
            <>
              <div className="git-review-file-heading">
                <FileDiff size={16} />
                <strong
                  title={
                    file.previous_path
                      ? `${file.previous_path} → ${file.path}`
                      : file.path
                  }
                >
                  {file.path}
                </strong>
                <Stats file={file} />
              </div>
              {file.previous_path && (
                <p className="panel-notice">
                  {file.previous_path} → {file.path}
                </p>
              )}
              {diffLoading ? (
                <p className="panel-empty" role="status">
                  正在读取差异…
                </p>
              ) : diffError ? null : content ? (
                <ReviewDiff content={content} split={split} wrap={wrap} />
              ) : (
                <p className="panel-empty">
                  文件内容没有差异，可能仅权限发生变化，或工作区已更新。
                </p>
              )}
              {partial && (
                <p className="panel-notice">差异内容已截断，请缩小比较范围。</p>
              )}
            </>
          ) : null}
        </div>
        {filesVisible && (
          <aside className="git-review-files" aria-label="变更文件">
            <div className="git-review-filter">
              <Search size={14} />
              <input
                aria-label="筛选文件"
                placeholder="筛选文件…"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            {review && (
              <div className="git-review-file-count">
                <span>
                  {filtered.length} / {review.entries.length} 个文件
                </span>
                <span className="change-totals">
                  <b>+{review.added}</b>
                  <em>-{review.removed}</em>
                </span>
              </div>
            )}
            <div className="git-review-file-list">
              {filtered.map((entry) => (
                <button
                  key={entry.path}
                  className={entry.path === selected ? "selected" : ""}
                  aria-pressed={entry.path === selected}
                  title={
                    entry.previous_path
                      ? `${entry.previous_path} → ${entry.path}`
                      : entry.path
                  }
                  onClick={() => select(entry.path)}
                >
                  <span
                    className="git-file-status"
                    aria-label={statuses[entry.status] ?? entry.status}
                  >
                    {entry.status}
                  </span>
                  <span className="git-file-path">{entry.path}</span>
                  <Stats file={entry} />
                </button>
              ))}
              {!loading && !filtered.length && (
                <p className="panel-notice">没有匹配的文件</p>
              )}
            </div>
          </aside>
        )}
      </div>
      {review && (
        <p className="git-review-boundary">
          {scope === "lastTurn"
            ? "对比上一轮开始与结束时保存的内容；后续修改不会改变快照。共享目录中的同期写入也可能包含在内。"
            : scope === "branch"
              ? "对比当前提交与基准分支的共同祖先；未提交的修改在未提交范围查看。"
              : scope === "worktree"
                ? "当前工作区相对 HEAD 的净变更，包含暂存及未跟踪文件。"
                : scope === "staged"
                  ? "暂存区相对 HEAD 的变更。"
                  : "工作区相对暂存区的变更，包含未跟踪文件。"}
        </p>
      )}
    </div>
  );
}
