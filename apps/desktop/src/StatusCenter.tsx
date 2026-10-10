import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  CircleAlert,
  CircleHelp,
  CircleCheck,
  Info,
  X,
} from "lucide-react";
import { message } from "./api";
import { useStatusSnapshot, type StatusNotice } from "./statusNotices";

const icons = {
  error: CircleAlert,
  warning: CircleHelp,
  info: Info,
  success: CircleCheck,
};
const labels = {
  error: "错误",
  warning: "注意",
  info: "状态",
  success: "完成",
};

export function StatusCenter({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const { notices, total } = useStatusSnapshot();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const actionsInFlight = useRef(new Set<string>());
  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const resize = () => setOpen(false);
    const focusOutside = (event: FocusEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  async function act(notice: StatusNotice) {
    if (!notice.action || actionsInFlight.current.has(notice.id)) return;
    actionsInFlight.current.add(notice.id);
    setBusy(notice.id);
    setActionError("");
    try {
      await notice.action.run();
    } catch (cause) {
      setActionError(message(cause));
    } finally {
      actionsInFlight.current.delete(notice.id);
      setBusy(null);
    }
  }
  const rect = trigger.current?.getBoundingClientRect();
  return (
    <>
      <button
        ref={trigger}
        className="panel-toggle icon-button status-center-trigger"
        data-level={notices[0]?.level}
        aria-label={total ? `状态提示（${total}）` : "状态提示"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={total ? `${total} 条状态提示` : "状态提示"}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={16} />
        {total > 0 && (
          <span className="status-center-count" aria-hidden="true">
            {total > 99 ? "99+" : total}
          </span>
        )}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {total ? `有 ${total} 条状态提示` : "当前没有状态提示"}
      </span>
      {open &&
        rect &&
        createPortal(
          <div
            ref={popup}
            role="dialog"
            aria-label="状态提示"
            className="status-center-popover"
            style={{
              right: Math.min(
                Math.max(8, window.innerWidth - rect.right),
                Math.max(
                  8,
                  window.innerWidth - Math.min(360, window.innerWidth - 16) - 8,
                ),
              ),
              top: rect.bottom + 8,
              maxHeight: Math.max(0, window.innerHeight - rect.bottom - 24),
            }}
          >
            <header>
              <strong>状态提示</strong>
              <button
                className="icon-button"
                aria-label="关闭状态提示"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            </header>
            {total === 0 && (
              <p className="status-center-empty">当前没有状态提示</p>
            )}
            <ul>
              {notices.map((notice) => {
                const Icon = icons[notice.level];
                return (
                  <li key={notice.id} data-level={notice.level}>
                    <div className="status-center-title">
                      <Icon size={16} aria-label={labels[notice.level]} />
                      <strong>{notice.title}</strong>
                    </div>
                    <p>{notice.detail}</p>
                    {notice.action && (
                      <button
                        className="text-button"
                        disabled={!!busy || notice.pending}
                        onClick={() => void act(notice)}
                      >
                        {busy === notice.id || notice.pending
                          ? "处理中…"
                          : notice.action.label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {total > notices.length && (
              <p className="status-center-empty">
                仅显示前 {notices.length} 条提示。
              </p>
            )}
            {actionError && (
              <p className="status-center-action-error" role="alert">
                {actionError}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
