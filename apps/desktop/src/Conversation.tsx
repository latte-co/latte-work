import { TurnChangesCard } from "./TurnChangesCard";
import { SubagentSummary } from "./SubagentsPanel";
import type { SubagentsState } from "./useSubagents";
import { UserMessage } from "./UserMessage";
import { WorkingStatus } from "./WorkingStatus";
import {
  agentSessionLabels,
  type AgentSessionState,
} from "./agentSessionState";
import { modelSelectionScope } from "./modelSelectionScope";
import { executionStatus } from "./executionStatus";
import { hasRepeatedOutput } from "./repeatedOutput";
import { ApprovalCard } from "./ApprovalCard";
import { activityTranscript } from "./activity";
import { ComposerAction } from "./ComposerAction";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageContent } from "./MessageContent";
import { DraftStore, useDraft, type Draft } from "./drafts";
import { ArrowUp, ArrowDown, Bot, TriangleAlert } from "lucide-react";
import type {
  AgentInfo,
  Effort,
  Event,
  Session,
  TurnChanges,
} from "./protocol";
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
  subagents?: SubagentsState;
  openSubagents?: () => void;
  openTurnChanges?: (changes: TurnChanges, path?: string) => void;
  drafts: DraftStore;
  agent?: AgentInfo;
  session?: Session;
  hostId: string;
  settingsOpen: boolean;
  events: Event[];
  historyLoading?: boolean;
  hasEarlierHistory?: boolean;
  earlierHistoryLoading?: boolean;
  loadEarlierHistory?: () => Promise<void>;
  readingScope?: string;
  readingPositions?: Map<string, { top: number; follow: boolean }>;
  onHistoryReady?: () => void;
  connected: boolean;
  connecting?: boolean;
  connectionError?: string;
  connectionLost?: boolean;
  reconnect?: () => void;
  agentSessionState?: AgentSessionState;
  agentSessionError?: string;
  onModelReady?: () => void;
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
    uiAction?: "subagents",
  ) => Promise<boolean>;
  cancel: () => void | Promise<boolean>;
  approve: (id: string, allow: boolean) => Promise<void>;
}
export function Conversation({
  subagents,
  openSubagents,
  openTurnChanges,
  drafts,
  agent,
  session,
  hostId,
  settingsOpen,
  events,
  historyLoading = false,
  hasEarlierHistory = false,
  earlierHistoryLoading = false,
  loadEarlierHistory,
  readingScope,
  readingPositions,
  onHistoryReady,
  connected,
  connecting = false,
  connectionError,
  connectionLost = false,
  reconnect,
  agentSessionState: liveSessionState,
  agentSessionError,
  onModelReady,
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
  const [modelReadiness, setModelReadiness] = useState<{
    scope: string;
    ready: boolean;
  }>();
  const modelScope = modelSelectionScope(
    hostId,
    projectId,
    agentId,
    model,
    effort,
  );
  const modelReady =
    modelReadiness?.scope === modelScope && modelReadiness.ready;
  useEffect(() => {
    if (modelReady) onModelReady?.();
  }, [modelReady, onModelReady]);
  const [approving, setApproving] = useState<{
    scope: string;
    id: string;
  } | null>(null);
  const approvalSubmissions = useRef(new Set<string>());
  const submittingApproval =
    approving?.scope === draftKey ? approving.id : null;
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const historyScope = JSON.stringify([hostId, session?.id ?? null]);
  const localPositions = useRef(
    new Map<string, { top: number; follow: boolean }>(),
  );
  const positions = readingPositions ?? localPositions.current;
  const positionScope = readingScope ?? historyScope;
  const [visibleHistoryScope, setVisibleHistoryScope] = useState<string | null>(
    null,
  );
  const preparingHistory =
    historyLoading ||
    (events.length > 0 && visibleHistoryScope !== positionScope);
  const openingSession =
    session &&
    connected &&
    (liveSessionState === "opening" || liveSessionState === "restoring");
  const [away, setAway] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopGeneration = useRef(0);
  const active = session && ["running", "waiting"].includes(session.status);
  const pendingApprovals = useMemo(
    () =>
      session && active && !session.archived && !preparingHistory
        ? activityTranscript(
            events.filter((e) => e.session_id === session.id),
          ).flatMap((item) =>
            item.type === "event" &&
            item.value.kind === "approval" &&
            !item.resolved
              ? [{ request: item.value, tool: item.approvalTool }]
              : [],
          )
        : [],
    [events, session, active, preparingHistory],
  );
  useEffect(() => {
    stopGeneration.current++;
    setStopping(false);
  }, [draftKey, active]);
  const workingStatus = executionStatus(session, events, connected, stopping);
  const repeatedOutput = useMemo(
    () =>
      !!session &&
      session.status === "running" &&
      !session.archived &&
      connected &&
      !preparingHistory &&
      !stopping &&
      hasRepeatedOutput(events, session.id),
    [events, session, connected, preparingHistory, stopping],
  );
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
  useLayoutEffect(() => {
    const saved = positions.get(positionScope);
    setVisibleHistoryScope(null);
    follow.current = saved?.follow ?? true;
    setAway(!follow.current);
  }, [positionScope, positions]);
  const previousHistoryLayout = useRef<
    | {
        scope: string;
        first?: number;
        height: number;
      }
    | undefined
  >(undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const previous = previousHistoryLayout.current;
    if (
      previous?.scope === positionScope &&
      previous.first !== undefined &&
      events[0]?.seq < previous.first &&
      !follow.current
    ) {
      el.scrollTop += el.scrollHeight - previous.height;
      positions.set(positionScope, { top: el.scrollTop, follow: false });
    }
    previousHistoryLayout.current = {
      scope: positionScope,
      first: events[0]?.seq,
      height: el.scrollHeight,
    };
  }, [events, positionScope, positions]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const scrollToLatest = () => {
      if (follow.current) el.scrollTo({ top: el.scrollHeight });
    };
    scrollToLatest();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(el);
    const content = el.querySelector(".messages, .welcome");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [hostId, session?.id, events]);
  useLayoutEffect(() => {
    if (historyLoading) {
      setVisibleHistoryScope(null);
      return;
    }
    if (visibleHistoryScope === positionScope) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const el = scroller.current;
        if (el) {
          const saved = positions.get(positionScope);
          el.scrollTop = follow.current ? el.scrollHeight : (saved?.top ?? 0);
        }
        setVisibleHistoryScope(positionScope);
        setAway(!follow.current);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    historyLoading,
    historyScope,
    visibleHistoryScope,
    events,
    positionScope,
    positions,
  ]);
  useEffect(() => {
    if (!preparingHistory) onHistoryReady?.();
  }, [preparingHistory, historyScope, onHistoryReady]);
  async function submit(
    prompt: string,
    uiAction?: "subagents",
  ): Promise<boolean> {
    if (
      !prompt.trim() ||
      sending ||
      active ||
      !connected ||
      !available ||
      !modelReady ||
      liveSessionState === "opening" ||
      liveSessionState === "restoring" ||
      liveSessionState === "error" ||
      liveSessionState === "unknown" ||
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
      submitted.accepted = await send(
        prompt,
        model,
        effort,
        permissionMode,
        uiAction,
      );
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
    const key = JSON.stringify([draftKey, id]);
    if (
      !connected ||
      stopping ||
      submittingApproval ||
      approvalSubmissions.current.has(key) ||
      !pendingApprovals.some(({ request }) => request.request_id === id)
    )
      return;
    const submission = { scope: draftKey, id };
    approvalSubmissions.current.add(key);
    setApproving(submission);
    try {
      await approve(id, allow);
    } finally {
      approvalSubmissions.current.delete(key);
      setApproving((current) => (current === submission ? null : current));
    }
  }
  return (
    <section
      className="conversation"
      ref={root}
      data-preparing={!connected && (connecting || !connectionError)}
    >
      <div className="conversation-history">
        <div
          className={`conversation-scroll${events.length === 0 ? " empty" : ""}`}
          ref={scroller}
          aria-busy={preparingHistory}
          data-history-loading={preparingHistory}
          onScroll={() => {
            if (preparingHistory) return;
            const el = scroller.current!;
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            positions.set(positionScope, {
              top: el.scrollTop,
              follow: follow.current,
            });
            setAway(!follow.current);
            if (
              el.scrollTop < 120 &&
              hasEarlierHistory &&
              !earlierHistoryLoading &&
              !follow.current
            )
              void loadEarlierHistory?.();
          }}
        >
          {events.length === 0 ? (
            <div className="welcome" aria-hidden={preparingHistory}>
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
            <div className="messages" aria-hidden={preparingHistory}>
              {hasEarlierHistory && (
                <div className="earlier-history">
                  <button
                    className="secondary small"
                    disabled={earlierHistoryLoading}
                    onClick={() => void loadEarlierHistory?.()}
                  >
                    {earlierHistoryLoading ? (
                      <WorkingStatus label="" animated />
                    ) : (
                      "加载之前的记录"
                    )}
                  </button>
                </div>
              )}
              {subagents && openSubagents && (
                <SubagentSummary state={subagents} open={openSubagents} />
              )}
              <TurnTranscript events={events}>
                {(item) =>
                  item.type === "user" ? (
                    <UserMessage key={item.key} text={item.text} at={item.at} />
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
                      if (v.kind === "turn_changes" && openTurnChanges)
                        return (
                          <TurnChangesCard
                            key={`${hostId}:${session?.id}:${item.key}`}
                            hostId={hostId}
                            sessionId={session?.id ?? ""}
                            canUndo={
                              connected &&
                              !!session &&
                              !["running", "waiting"].includes(
                                session.status,
                              ) &&
                              latestRequestId(events) === v.changes.request_id
                            }
                            changes={v.changes}
                            open={(path) => openTurnChanges(v.changes, path)}
                          />
                        );
                      if (v.kind === "approval")
                        return (
                          <ApprovalCard
                            key={item.key}
                            request={v}
                            resolved={item.resolved}
                            decision={item.decision}
                            tool={item.approvalTool}
                            presentation="record"
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
      </div>
      <div className="composer-wrap">
        {session &&
          connected &&
          liveSessionState &&
          !["open", "closed", "opening", "restoring"].includes(
            liveSessionState,
          ) && (
            <div
              className="agent-session-feedback"
              title={agentSessionError}
              role="status"
            >
              <span>{agentSessionLabels[liveSessionState]}</span>
              <button
                className="secondary"
                onClick={reconnect}
                disabled={!reconnect}
              >
                {liveSessionState === "unknown" ? "重新连接" : "重新打开"}
              </button>
            </div>
          )}
        {!connected && !connecting && connectionError && (
          <div className="composer-connection-error" role="status">
            <span title={connectionError}>
              {connectionLost ? "连接已断开" : "暂时无法连接"}
            </span>
            <button type="button" className="text-button" onClick={reconnect}>
              重新连接
            </button>
          </div>
        )}
        <div className="composer-context">
          {!connected && (connecting || !connectionError) && text.trim() && (
            <WorkingStatus label="正在准备…" animated />
          )}
          {openingSession && (
            <div className="agent-session-opening">
              <WorkingStatus
                label={agentSessionLabels[liveSessionState!]}
                animated
              />
            </div>
          )}
          {away && !openingSession && (
            <button
              className="return-latest"
              aria-label="回到最新"
              title="回到最新"
              onClick={() => {
                follow.current = true;
                setAway(false);
                scroller.current?.scrollTo({
                  top: scroller.current.scrollHeight,
                });
              }}
            >
              <ArrowDown size={15} />
              <span>回到最新</span>
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
        {pendingApprovals.length > 0 && (
          <section className="approval-dock" aria-label="待审批操作">
            {pendingApprovals.length > 1 && (
              <p className="approval-dock-count">
                {pendingApprovals.length} 项操作等待确认
              </p>
            )}
            {pendingApprovals.map(({ request, tool }) => (
              <ApprovalCard
                key={JSON.stringify([draftKey, request.request_id])}
                request={request}
                tool={tool}
                disabled={!connected || stopping || !!submittingApproval}
                busy={submittingApproval === request.request_id}
                onDecision={(allow) => void decide(request.request_id, allow)}
              />
            ))}
          </section>
        )}
        {repeatedOutput && (
          <div className="repeated-output-warning" role="status">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>回复内容似乎在重复，可停止任务后重试。</span>
          </div>
        )}
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
          onOpenSubagents={openSubagents}
          placeholder={
            !connected
              ? connecting || !connectionError
                ? "正在准备…"
                : "暂时无法连接"
              : session?.archived
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
                onReadyChange={setModelReadiness}
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
                      !modelReady ||
                      liveSessionState === "opening" ||
                      liveSessionState === "restoring" ||
                      liveSessionState === "error" ||
                      liveSessionState === "unknown" ||
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

function latestRequestId(events: Event[]) {
  const event = [...events]
    .reverse()
    .find((event) => event.event.kind === "user")?.event;
  return event?.kind === "user" ? event.request_id : undefined;
}
