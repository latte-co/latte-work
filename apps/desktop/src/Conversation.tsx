import { ApprovalOperation } from "./ApprovalOperation";
import { ComposerAction } from "./ComposerAction";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageContent } from "./MessageContent";
import { DraftStore, useDraft, type Draft } from "./drafts";
import {
  ArrowUp,
  ArrowDown,
  ShieldCheck,
  LoaderCircle,
  Bot,
} from "lucide-react";
import type { AgentInfo, Effort, Event, Session } from "./protocol";
import type { Host } from "./api";
import type { HostedProject } from "./projectCatalog";
import { Composer } from "./Composer";
import { useAgentPreferences } from "./useAgentPreferences";
import { PermissionPicker } from "./PermissionPicker";
import { ModelPicker } from "./ModelPicker";
import { TaskProjectPicker } from "./TaskProjectPicker";
import { toolLabel } from "./activity";
import { TurnTranscript } from "./TurnTranscript";
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
  drafts: DraftStore;
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
  drafts,
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
  const draftKey = session ? JSON.stringify([hostId, session.id]) : "new-task";
  const draft = useDraft(drafts, draftKey);
  const text = draft.text;
  const setText = (text: string) => drafts.update(draftKey, { text });
  const root = useRef<HTMLElement>(null);
  const [sending, setSending] = useState(false);
  const previousDraftKey = useRef(draftKey);
  const migrated = useRef<string | null>(null);
  const submission = useRef<{
    key: string;
    draft: Draft;
    accepted?: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (
      submission.current?.key === "new-task" &&
      previousDraftKey.current === "new-task" &&
      draftKey !== "new-task"
    ) {
      const submitted = submission.current;
      drafts.adopt(draftKey, submitted.draft);
      migrated.current = draftKey;
      if (submitted.accepted !== undefined) {
        if (submitted.accepted) drafts.clear(draftKey, submitted.draft);
        drafts.clear(submitted.key, submitted.draft);
      }
    }
    previousDraftKey.current = draftKey;
  }, [draftKey, sending, drafts]);
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
  const [away, setAway] = useState(false);
  const [newOutput, setNewOutput] = useState(false);
  const active = session && ["running", "waiting"].includes(session.status);
  useEffect(() => {
    if (follow.current)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    else setNewOutput(true);
  }, [events]);
  useEffect(() => {
    follow.current = true;
    setAway(false);
    setNewOutput(false);
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
    migrated.current = null;
    const submitted = {
      key: draftKey,
      draft,
      accepted: undefined as boolean | undefined,
    };
    submission.current = submitted;
    setSending(true);
    try {
      submitted.accepted = await send(prompt, model, effort, permissionMode);
      if (submitted.accepted) {
        drafts.clear(draftKey, draft);
        if (migrated.current) drafts.clear(migrated.current, draft);
        follow.current = true;
        return true;
      }
      return false;
    } finally {
      submitted.accepted ??= false;
      if (migrated.current) drafts.clear(draftKey, draft);
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
    <section className="conversation" ref={root}>
      <div
        className={`conversation-scroll${events.length === 0 ? " empty" : ""}`}
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          setAway(!follow.current);
          if (follow.current) setNewOutput(false);
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
            {!text.trim() && (
              <div className="suggestions">
                {["梳理项目结构", "帮我实现一个功能", "检查最近的改动"].map(
                  (s) => (
                    <button
                      key={s}
                      disabled={!projectName || !!session?.archived}
                      onClick={() => {
                        setText(s);
                        root.current?.querySelector("textarea")?.focus();
                      }}
                    >
                      {s}
                      <ArrowUp size={14} />
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="messages">
            <TurnTranscript events={events}>
              {(item) =>
                item.type === "user" ? (
                  <div className="user-message" key={item.key}>
                    {item.text}
                  </div>
                ) : item.type === "assistant" ? (
                  <article
                    className="assistant-message markdown"
                    key={item.key}
                  >
                    <MessageContent text={item.text} />
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
                        <div
                          className="approval-card"
                          data-resolved={!!item.resolved}
                          key={item.key}
                        >
                          <div>
                            <ShieldCheck size={17} />
                            <strong>
                              {item.resolved
                                ? item.decision === "allowed"
                                  ? "已允许此次操作"
                                  : item.decision === "denied"
                                    ? "已拒绝此次操作"
                                    : "审批已过期"
                                : "需要你的确认"}
                            </strong>
                            <span>{v.tool}</span>
                          </div>
                          <p className="approval-summary">
                            {toolLabel({
                              key: item.key,
                              type: "tool",
                              name: v.tool,
                              input: v.input,
                              status: "waiting",
                            })}
                          </p>
                          {!item.resolved && (
                            <ApprovalOperation input={v.input} />
                          )}
                          <details>
                            <summary>查看操作参数</summary>
                            <pre>{JSON.stringify(v.input, null, 2)}</pre>
                          </details>
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
                )
              }
            </TurnTranscript>
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
      {away && (
        <button
          className="return-latest"
          onClick={() => {
            follow.current = true;
            setAway(false);
            setNewOutput(false);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
          }}
        >
          <ArrowDown size={15} />
          {newOutput ? "有新内容 · 回到最新" : "回到最新"}
        </button>
      )}
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
          referenceState={draft.references}
          onReferencesChange={(references) =>
            drafts.update(draftKey, { references })
          }
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
              <ComposerAction
                active={!!active}
                sending={sending}
                disabled={
                  active
                    ? !connected
                    : !!session?.archived ||
                      !hasContent ||
                      !projectName ||
                      !connected ||
                      !available ||
                      sending
                }
                onClick={active ? cancel : submit}
              />
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
