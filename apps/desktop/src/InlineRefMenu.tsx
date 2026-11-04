import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type InlineRefMenuItem =
  | { key: string; separator: true }
  | {
      key: string;
      label: string;
      icon?: ReactNode;
      run: () => void;
    };

/**
 * Context menu for inline reference chips. Same interaction contract as the
 * shared link menu: viewport-clamped position, outside-pointer and Escape
 * close, full arrow/home/end navigation.
 */
export function InlineRefMenu({
  point,
  label,
  items,
  close,
}: {
  point: { x: number; y: number };
  label: string;
  items: InlineRefMenuItem[];
  close: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(point);
  useLayoutEffect(() => {
    const box = menu.current!.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(point.x, window.innerWidth - box.width - 8)),
      y: Math.max(8, Math.min(point.y, window.innerHeight - box.height - 8)),
    });
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [point]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === "Tab") close();
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [
          ...menu.current!.querySelectorAll<HTMLButtonElement>("button"),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length
        ]?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [close]);
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className="project-context-menu link-context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item) =>
        "separator" in item ? (
          <div key={item.key} role="separator" />
        ) : (
          <button
            key={item.key}
            role="menuitem"
            onClick={() => {
              close();
              item.run();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
