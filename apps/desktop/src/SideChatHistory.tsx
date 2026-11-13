import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, MessageCircle } from "lucide-react";
import { message, request } from "./api";
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
  const scope = JSON.stringify([hostId, parentId]);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    sessions: Session[];
    error: string;
  }>();
  const current = snapshot?.scope === scope ? snapshot : undefined;
  useEffect(() => {
    let disposed = false;
    void request(hostId, { method: "side_chats", session_id: parentId })
      .then((response) => {
        if (response.kind !== "sessions") throw new Error("无法读取历史记录");
        if (!disposed)
          setSnapshot({ scope, sessions: response.sessions, error: "" });
      })
      .catch((cause) => {
        if (!disposed)
          setSnapshot({ scope, sessions: [], error: message(cause) });
      });
    return () => {
      disposed = true;
    };
  }, [hostId, parentId, scope]);

  if (!current || current.error || !current.sessions.length)
    return (
      <p className="side-chat-history-status" role="status">
        {!current ? "正在读取…" : current.error || "暂无历史记录"}
      </p>
    );

  return (
    <div className="side-chat-history-list" role="group" aria-label="历史记录">
      {current.sessions.map((session) => {
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
