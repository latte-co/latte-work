import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, MessageCircle } from "lucide-react";
import { message, request, ServerRequestError } from "./api";
import { MessageTimestamp } from "./MessageTimestamp";
import type { Session } from "./protocol";

export interface SideChatHistoryProps {
  hostId: string;
  parentId: string;
  currentId?: string;
  onOpen: (id: string) => void;
}

export function SideChatHistory({
  hostId,
  parentId,
  currentId,
  onOpen,
}: SideChatHistoryProps) {
  return (
    <SideChatHistoryPages
      key={JSON.stringify([hostId, parentId])}
      hostId={hostId}
      parentId={parentId}
      currentId={currentId}
      onOpen={onOpen}
    />
  );
}

function SideChatHistoryPages({
  hostId,
  parentId,
  currentId,
  onOpen,
}: SideChatHistoryProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [attempt, retry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    async function read() {
      try {
        const response = await request(hostId, {
          method: "side_chat_history",
          session_id: parentId,
          before,
        }).catch((cause) => {
          if (
            before === null &&
            cause instanceof ServerRequestError &&
            cause.code === "invalid_request"
          )
            return request(hostId, {
              method: "side_chats",
              session_id: parentId,
            });
          throw cause;
        });
        if (disposed) return;
        if (
          response.kind !== "side_chat_history" &&
          response.kind !== "sessions"
        )
          throw new Error("无法读取历史记录");
        setSessions((previous) =>
          before === null
            ? response.sessions
            : [...previous, ...response.sessions],
        );
        setNext(response.kind === "side_chat_history" ? response.next : null);
      } catch (cause) {
        if (!disposed) setError(message(cause));
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void read();
    return () => {
      disposed = true;
    };
  }, [hostId, parentId, before, attempt]);

  function loadOlder() {
    setLoading(true);
    setError("");
    if (error) retry((value) => value + 1);
    else setBefore(next);
  }

  return (
    <div className="side-chat-history-list" role="group" aria-label="历史记录">
      {sessions.map((session) => {
        const status =
          session.status === "running"
            ? "执行中"
            : session.status === "waiting"
              ? "等待回应"
              : session.status === "failed"
                ? "失败"
                : session.status === "unknown"
                  ? "待确认"
                  : null;
        return (
          <button
            key={session.id}
            type="button"
            className="side-chat-history-row"
            title={session.title}
            aria-current={session.id === currentId ? "true" : undefined}
            onClick={() => onOpen(session.id)}
          >
            <MessageCircle size={15} aria-hidden="true" />
            <span className="side-chat-history-title">{session.title}</span>
            {status && <small data-status={session.status}>{status}</small>}
            <MessageTimestamp at={session.created_at} label="创建时间" />
          </button>
        );
      })}
      {(loading || error || !sessions.length) && (
        <p className="side-chat-history-status" role="status">
          {loading ? "正在读取…" : error || "暂无历史记录"}
        </p>
      )}
      {(next || error || before) && (
        <button
          type="button"
          className="task-info-earlier"
          aria-disabled={loading || (!next && !error) || undefined}
          onClick={() => {
            if (!loading && (next || error)) loadOlder();
          }}
        >
          {error ? "重试" : next ? "查看更早记录" : "已显示全部记录"}
        </button>
      )}
    </div>
  );
}

export function SideChatHistoryButton(props: SideChatHistoryProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    popup.current?.focus();
    function dismiss() {
      setOpen(false);
    }
    function outside(event: PointerEvent) {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        dismiss();
    }
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);
  const rect = trigger.current?.getBoundingClientRect();
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="icon-button"
        title="历史"
        aria-label="历史"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={16} aria-hidden="true" />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            id={id}
            ref={popup}
            className="side-chat-history-popover"
            role="dialog"
            aria-label="历史"
            tabIndex={-1}
            style={{
              right: Math.max(8, window.innerWidth - rect.right),
              top: rect.bottom + 8,
            }}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== trigger.current
              )
                setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            <h2>历史</h2>
            <SideChatHistory
              {...props}
              onOpen={(id) => {
                setOpen(false);
                trigger.current?.focus();
                props.onOpen(id);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
