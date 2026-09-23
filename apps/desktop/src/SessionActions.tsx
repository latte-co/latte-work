import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Copy,
  Eye,
  Pencil,
  Pin,
  PinOff,
  Square,
  X,
} from "lucide-react";
import { message, request } from "./api";
import type { Workbench } from "./useWorkbench";
import type { HostedSession } from "./sessionNavigation";
import { conversationMarkdown, loadConversation } from "./sessionNavigation";

export function SessionActions({
  session,
  point,
  close,
  state,
}: {
  session: HostedSession;
  point: { x: number; y: number };
  close: () => void;
  state: Workbench;
}) {
  const [view, setView] = useState<"menu" | "rename" | "copy" | "transcript">(
    "menu",
  );
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState(point);
  const menu = useRef<HTMLDivElement>(null);
  const menuView = view === "menu" || view === "copy";
  const active = ["running", "waiting"].includes(session.status);
  useLayoutEffect(() => {
    if (!menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(point.x, innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(point.y, innerHeight - rect.height - 8)),
    });
    menu.current
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [point, view]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!busy) close();
        return;
      }
      if (!menuView) return;
      if (e.key === "Tab") {
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const buttons = Array.from(
        menu.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      buttons[
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
      ]?.focus();
    };
    const outside = (e: PointerEvent) => {
      if (menuView && !busy && !menu.current?.contains(e.target as Node))
        close();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [close, busy, menuView]);
  async function perform(action: () => Promise<unknown>, dismiss = true) {
    setBusy(true);
    setError("");
    try {
      await action();
      if (dismiss) close();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const run = (action: Parameters<Workbench["sessionAction"]>[1]) =>
    void perform(() => state.sessionAction(session.hostId, action));
  const id = session.id;
  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  }
  if (menuView)
    return createPortal(
      <div
        ref={menu}
        role="menu"
        aria-label={`${session.title} 会话操作`}
        className="project-context-menu session-context-menu"
        style={{ left: position.x, top: position.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {view === "copy" ? (
          <>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => setView("menu")}
            >
              返回
            </button>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => void perform(() => copy(session.title))}
            >
              <Copy size={17} />
              复制标题
            </button>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => void perform(() => copy(id))}
            >
              <Copy size={17} />
              复制会话 ID
            </button>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const events = await loadConversation((after) =>
                    request(session.hostId, {
                      method: "poll",
                      session_id: id,
                      after,
                    }),
                  );
                  setMarkdown(conversationMarkdown(session.title, events));
                  setView("transcript");
                }, false)
              }
            >
              <Copy size={17} />
              {busy ? "读取完整对话…" : "对话 Markdown…"}
            </button>
          </>
        ) : (
          <>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => setView("rename")}
            >
              <Pencil size={17} />
              重命名
            </button>
            <button
              role="menuitem"
              disabled={busy || session.archived}
              onClick={() =>
                run({
                  method: "pin_session",
                  session_id: id,
                  pinned: session.pinned_at === null,
                })
              }
            >
              {session.pinned_at === null ? (
                <Pin size={17} />
              ) : (
                <PinOff size={17} />
              )}
              {session.pinned_at === null ? "置顶" : "取消置顶"}
            </button>
            <button
              role="menuitem"
              disabled={busy}
              onClick={() =>
                run({
                  method: "mark_session_unread",
                  session_id: id,
                  unread: !session.unread,
                })
              }
            >
              <Eye size={17} />
              {session.unread ? "标记为已读" : "标记为未读"}
            </button>
            <div role="separator" />
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => setView("copy")}
            >
              <Copy size={17} />
              复制
              <ChevronRight size={15} className="menu-chevron" />
            </button>
            <div role="separator" />
            {active && (
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => run({ method: "cancel", session_id: id })}
              >
                <Square size={17} />
                停止任务
              </button>
            )}
            <button
              role="menuitem"
              disabled={busy || active}
              title={active ? "请先停止任务，再归档" : undefined}
              onClick={() =>
                run({
                  method: "archive_session",
                  session_id: id,
                  archived: !session.archived,
                })
              }
            >
              {session.archived ? (
                <ArchiveRestore size={17} />
              ) : (
                <Archive size={17} />
              )}
              {session.archived ? "取消归档" : "归档"}
            </button>
          </>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>,
      document.body,
    );
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={view === "rename" ? "重命名会话" : "复制对话"}
      >
        <button
          className="modal-close icon-button"
          aria-label="关闭"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
        <h2>{view === "rename" ? "重命名会话" : "复制对话"}</h2>
        {view === "rename" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run({ method: "rename_session", session_id: id, title });
            }}
          >
            <label>
              会话名称
              <input
                autoFocus
                required
                maxLength={100}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
              />
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={close}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="form-note">
              复制截至读取时的用户和助手消息，保留 Markdown
              格式，不包含工具原始输出。
            </p>
            <textarea
              className="copy-transcript"
              aria-label="对话 Markdown"
              readOnly
              value={markdown}
            />
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => void perform(() => copy(markdown), false)}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
