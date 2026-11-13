import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Quote, X } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ComposerAction } from "./ComposerAction";
import { ModelPicker, type ModelPickerHandle } from "./ModelPicker";
import { modelSelectionScope } from "./modelSelectionScope";
import { PermissionPicker } from "./PermissionPicker";
import { message, request, ServerRequestError } from "./api";
import { DraftStore, useDraft, type Draft } from "./drafts";
import { MessageContent } from "./MessageContent";
import { QuestionCard } from "./QuestionCard";
import { TurnTranscript } from "./TurnTranscript";
import { ToolGroup, ToolRow } from "./ToolActivity";
import { ToolImages } from "./ToolImages";
import { UserMessage } from "./UserMessage";
import { WorkingStatus } from "./WorkingStatus";
import { executionStatus } from "./executionStatus";
import type { Effort, Event, Request, Session } from "./protocol";
import { LIVE_POLL_MS } from "./usePollingSnapshot";
import { readWorkspace, setSideChatDraft, sideChatId } from "./workspaceState";

export const sideDraftKey = (host: string, parent: string, side: string) =>
  JSON.stringify(["side", host, parent, side]);

type Send = Extract<Request, { method: "send" }>;

// A transport failure can outlive the tab. Keep the ID for the exact draft
// in memory so a manual retry reconciles the original admission.
const admissions = new WeakMap<
  DraftStore,
  Map<string, { draft: Draft; request: Send }>
>();
const operations = new WeakMap<DraftStore, Map<string, Promise<unknown>>>();

function sideOperations(drafts: DraftStore) {
  let pending = operations.get(drafts);
  if (!pending) {
    pending = new Map();
    operations.set(drafts, pending);
  }
  return pending;
}

function missingSession(error: unknown) {
  return (
    error instanceof ServerRequestError &&
    error.code === "request_failed" &&
    error.message === "会话不存在"
  );
}

export async function closeSideChat(
  drafts: DraftStore,
  hostId: string,
  parentId: string,
  workspaceId: string,
  id: string,
) {
  const sideId = sideChatId(id);
  if (!sideId || sideId === parentId) throw new Error("侧边聊天 ID 无效");
  const key = sideDraftKey(hostId, parentId, sideId);
  const pending = sideOperations(drafts);
  const previous = pending.get(key);
  const closing = (async () => {
    await previous;
    const tab = readWorkspace(workspaceId).tabs.find((tab) => tab.id === id);
    if (tab?.kind !== "sideChat") return;
    if (!tab.draft) {
      try {
        const result = await request(hostId, {
          method: "close_agent_session",
          session_id: sideId,
          only_if_idle: false,
        });
        if (result.kind !== "ok") throw new Error("无法确认侧边聊天已关闭");
      } catch (cause) {
        if (!missingSession(cause)) throw cause;
      }
    }
    drafts.clear(key, drafts.get(key));
    admissions.get(drafts)?.delete(key);
  })();
  pending.set(key, closing);
  try {
    await closing;
  } finally {
    if (pending.get(key) === closing) pending.delete(key);
  }
}

