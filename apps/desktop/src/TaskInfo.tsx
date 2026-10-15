import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  Circle,
  CircleDashed,
  GitCompareArrows,
  ListTodo,
  FolderInput,
  Package,
  RefreshCw,
  History,
  Sparkles,
  Wrench,
} from "lucide-react";
import { request, message } from "./api";
import type { Event, GitReview, Project, TaskSource } from "./protocol";
import { WebLink } from "./LinkHandling";
import { TaskFileRow } from "./TaskFileRow";
import { SkillRow } from "./SkillRow";
import { taskInfo } from "./taskInfoModel";
import { SubagentsPanel } from "./SubagentsPanel";
import type { SubagentsState } from "./useSubagents";
import { openSubagent, openWorkspaceResource } from "./workspaceState";
import { useStatusIssues } from "./statusNotices";

function Section({
  title,
  icon,
  children,
  action,
  note,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <section className="task-info-section" aria-label={title}>
      <h2>
        {icon}
        <span>{title}</span>
        {note}
        {action}
      </h2>
      {children}
    </section>
  );
}
const empty = (value: string) => <p className="task-info-empty">{value}</p>;
const todoLabels: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
};

export function TaskInfo({
  workspaceId,
  active,
  hostId,
  project,
  sessionId,
  connected,
  events,
  subagents,
  historyLoading = false,
  hasEarlierHistory = false,
  earlierHistoryLoading = false,
  loadEarlierHistory,
}: {
  workspaceId: string;
  active: boolean;
  hostId: string;
  project?: Project;
  sessionId?: string;
  connected: boolean;
  events: Event[];
  subagents: SubagentsState;
  historyLoading?: boolean;
  hasEarlierHistory?: boolean;
  earlierHistoryLoading?: boolean;
  loadEarlierHistory?: () => Promise<void>;
}) {
  const scope = JSON.stringify([hostId, project?.id, sessionId]);
  const [revision, refresh] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    review?: GitReview;
    sources?: TaskSource[];
    truncated?: boolean;
    changesError?: string;
    sourcesError?: string;
    loading: boolean;
  }>({ scope, loading: true });
  const data = useMemo(
    () => taskInfo(events, sessionId, project?.path),
    [events, sessionId, project?.path],
  );
  const version = events
    .filter(
      (entry) =>
        entry.session_id === sessionId &&
        ["user", "tool", "tool_result", "turn_changes", "state"].includes(
          entry.event.kind,
        ),
    )
    .at(-1)?.seq;
  useEffect(() => {
    if (!active || !connected || !project) return;
    let disposed = false;
    setSnapshot((old) => ({
      ...(old.scope === scope ? old : { scope }),
      loading: true,
    }));
    const timer = setTimeout(() => {
      void Promise.allSettled([
        request(hostId, {
          method: "git_review",
          project_id: project.id,
          scope: "branch",
          base: null,
        }).then((response) => {
          if (response.kind !== "git_review")
            throw new Error("无法读取变更，请检查 Server 版本");
          return response.review;
        }),
        sessionId
          ? request(hostId, { method: "sources", session_id: sessionId }).then(
              (response) => {
                if (response.kind !== "sources")
                  throw new Error("无法读取工具列表，请更新 Server");
                return response;
              },
            )
          : Promise.resolve(undefined),
      ]).then(([changes, sources]) => {
        if (disposed) return;
        setSnapshot({
          scope,
          loading: false,
          review: changes.status === "fulfilled" ? changes.value : undefined,
          changesError:
            changes.status === "rejected" ? message(changes.reason) : "",
          sources:
            sources.status === "fulfilled" ? sources.value?.entries : undefined,
          truncated: sources.status === "fulfilled" && sources.value?.truncated,
          sourcesError:
            sources.status === "rejected" ? message(sources.reason) : "",
        });
      });
    }, 100);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    active,
    connected,
    scope,
    hostId,
    project?.id,
    sessionId,
    version,
    revision,
  ]);
  const current: typeof snapshot =
    snapshot.scope === scope ? snapshot : { scope, loading: true };
  useStatusIssues([
    {
      id: `task-info-changes:${scope}`,
      title: "任务摘要变更暂不可用",
      pending: active && connected && current.loading,
      error: active && connected ? (current.changesError ?? "") : "",
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
    {
      id: `task-info-sources:${scope}`,
      title: "任务工具列表暂不可用",
      pending: active && connected && current.loading,
      error: active && connected ? (current.sourcesError ?? "") : "",
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
  ]);
  const review = current.review;
  const tools = current.sources?.filter(
    (source) => source.kind === "tool" || source.kind === "connector",
  );
  const recordedEmpty = historyLoading ? "正在读取…" : "暂无记录";
  const refreshButton = (
    <button
      className="icon-button"
      aria-label="刷新任务摘要"
      title="刷新任务摘要"
      disabled={!connected || current.loading || !project}
      onClick={() => {
        refresh((value) => value + 1);
        subagents.reload?.();
      }}
    >
      <RefreshCw size={16} />
    </button>
  );
  return (
    <div className="task-info">
      {!connected && empty("主机未连接，信息待更新")}
      <Section
        title="变更概览"
        icon={<GitCompareArrows size={16} />}
        action={refreshButton}
      >
        <button
          className="task-info-row"
          disabled={!project}
          onClick={() => openWorkspaceResource(workspaceId, "diff")}
        >
          <span>分支变更</span>
          <span className="task-info-meta">
            {!connected
              ? "状态待确认"
              : current.changesError
                ? "暂不可用"
                : !review
                  ? project
                    ? "读取中…"
                    : "请先选择项目"
                  : `${review.entries.length} 个文件`}
          </span>
        </button>
        {review && (
          <div className="overview-change-stats">
            <span className="change-totals">
              <b>+{review.added}</b>
              <em>-{review.removed}</em>
            </span>
            <small>{review.truncated ? "部分记录" : "分支"}</small>
          </div>
        )}
      </Section>
      <Section title="子智能体" icon={<Bot size={16} />}>
        {subagents.tasks.length ? (
          <SubagentsPanel
            state={subagents}
            hostId={hostId}
            sessionId={sessionId}
            active={active}
            connected={connected}
            onOpen={(task) => openSubagent(workspaceId, task)}
          />
        ) : (
          empty(
            subagents.loading
              ? "正在读取…"
              : subagents.error
                ? "暂不可用"
                : "暂无记录",
          )
        )}
      </Section>
      <Section title="待办事项" icon={<ListTodo size={16} />}>
        {!data.todos.length && empty(recordedEmpty)}
        <ul className="task-info-list">
          {data.todos.map((todo) => {
            const Icon =
              todo.status === "completed"
                ? Check
                : todo.status === "in_progress"
                  ? CircleDashed
                  : Circle;
            return (
              <li key={todo.id} className="task-info-todo">
                <Icon size={16} />
                <span>{todo.title}</span>
                <small>
                  {todo.status === "in_progress" && !connected
                    ? "状态待确认"
                    : todoLabels[todo.status]}
                </small>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title="调用的 Skill" icon={<Sparkles size={16} />}>
        {!data.skills.length && empty(recordedEmpty)}
        <ul className="task-info-list">
          {data.skills.map(([name, uses]) => (
            <li key={name}>
              <SkillRow
                name={name}
                uses={uses}
                workspaceId={workspaceId}
                hostId={hostId}
                sessionId={sessionId}
                project={project}
                connected={connected}
                active={active}
              />
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title="调用的 Tools"
        icon={<Wrench size={16} />}
        note={
          current.truncated || (!tools && data.tools.length > 0) ? (
            <small title="仅包含已读取的工具调用">部分记录</small>
          ) : undefined
        }
      >
        {tools ? (
          tools.length ? (
            <ul className="task-info-list">
              {tools.map((tool) => (
                <li key={tool.id}>
                  <div className="task-info-row">
                    <span>{tool.name}</span>
                    <small>{tool.uses} 次</small>
                  </div>
                  {tool.kind === "connector" && (
                    <p className="task-info-tool-names">
                      {tool.tools.join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            empty("暂无记录")
          )
        ) : data.tools.length ? (
          <>
            <ul className="task-info-list">
              {data.tools.map(([name, uses]) => (
                <li className="task-info-row" key={name}>
                  <span>{name}</span>
                  <small>{uses} 次</small>
                </li>
              ))}
            </ul>
          </>
        ) : (
          empty(
            current.sourcesError
              ? "暂不可用"
              : sessionId && current.loading
                ? "正在读取…"
                : recordedEmpty,
          )
        )}
      </Section>
      {(
        [
          ["任务产物", data.products, <Package size={16} />],
          ["任务资源", data.resources, <FolderInput size={16} />],
        ] as const
      ).map(([title, entries, icon]) => (
        <Section key={title} title={title} icon={icon}>
          {!entries.length && empty(recordedEmpty)}
          <ul className="task-info-list">
            {entries.map((entry) =>
              entry.kind === "link" ? (
                <li className="task-info-link" key={`link:${entry.url}`}>
                  <WebLink href={entry.url}>{entry.title}</WebLink>
                  {entry.title !== entry.url && <small>{entry.url}</small>}
                </li>
              ) : (
                <li key={`file:${entry.path}`}>
                  <TaskFileRow
                    file={entry}
                    workspaceId={workspaceId}
                    hostId={hostId}
                    project={project}
                    sessionId={sessionId}
                    active={active}
                    connected={connected}
                  />
                </li>
              ),
            )}
          </ul>
        </Section>
      ))}
      {hasEarlierHistory && loadEarlierHistory && (
        <button
          className="task-info-earlier"
          title="当前仅包含已加载的对话记录，点击读取更早记录"
          disabled={!connected || historyLoading || earlierHistoryLoading}
          onClick={() => void loadEarlierHistory()}
        >
          <History size={14} />
          {earlierHistoryLoading ? "正在读取…" : "查看更早记录"}
        </button>
      )}
      {data.truncated && empty("各项最多显示 128 条记录")}
    </div>
  );
}
