import { WorkingStatus } from "./WorkingStatus";
import { executionStatus } from "./executionStatus";
import { ApprovalCard } from "./ApprovalCard";
import { ComposerAction } from "./ComposerAction";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageContent } from "./MessageContent";
import { DraftStore, useDraft, type Draft } from "./drafts";
import { ArrowUp, ArrowDown, Bot } from "lucide-react";
import type { AgentInfo, Effort, Event, Session } from "./protocol";
import type { Host } from "./api";
import type { HostedProject } from "./projectCatalog";
import { Composer } from "./Composer";
import { useAgentPreferences } from "./useAgentPreferences";
import { PermissionPicker } from "./PermissionPicker";
import { UsageIndicator } from "./UsageIndicator";
import { ModelPicker } from "./ModelPicker";
import { TaskProjectPicker } from "./TaskProjectPicker";
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
  cancel: () => void | Promise<boolean>;
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
  const [stopping, setStopping] = useState(false);
  const stopGeneration = useRef(0);
  const active = session && ["running", "waiting"].includes(session.status);
  useEffect(() => {
    stopGeneration.current++;
    setStopping(false);
  }, [draftKey, active]);
  const workingStatus = executionStatus(session, events, connected, stopping);
  async function stop() {
    if (stopping) return;
    const generation = ++stopGeneration.current;
    setStopping(true);
    try {
      if ((await cancel()) === false && stopGeneration.current === generation)
        setStopping(false);
    } catch {
      if (stopGeneration.current === generation) setStopping(false);
    }
  }
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
                        <ApprovalCard
                          key={item.key}
                          request={v}
                          resolved={item.resolved}
                          decision={item.decision}
                          tool={item.approvalTool}
                          disabled={!connected || !!approving}
                          busy={approving === v.request_id}
                          onDecision={(allow) =>
                            void decide(v.request_id, allow)
                          }
                        />
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
            {workingStatus && (
              <WorkingStatus
                label={workingStatus}
                animated={
                  connected && (session?.status !== "waiting" || stopping)
                }
              />
            )}
          </div>
        )}
      </div>
      <div className="composer-wrap">
        <div className="composer-context">
          {away && (
            <button
              className="return-latest"
              aria-label={newOutput ? "有新内容 · 回到最新" : "回到最新"}
              title={newOutput ? "有新内容 · 回到最新" : "回到最新"}
              onClick={() => {
                follow.current = true;
                setAway(false);
                setNewOutput(false);
                scroller.current?.scrollTo({
                  top: scroller.current.scrollHeight,
                });
              }}
            >
              <ArrowDown size={15} />
              <span>{newOutput ? "有新内容 · 回到最新" : "回到最新"}</span>
            </button>
          )}

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
              <UsageIndicator
                key={draftKey}
                events={events}
                sessionId={session?.id}
                hidden={settingsOpen}
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
                onClick={active ? stop : submit}
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
