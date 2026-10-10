import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  tone?: "warning";
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
  searchable = false,
  searchPlaceholder = "搜索选项",
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
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = searchable
    ? options.filter((option) =>
        `${option.label} ${option.description ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : options;
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 280,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  function show() {
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }
  function choose(index: number) {
    if (!filtered[index]) return;
    onChange(filtered[index].value);
    setOpen(false);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const height = Math.min(
      320,
      Math.max(1, filtered.length) * (compact ? 36 : 56) +
        10 +
        (menuTitle ? 28 : 0) +
        (searchable ? 44 : 0),
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
  }, [
    open,
    filtered.length,
    minMenuWidth,
    align,
    compact,
    menuTitle,
    searchable,
  ]);
  useEffect(() => {
    if (open && searchable) search.current?.focus();
  }, [open, searchable]);
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
      if (e.isComposing) return;
      if (e.target === search.current && [" ", "Home", "End"].includes(e.key))
        return;
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
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      } else if (e.key === "Enter" || e.key === " ") choose(active);
      else if (filtered.length)
        setActive(
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? filtered.length - 1
              : (active + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                filtered.length,
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
  }, [open, active, filtered, onChange]);
  useEffect(() => {
    menu.current
      ?.querySelectorAll<HTMLElement>('[role="option"]')
      [active]?.scrollIntoView({ block: "nearest" });
  }, [active, query]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        title={options.find((option) => option.value === value)?.label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={
          open && filtered.length ? `${id}-${active}` : undefined
        }
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
            title={options.find((option) => option.value === value)?.label}
            className={`select-popover${compact ? " compact" : ""}`}
            style={position}
            onMouseDown={(e) => {
              if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
            }}
          >
            {searchable && (
              <label className="select-search">
                <Search size={15} />
                <input
                  ref={search}
                  role="combobox"
                  aria-label={searchPlaceholder}
                  aria-controls={id}
                  aria-expanded={true}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    filtered.length ? `${id}-${active}` : undefined
                  }
                  placeholder={searchPlaceholder}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                />
              </label>
            )}
            {menuTitle && (
              <div className="select-menu-title" role="presentation">
                {menuTitle}
              </div>
            )}
            <div id={id} role="listbox" aria-label={label}>
              {filtered.map((o, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  id={`${id}-${index}`}
                  tabIndex={-1}
                  key={o.value}
                  title={compact ? o.label : undefined}
                  className={[
                    active === index ? "highlighted" : "",
                    o.tone ?? "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
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
            </div>
            {!filtered.length && (
              <p className="select-no-results" role="status">
                没有匹配的选项
              </p>
            )}
          </div>,
          trigger.current?.closest<HTMLElement>('[role="dialog"]') ??
            document.body,
        )}
    </>
  );
}
