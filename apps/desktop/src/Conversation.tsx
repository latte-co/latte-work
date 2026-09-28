import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Square, ShieldCheck, LoaderCircle, Bot } from "lucide-react";
import type { AgentInfo, Effort, Event, Session } from "./protocol";
import type { Host } from "./api";
import type { HostedProject } from "./projectCatalog";
import { Composer } from "./Composer";
import { useAgentPreferences } from "./useAgentPreferences";
import { PermissionPicker } from "./PermissionPicker";
import { ModelPicker } from "./ModelPicker";
import { TaskProjectPicker } from "./TaskProjectPicker";
import { activityTranscript } from "./activity";
import { ToolGroup, ToolRow } from "./ToolActivity";
export const statusNames = {
  ready: "就绪",
  running: "执行中",
  waiting: "等待审批",
  completed: "已完成",
  failed: "执行失败",
  stopped: "已停止",
  unknown: "状态待确认",
};
interface Props {
  agent?: AgentInfo;
  session?: Session;
  hostId: string;
  settingsOpen: boolean;
  events: Event[];
  connected: boolean;
  available: boolean;
  projectName?: string;
  projectId?: string;
  project?: HostedProject;
  projects: HostedProject[];
  hosts: Host[];
  selectTaskProject: (project: HostedProject) => void;
  openProject: () => void;
  send: (
    text: string,
    model: string | null,
    effort: Effort | null,
    permissionMode: string | null,
  ) => Promise<boolean>;
  cancel: () => void;
  approve: (id: string, allow: boolean) => Promise<void>;
}
export function Conversation({
  agent,
  session,
  hostId,
  settingsOpen,
  events,
  connected,
  available,
  projectName,
  projectId,
  project,
  projects,
  hosts,
  selectTaskProject,
  openProject,
  send,
  cancel,
  approve,
}: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const agentId = session?.agent ?? agent?.id ?? "claude";
  const agentName =
    agent?.id === agentId
      ? agent.name
      : agentId === "claude"
        ? "Claude Code"
        : agentId;
  const preferences = useAgentPreferences(
    hostId,
    agentId,
    projectId,
    session,
    sending,
  );
  const { model, effort, permissionMode } = preferences;
  const [approving, setApproving] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const active = session && ["running", "waiting"].includes(session.status);
  useEffect(() => {
    if (follow.current)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events]);
  useEffect(() => {
    if (!sending) setText("");
    follow.current = true;
  }, [session?.id]);
  async function submit(prompt: string): Promise<boolean> {
    if (
      !prompt.trim() ||
      sending ||
      active ||
      !connected ||
      !available ||
      session?.archived
    )
      return false;
    setSending(true);
    try {
      if (await send(prompt, model, effort, permissionMode)) {
        setText("");
        follow.current = true;
        return true;
      }
      return false;
    } finally {
      setSending(false);
    }
  }
  async function decide(id: string, allow: boolean) {
    setApproving(id);
    try {
      await approve(id, allow);
    } finally {
      setApproving(null);
    }
  }
  return (
    <section className="conversation">
      <div
        className={`conversation-scroll${events.length === 0 ? " empty" : ""}`}
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {events.length === 0 ? (
          <div className="welcome">
            <h1>{projectName ? "从一个想法开始" : "开始一项新任务"}</h1>
            <p>
              {projectName
                ? `在 ${projectName} 中与 Claude Code 一起工作。`
                : "选择本地或远程项目，与 Claude Code 一起工作。"}
            </p>
            <div className="suggestions">
              {["梳理项目结构", "帮我实现一个功能", "检查最近的改动"].map(
                (s) => (
                  <button
                    key={s}
                    disabled={!projectName || !!session?.archived}
                    onClick={() => setText(s)}
                  >
                    {s}
                    <ArrowUp size={14} />
                  </button>
                ),
              )}
            </div>
          </div>
        ) : (
          <div className="messages">
            {activityTranscript(events).map((item) =>
              item.type === "user" ? (
                <div className="user-message" key={item.key}>
                  {item.text}
                </div>
              ) : item.type === "assistant" ? (
                <article className="assistant-message markdown" key={item.key}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.text}
                  </ReactMarkdown>
                </article>
              ) : item.type === "tool" ? (
                <ToolRow key={item.key} tool={item} />
              ) : item.type === "tools" ? (
                <ToolGroup key={item.key} tools={item.tools} />
              ) : (
                (() => {
                  const v = item.value;
                  if (v.kind === "approval")
                    return (
                      <div className="approval-card" key={item.key}>
                        <div>
                          <ShieldCheck size={17} />
                          <strong>
                            {item.resolved
                              ? "审批已处理或过期"
                              : "需要你的确认"}
                          </strong>
                          <span>{v.tool}</span>
                        </div>
                        <pre>{JSON.stringify(v.input, null, 2)}</pre>
                        {!item.resolved && (
                          <footer>
                            <button
                              disabled={!connected || !!approving}
                              onClick={() => void decide(v.request_id, false)}
                            >
                              拒绝
                            </button>
                            <button
                              className="primary"
                              disabled={!connected || !!approving}
                              onClick={() => void decide(v.request_id, true)}
                            >
                              {approving === v.request_id
                                ? "处理中…"
                                : "允许此次操作"}
                            </button>
                          </footer>
                        )}
                      </div>
                    );
                  if (v.kind === "state" && v.message)
                    return (
                      <div
                        className={`notice ${v.status === "failed" ? "failure" : ""}`}
                        key={item.key}
                      >
                        {v.message}
                      </div>
                    );
                  if (v.kind === "notice")
                    return (
                      <div className="notice" key={item.key}>
                        {v.text}
                      </div>
                    );
                  return null;
                })()
              ),
            )}
            {active && (
              <div className="working">
                <LoaderCircle size={14} className="spin" />
                {session.status === "waiting"
                  ? "等待你确认操作"
                  : "Claude 正在处理任务…"}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="composer-wrap">
        <div className="composer-context">
          {!session && (
            <TaskProjectPicker
              project={project}
              projects={projects}
              hosts={hosts}
              disabled={sending}
              onSelect={selectTaskProject}
              onAddProject={openProject}
            />
          )}
          <span className="agent-badge" title={agentName}>
            {agentId === "claude" ? (
              <span className="claude-mark" aria-hidden="true">
                ✳
              </span>
            ) : (
              <Bot size={15} aria-hidden="true" />
            )}
            <span>{agentName}</span>
          </span>
        </div>
        <Composer
          agent={agentId}
          hostId={hostId}
          projectId={projectId}
          sessionId={session?.id}
          connected={connected}
          hidden={settingsOpen}
          disabled={!projectName || !!session?.archived}
          sending={sending}
          value={text}
          onChange={setText}
          onSubmit={submit}
          placeholder={
            session?.archived
              ? "会话已归档，请通过右键菜单取消归档后继续"
              : projectName
                ? "描述任务，@ 添加引用，/ 调用 Agent 命令…"
                : "先添加或选择一个项目"
          }
          toolbar={(submit, hasContent) => (
            <>
              <PermissionPicker
                key={JSON.stringify([hostId, agentId])}
                hostId={hostId}
                agent={agentId}
                connected={connected}
                hidden={settingsOpen}
                value={permissionMode}
                onChange={preferences.choosePermissionMode}
                disabled={
                  !!active || sending || !projectName || !!session?.archived
                }
              />
              <ModelPicker
                hostId={hostId}
                projectId={projectId}
                agent={agentId}
                connected={connected}
                settingsOpen={settingsOpen}
                value={model}
                onChange={preferences.chooseModel}
                effort={effort}
                onEffortChange={preferences.chooseEffort}
                onEffortInvalid={preferences.clearUnsupportedEffort}
                disabled={
                  !!active || sending || !projectName || !!session?.archived
                }
              />
              {active ? (
                <button
                  className="send stop"
                  aria-label="停止任务"
                  disabled={!connected}
                  onClick={cancel}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send"
                  aria-label="发送任务"
                  disabled={
                    session?.archived ||
                    !hasContent ||
                    !projectName ||
                    !connected ||
                    !available ||
                    sending
                  }
                  onClick={submit}
                >
                  {sending ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              )}
            </>
          )}
        />
        {preferences.error && (
          <p className="composer-notice" role="status">
            {preferences.error}
          </p>
        )}
      </div>
    </section>
  );
}
