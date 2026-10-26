import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Box, ChevronDown, FolderInput } from "lucide-react";

export function SkillAddMenu({
  disabled,
  importDisabled,
  onCreate,
  onImport,
}: {
  disabled: boolean;
  importDisabled: boolean;
  onCreate?: () => void;
  onImport: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const unavailable = disabled || (importDisabled && !onCreate);
  const open = expanded && !unavailable;
  const close = useCallback((restoreFocus = true) => {
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (unavailable) setExpanded(false);
  }, [unavailable]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8),
      ),
      top: Math.max(
        8,
        Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8),
      ),
    });
    menu.current
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === "Tab") close();
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const items = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        items[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length
        ]?.focus();
      }
    };
    const dismiss = () => close(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [open, close]);
  function choose(action: () => void) {
    // The import modal must restore focus to the surviving toolbar trigger.
    close();
    action();
  }
  return (
    <>
      <button
        ref={trigger}
        className="primary skills-add"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={unavailable}
        onClick={() => {
          trigger.current?.focus();
          setExpanded(!open);
        }}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setExpanded(true);
          }
        }}
      >
        添加 <ChevronDown size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label="添加技能"
            className="project-context-menu skill-add-menu"
            style={position}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!onCreate}
              onClick={() => onCreate && choose(onCreate)}
            >
              <Box size={16} />
              创建技能
            </button>
            <div role="separator" />
            <button
              type="button"
              role="menuitem"
              disabled={importDisabled}
              onClick={() => choose(onImport)}
            >
              <FolderInput size={16} />
              导入技能
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
