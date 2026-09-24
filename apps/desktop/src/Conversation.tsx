import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Square,
  Sparkles,
  ShieldCheck,
  LoaderCircle,
} from "lucide-react";
import type { Effort, Event, Session } from "./protocol";
import type { Host } from "./api";
import type { HostedProject } from "./projectCatalog";
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
  ) => Promise<boolean>;
  cancel: () => void;
  approve: (id: string, allow: boolean) => Promise<void>;
}
export function Conversation({
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
  const [model, setModel] = useState<string | null>(session?.model ?? null);
  const [effort, setEffort] = useState<Effort | null>(session?.effort ?? null);
  useEffect(
    () => setEffort(session?.effort ?? null),
    [session?.id, session?.effort],
  );
  useEffect(
    () => setModel(session?.model ?? null),
    [session?.id, session?.model],
  );
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const composing = useRef(false);
  const target = useRef(`${hostId}:${projectId}`);
  const active = session && ["running", "waiting"].includes(session.status);
  useEffect(() => {
    const next = `${hostId}:${projectId}`;
    if (target.current !== next) {
      setModel(null);
      setEffort(null);
      target.current = next;
    }
  }, [hostId, projectId]);
  useEffect(() => {
    if (follow.current)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events]);
  useEffect(() => {
    if (!sending) setText("");
    follow.current = true;
  }, [session?.id]);
  async function submit() {
    if (
      !text.trim() ||
      sending ||
      active ||
      !connected ||
      !available ||
      session?.archived
    )
      return;
    setSending(true);
    try {
      if (await send(text.trim(), model, effort)) {
        setModel(model);
        setEffort(effort);
        setText("");
        follow.current = true;
      }
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
        className="conversation-scroll"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {events.length === 0 ? (
          <div className="welcome">
            <div className="welcome-icon">
              <Sparkles size={29} strokeWidth={1.3} />
            </div>
            <div className="eyebrow">A LITTLE SPACE FOR BIG IDEAS</div>
            <h1>{projectName ? "从一个想法开始" : "你的工作，有了新空间"}</h1>
            <p>
              {projectName
                ? `与 Claude Code 一起，在 ${projectName} 中把想法变成现实。`
                : "添加一个本地或远程项目，让 Claude Code 和你一起工作。"}
            </p>
            <div className="suggestions">
              {["梳理项目结构", "帮我实现一个功能", "检查最近的改动"].map(
                (s, i) => (
                  <button
                    key={s}
                    disabled={!projectName || !!session?.archived}
                    onClick={() => setText(s)}
                  >
                    <span>0{i + 1}</span>
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
        <div className={`composer ${!connected ? "disabled" : ""}`}>
          <textarea
            aria-label="任务输入"
            placeholder={
              session?.archived
                ? "会话已归档，请通过右键菜单取消归档后继续"
                : projectName
                  ? "描述任务，或提出一个问题…"
                  : "先添加或选择一个项目"
            }
            value={text}
            disabled={!projectName || !!session?.archived}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                !composing.current
              ) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-toolbar">
            <span className="agent-badge">
              <span className="claude-mark">✳</span>Claude Code
            </span>
            <span className="composer-state">
              {session ? statusNames[session.status] : "新会话"}
            </span>
            <ModelPicker
              hostId={hostId}
              projectId={projectId}
              agent={session?.agent ?? "claude"}
              connected={connected}
              settingsOpen={settingsOpen}
              value={model}
              onChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
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
                  !text.trim() ||
                  !projectName ||
                  !connected ||
                  !available ||
                  sending
                }
                onClick={() => void submit()}
              >
                {sending ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <ArrowUp size={19} />
                )}
              </button>
            )}
          </div>
        </div>
        <div className="composer-caption">
          <span>在项目所在主机执行 · 沿用 Claude CLI 的权限配置</span>
          <span>Enter 发送 · Shift Enter 换行</span>
        </div>
      </div>
    </section>
  );
}