export function SideChat({
  parent,
  sideId,
  workspaceId,
  isDraft = false,
  hostId,
  drafts,
  active,
  connected,
  supported,
}: {
  parent: Session;
  sideId: string;
  workspaceId: string;
  isDraft?: boolean;
  hostId: string;
  drafts: DraftStore;
  active: boolean;
  connected: boolean;
  supported: boolean;
}) {
  const key = sideDraftKey(hostId, parent.id, sideId);
  const draft = useDraft(drafts, key);
  const [session, setSession] = useState<Session>();
  const [events, setEvents] = useState<Event[]>([]);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const picker = useRef<ModelPickerHandle>(null);
  const [focus, setFocus] = useState(0);
  const [selection, setSelection] = useState<{
    model: string | null;
    effort: Effort | null;
    permission: string | null;
  }>();
  const [modelReadiness, setModelReadiness] = useState<{
    scope: string;
    ready: boolean;
  }>();
  const model = selection
    ? selection.model
    : ((session ?? parent).model ?? null);
  const effort = selection
    ? selection.effort
    : ((session ?? parent).effort ?? null);
  const permission = selection
    ? selection.permission
    : (session?.permission_mode ?? null);
  const quotes = draft.quotes ?? [];
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const after = useRef(0);
  const enabled = active && connected && supported;
  useEffect(() => {
    if (!enabled) return;
    setFocus((v) => v + 1);
  }, [enabled]);

  useEffect(() => {
    setReady(false);
    if (!enabled || busy || isDraft) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        await sideOperations(drafts).get(key);
        if (disposed) return;
        const page = await request(hostId, {
          method: "poll",
          session_id: sideId,
          after: after.current,
        });
        if (disposed) return;
        if (
          page.kind !== "events" ||
          page.session.id !== sideId ||
          page.session.id === parent.id ||
          page.session.project_id !== parent.project_id
        )
          throw new Error("侧边聊天记录不匹配");
        if (page.has_more && !page.events.length)
          throw new Error("侧边聊天记录分页未前进");
        if (page.events.length) {
          const next = page.events.at(-1)!.seq;
          if (
            next <= after.current ||
            page.events.some((e) => e.session_id !== sideId)
          )
            throw new Error("侧边聊天记录游标无效");
          after.current = next;
          setEvents((previous) => [...previous, ...page.events]);
          const pending = admissions.get(drafts)?.get(key);
          if (
            pending &&
            page.events.some(
              ({ event }) =>
                event.kind === "user" &&
                event.request_id === pending.request.request_id,
            )
          ) {
            drafts.clear(key, pending.draft);
            admissions.get(drafts)?.delete(key);
            setError("");
          }
        }
        setSession(page.session);
        setReady(!page.has_more);
        setReadError("");
        timer = setTimeout(read, page.has_more ? 0 : LIVE_POLL_MS);
      } catch (cause) {
        if (!disposed) {
          if (missingSession(cause)) {
            after.current = 0;
            setSession(undefined);
            setEvents([]);
            setSideChatDraft(workspaceId, sideId, true);
            setReadError("");
            return;
          }
          setReadError(message(cause));
          setReady(false);
        }
      }
    }
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    enabled,
    busy,
    hostId,
    parent.id,
    parent.project_id,
    sideId,
    workspaceId,
    isDraft,
    revision,
    drafts,
    key,
  ]);

  useLayoutEffect(() => {
    if (active && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [active, events, session?.status]);

  const canInteract = enabled && (ready || isDraft);
  function perform(action: Request, accepted?: () => void) {
    const pending = sideOperations(drafts);
    if (!canInteract || pending.has(key)) return Promise.resolve(false);
    setBusy(true);
    setError("");
    const operation = Promise.resolve().then(async () => {
      try {
        if (action.method === "send" && isDraft) {
          // Persist that creation was attempted so reconnect can check the same ID.
          setSideChatDraft(workspaceId, sideId, false);
          const opened = await request(hostId, {
            method: "open_side_chat",
            session_id: parent.id,
            side_id: sideId,
          });
          if (
            opened.kind !== "session" ||
            opened.session.id !== sideId ||
            opened.session.id === parent.id ||
            opened.session.project_id !== parent.project_id
          )
            throw new Error("Server 未返回独立的侧边聊天");
        }
        const response = await request(hostId, action);
        if (
          action.method === "send"
            ? response.kind !== "accepted"
            : response.kind !== "ok"
        )
          throw new Error("操作结果待确认，请核对侧边聊天的记录");
        accepted?.();
        setReady(false);
        refresh((v) => v + 1);
        return true;
      } catch (cause) {
        if (action.method === "send" && cause instanceof ServerRequestError) {
          const pending = admissions.get(drafts)?.get(key);
          if (pending?.request.request_id === action.request_id)
            admissions.get(drafts)?.delete(key);
        }
        setError(message(cause));
        return false;
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
        setBusy(false);
      }
    });
    pending.set(key, operation);
    return operation;
  }
  const running =
    session?.status === "running" || session?.status === "waiting";
  const disabled = !canInteract || busy || parent.archived;
  const modelReady =
    modelReadiness?.scope ===
      modelSelectionScope(
        hostId,
        parent.project_id,
        parent.agent,
        model,
        effort,
      ) && modelReadiness.ready;
  function submit(prompt: string) {
    if (
      (!prompt.trim() && !quotes.length) ||
      disabled ||
      sideOperations(drafts).has(key) ||
      running ||
      !modelReady
    )
      return Promise.resolve(false);
    if (draft.text.trimStart().startsWith("/")) {
      setError("侧边聊天暂不支持 Agent 原生命令，请输入普通消息。");
      return Promise.resolve(false);
    }
    let requests = admissions.get(drafts);
    if (!requests) {
      requests = new Map();
      admissions.set(drafts, requests);
    }
    const old = requests.get(key);
    if (
      old &&
      drafts.isCurrent(key, old.draft) &&
      (old.request.model !== model ||
        old.request.effort !== effort ||
        old.request.permission_mode !== permission)
    ) {
      setError(
        "上次发送结果待确认。请恢复上次的模型和权限选择后重试，或编辑问题后再发送。",
      );
      return Promise.resolve(false);
    }
    const send: Send =
      old && drafts.isCurrent(key, old.draft)
        ? old.request
        : {
            method: "send",
            session_id: sideId,
            request_id: crypto.randomUUID(),
            text: [
              ...quotes.map((quote) =>
                quote
                  .split("\n")
                  .map((line) => `> ${line}`)
                  .join("\n"),
              ),
              prompt || "请结合主会话解释引用的文本。",
            ].join("\n\n"),
            model,
            effort,
            permission_mode: permission,
          };
    requests.set(key, { draft, request: send });
    follow.current = true;
    return perform(send, () => {
      drafts.clear(key, draft);
      if (requests.get(key)?.request.request_id === send.request_id)
        requests.delete(key);
    });
  }
  const status = executionStatus(session, events, connected);
  return (
    <div className="side-chat">
      <div
        className="side-chat-history"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 90;
        }}
      >
        {!ready && !events.length && enabled && !readError && (
          <WorkingStatus label="正在读取记录…" animated />
        )}
        <div className="side-chat-messages">
          <TurnTranscript events={events}>
            {(item) => {
              if (item.type === "user")
                return (
                  <UserMessage
                    text={item.text}
                    at={item.at}
                    hostId={hostId}
                    projectId={parent.project_id}
                    sessionId={session?.id}
                    connected={connected}
                    active={active}
                  />
                );
              if (item.type === "assistant")
                return (
                  <article className="assistant-message markdown">
                    <MessageContent text={item.text} />
                  </article>
                );
              if (item.type === "tool")
                return (
                  <ToolRow
                    tool={item}
                    loadContext={
                      session ? { hostId, sessionId: session.id } : undefined
                    }
                  />
                );
              if (item.type === "tools")
                return (
                  <ToolGroup
                    tools={item.tools}
                    loadContext={
                      session ? { hostId, sessionId: session.id } : undefined
                    }
                  />
                );
              if (item.type === "tool_images")
                return <ToolImages images={item.images} active={enabled} />;
              if (item.type !== "event") return null;
              const v = item.value;
              if (v.kind === "notice")
                return <p className="notice">{v.text}</p>;
              if (v.kind === "state" && (v.message || v.status === "unknown"))
                return (
                  <p className="notice">{v.message || "侧边聊天状态待确认"}</p>
                );
              if (v.kind === "approval" && session)
                return (
                  <ApprovalCard
                    request={v}
                    resolved={item.resolved}
                    decision={item.decision}
                    disabled={disabled || !running}
                    busy={busy}
                    onDecision={(allow) =>
                      void perform({
                        method: "approve",
                        session_id: session.id,
                        request_id: v.request_id,
                        allow,
                      })
                    }
                  />
                );
              if (v.kind === "question" && session)
                return (
                  <QuestionCard
                    request={v}
                    resolved={item.resolved}
                    answers={item.answers}
                    disabled={disabled || !running}
                    onAnswer={(answers) =>
                      void perform({
                        method: "answer_question",
                        session_id: session.id,
                        request_id: v.request_id,
                        answers,
                      })
                    }
                  />
                );
              return null;
            }}
          </TurnTranscript>
          {status && (
            <WorkingStatus label={status} animated={enabled && running} />
          )}
        </div>
      </div>
      <div className="side-chat-compose">
        {(!connected || !supported || readError || error) && (
          <div role="alert" className="notice">
            {!connected
              ? "主机已断开，请在重连后核对记录"
              : !supported
                ? "请更新执行主机的 Server 以使用侧边聊天"
                : readError || error}
            {enabled && readError && (
              <button
                className="secondary small"
                onClick={() => refresh((v) => v + 1)}
              >
                重新读取
              </button>
            )}
          </div>
        )}
        <Composer
          focusRequest={focus}
          inputLabel="侧边聊天输入"
          hasContext={quotes.length > 0}
          sideChat
          context={
            quotes.length > 0 && (
              <div
                className="composer-references side-chat-quotes"
                aria-label="引用的文本片段"
              >
                {quotes.map((quote, index) => (
                  <span key={index}>
                    <details>
                      <summary>
                        <Quote size={14} /> 文本片段
                        {quotes.length > 1 ? ` ${index + 1}` : ""}
                      </summary>
                      <p>{quote}</p>
                    </details>
                    <button
                      aria-label={`移除文本片段 ${index + 1}`}
                      disabled={busy}
                      onClick={() =>
                        drafts.update(key, {
                          quotes: quotes.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )
          }
          referenceState={draft.references}
          onReferencesChange={(references) =>
            drafts.update(key, { references })
          }
          agent={parent.agent}
          hostId={hostId}
          projectId={parent.project_id}
          sessionId={session?.id}
          connected={connected}
          hidden={!active}
          disabled={parent.archived}
          sending={busy}
          value={draft.text}
          onChange={(text) => drafts.update(key, { text })}
          onSubmit={submit}
          onOpenModelSettings={(target) =>
            picker.current?.openMenu(target) ?? null
          }
          placeholder="在侧边聊天中提问…"
          toolbar={(send, hasContent, navigation) => (
            <>
              <PermissionPicker
                hostId={hostId}
                agent={parent.agent}
                connected={connected}
                hidden={!active}
                value={permission}
                onChange={(permission) =>
                  setSelection({ model, effort, permission })
                }
                disabled={disabled || running}
                sideChat
              />
              <ModelPicker
                ref={picker}
                onReadyChange={setModelReadiness}
                hostId={hostId}
                projectId={parent.project_id}
                agent={parent.agent}
                connected={connected}
                settingsOpen={!active}
                value={model}
                onChange={(model) =>
                  setSelection({ model, effort, permission })
                }
                effort={effort}
                onEffortChange={(effort) =>
                  setSelection({ model, effort, permission })
                }
                onEffortInvalid={() =>
                  setSelection({ model, effort: null, permission })
                }
                disabled={disabled || running}
              />
              <ComposerAction
                active={running}
                label={running ? "停止侧边聊天" : "发送侧边聊天消息"}
                sending={busy}
                disabled={
                  disabled ||
                  (!running && (!hasContent || (!navigation && !modelReady)))
                }
                onClick={
                  running && session
                    ? () =>
                        void perform({
                          method: "cancel",
                          session_id: session.id,
                        })
                    : send
                }
              />
            </>
          )}
        />
      </div>
    </div>
  );
}
