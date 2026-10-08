import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, FileText } from "lucide-react";

export function ReviewOptions({
  trigger,
  fullContext,
  frozen,
  choose,
  close,
}: {
  trigger: HTMLButtonElement;
  fullContext: boolean;
  frozen: boolean;
  choose: () => void;
  close: (restoreFocus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const rect = trigger.getBoundingClientRect();
  useEffect(() => {
    (
      menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
      menu.current
    )?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.contains(event.target as Node)
      )
        close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === "Tab") close(false);
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        menu.current
          ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
          ?.focus();
      }
    };
    const resize = () => close(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, [trigger, close]);
  return createPortal(
    <div
      ref={menu}
      tabIndex={-1}
      role="menu"
      aria-label="更多差异选项"
      className="project-context-menu review-options"
      style={{
        left: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)),
        top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 120)),
      }}
    >
      <button
        role="menuitemcheckbox"
        aria-checked={fullContext && !frozen}
        disabled={frozen}
        onClick={() => {
          choose();
          close();
        }}
      >
        <FileText size={16} />
        <span>加载完整文件</span>
        {fullContext && !frozen && <Check size={16} />}
      </button>
      {frozen && <p>回合快照仅保留采集时的上下文。</p>}
    </div>,
    document.body,
  );
}
