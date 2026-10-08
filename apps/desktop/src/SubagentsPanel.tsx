import { useEffect, useState } from "react";
import { Bot, ChevronRight } from "lucide-react";
import { MessageContent } from "./MessageContent";
import { WorkingStatus } from "./WorkingStatus";
import type { Subagent, SubagentStatus } from "./protocol";
import type { SubagentsState } from "./useSubagents";

export const subagentLabels: Record<SubagentStatus, string> = {
  running: "处理中",
  paused: "已暂停",
  completed: "已完成",
  failed: "执行失败",
  stopped: "已停止",
  unknown: "状态待确认",
};
export function subagentCounts(tasks: Subagent[]) {
  return {
    active: tasks.filter(
      (task) => task.status === "running" || task.status === "paused",
    ).length,
    completed: tasks.filter((task) => task.status === "completed").length,
    other: tasks.filter(
      (task) => !["running", "paused", "completed"].includes(task.status),
    ).length,
  };
}
export function SubagentSummary({
  state,
  open,
}: {
  state: SubagentsState;
  open: () => void;
}) {
  if (!state.tasks.length) return null;
  const counts = subagentCounts(state.tasks);
  return (
    <button
      className="subagent-summary"
      onClick={open}
      aria-label="查看子智能体"
    >
      <Bot size={16} />
      <span>子智能体</span>
      <span>{counts.active} 个运行中</span>
      <span>
        {counts.completed} 完成
        {counts.other ? ` · ${counts.other} 项需查看` : ""}
        {state.truncated ? " · 部分记录" : ""}
      </span>
      <ChevronRight size={14} />
    </button>
  );
}
export function SubagentsPanel({
  state,
  onOpen,
  taskId,
}: {
  state: SubagentsState;
  onOpen?: (task: Subagent) => void;
  taskId?: string;
}) {
  const [now, setNow] = useState(Date.now());
  const counts = subagentCounts(state.tasks);
  useEffect(() => {
    if (!counts.active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counts.active]);
  const selected = state.tasks.find((task) => task.id === taskId);
  const age = (task: Subagent) => {
    if (task.started_at === null) return "";
    const end = ["running", "paused"].includes(task.status)
      ? now
      : task.updated_at;
    return `${Math.max(0, Math.floor((end - task.started_at) / 1000))}s`;
  };
  if (selected)
    return (
      <div className="subagents-panel">
        <div className="subagent-detail-heading">
          <Bot size={20} />
          <h2>{selected.title}</h2>
        </div>
        <p className={`subagent-state ${selected.status}`}>
          {subagentLabels[selected.status]}
          {age(selected) && ` · ${age(selected)}`}
        </p>
        {selected.last_tool && (
          <p className="subagent-last-tool">最近工具：{selected.last_tool}</p>
        )}
        {selected.summary ? (
          <article className="markdown subagent-result">
            <MessageContent text={selected.summary} />
          </article>
        ) : (
          <p className="subagent-empty">尚未上报结果</p>
        )}
      </div>
    );
  if (taskId)
    return (
      <div className="subagents-panel">
        <p className="subagent-empty">
          {state.loading
            ? "正在读取子智能体…"
            : state.error || "此子智能体记录暂不可用"}
        </p>
      </div>
    );
  return (
    <div className="subagents-panel">
      {state.error && (
        <p role="alert" className="notice failure">
          {state.error}
        </p>
      )}
      {state.loading && !state.tasks.length && (
        <WorkingStatus label="正在读取子智能体…" animated />
      )}
      {!state.loading && !state.error && !state.tasks.length && (
        <p className="subagent-empty">当前对话尚未启动子智能体</p>
      )}
      {(
        [
          [
            "已开启",
            state.tasks.filter((task) =>
              ["running", "paused"].includes(task.status),
            ),
          ],
          ["完成", state.tasks.filter((task) => task.status === "completed")],
          [
            "其他状态",
            state.tasks.filter(
              (task) =>
                !["running", "paused", "completed"].includes(task.status),
            ),
          ],
        ] as const
      ).map(
        ([label, tasks]) =>
          tasks.length > 0 && (
            <section key={label} aria-label={label}>
              <h2 className="subagent-group-label">
                {label} · {tasks.length}
              </h2>
              {tasks.map((task) => (
                <button
                  key={task.id}
                  className="subagent-row"
                  onClick={() => onOpen?.(task)}
                >
                  <Bot size={22} className={`subagent-state ${task.status}`} />
                  <span className="subagent-row-content">
                    <span className="subagent-title" title={task.title}>
                      {task.title}
                    </span>
                    <span className={`subagent-state ${task.status}`}>
                      {subagentLabels[task.status]}
                      {task.last_tool && ` · ${task.last_tool}`}
                    </span>
                  </span>
                  <span className="subagent-age">{age(task)}</span>
                </button>
              ))}
            </section>
          ),
      )}
      {state.truncated && (
        <p className="subagent-empty">仅显示最近 128 项，运行中任务优先。</p>
      )}
    </div>
  );
}
