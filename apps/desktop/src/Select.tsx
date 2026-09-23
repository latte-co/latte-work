import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}
/** Application-owned popover: native WebKit menus cannot inherit the dark theme. */
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  minMenuWidth,
  align = "start",
  compact = false,
  menuTitle,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  minMenuWidth?: number;
  align?: "start" | "end";
  compact?: boolean;
  menuTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 280,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  function show() {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }
  function choose(index: number) {
    if (options[index]) onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const height = Math.min(
      320,
      options.length * (compact ? 36 : 56) + 10 + (menuTitle ? 28 : 0),
    );
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const useBelow = below >= height || below >= above;
    const maxHeight = Math.max(60, Math.min(height, useBelow ? below : above));
    const width = Math.min(
      Math.max(box.width, minMenuWidth ?? 0),
      window.innerWidth - 16,
    );
    setPosition({
      left: Math.max(
        8,
        Math.min(
          align === "end" ? box.right - width : box.left,
          window.innerWidth - width - 8,
        ),
      ),
      top: useBelow ? box.bottom + 6 : box.top - maxHeight - 6,
      width,
      maxHeight,
    });
  }, [open, options.length, minMenuWidth, align, compact, menuTitle]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (
        !trigger.current?.contains(e.target as Node) &&
        !menu.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const resize = () => setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (
        ![
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
          "Enter",
          " ",
          "Escape",
          "Tab",
        ].includes(e.key)
      )
        return;
      e.stopImmediatePropagation();
      if (e.key === "Tab") {
        setOpen(false);
        return;
      }
      e.preventDefault();
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "Enter" || e.key === " ") choose(active);
      else
        setActive(
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? options.length - 1
              : (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                options.length,
        );
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, active, options, onChange]);
  useEffect(() => {
    menu.current
      ?.querySelectorAll<HTMLElement>('[role="option"]')
      [active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span>{options.find((o) => o.value === value)?.label ?? "请选择"}</span>
        <ChevronDown size={15} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="listbox"
            aria-label={label}
            className={`select-popover${compact ? " compact" : ""}`}
            style={position}
            onMouseDown={(e) => e.preventDefault()}
          >
            {menuTitle && (
              <div className="select-menu-title" role="presentation">
                {menuTitle}
              </div>
            )}
            {options.map((o, index) => (
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                id={`${id}-${index}`}
                tabIndex={-1}
                key={o.value}
                title={compact ? o.label : undefined}
                className={active === index ? "highlighted" : ""}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span>
                  {o.label}
                  {o.description && <small>{o.description}</small>}
                </span>
                {o.value === value && <Check size={15} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
