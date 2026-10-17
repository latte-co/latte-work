import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";
import type { Effort } from "./protocol";
import type { SelectOption } from "./Select";

export interface ModelSelectorHandle {
  openMenu: (target: "model" | "effort") => boolean;
}

/** A model menu with an Agent-owned reasoning submenu. */
export function ModelSelector({
  value,
  options,
  onChange,
  effort,
  levels,
  onEffortChange,
  disabled,
  ref,
}: {
  value: string;
  options: (SelectOption & { variants?: SelectOption[] })[];
  onChange: (value: string) => void;
  effort: Effort | null;
  levels: Effort[];
  onEffortChange: (value: Effort | null) => void;
  disabled: boolean;
  ref?: Ref<ModelSelectorHandle>;
}) {
  useImperativeHandle(ref, () => ({
    openMenu(target) {
      if (disabled || (target === "effort" && !levels.length)) return false;
      setOpen(true);
      showSubmenu(target === "effort" ? "effort" : null, target === "effort");
      return true;
    },
  }));
  const [open, setOpen] = useState(false);
  const [submenuTarget, setSubmenuTarget] = useState<string | null>(null);
  const reasoning = submenuTarget === "effort";
  const variantOptions = options.find(
    (o) => `model:${o.value}` === submenuTarget,
  )?.variants;
  const submenuOpen = reasoning || !!variantOptions?.length;
  const focusSubmenu = useRef(false);
  const anchor = () =>
    reasoning
      ? footer.current
      : Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>(
            "[data-variant-model]",
          ) ?? [],
        ).find(
          (button) => `model:${button.dataset.variantModel}` === submenuTarget,
        );
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 200,
    maxHeight: 320,
  });
  const [subPosition, setSubPosition] = useState({
    left: 0,
    top: 0,
    maxHeight: 280,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected =
    options
      .flatMap((o) =>
        o.variants?.length
          ? o.variants.map((v) => ({
              value: v.value,
              label: `${o.label} / ${v.label}`,
            }))
          : [o],
      )
      .find((o) => o.value === value)?.label ?? value;
  const effortValue = effort && levels.includes(effort) ? effort : "跟随 Agent";
  function close(restoreFocus = true) {
    setOpen(false);
    showSubmenu(null);
    if (restoreFocus) trigger.current?.focus();
  }
  function focusSubmenuItem() {
    (
      submenu.current?.querySelector<HTMLButtonElement>(
        '[aria-checked="true"]',
      ) ??
      submenu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus();
  }
  function showSubmenu(target: string | null, moveFocus = false) {
    focusSubmenu.current = moveFocus;
    setSubmenuTarget(target);
    if (moveFocus && target === submenuTarget && submenu.current) {
      focusSubmenuItem();
      focusSubmenu.current = false;
    }
  }
  function showReasoning(moveFocus = false) {
    if (levels.length) showSubmenu("effort", moveFocus);
  }
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      showSubmenu(null);
    }
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const height = Math.min(320, options.length * 36 + 84);
    const above = Math.max(0, box.top - 14);
    const below = Math.max(0, window.innerHeight - box.bottom - 14);
    const up = above >= height || above >= below;
    const maxHeight = Math.min(height, up ? above : below);
    const width = Math.min(200, window.innerWidth - 16);
    setPosition({
      left: Math.max(
        8,
        Math.min(box.right - width, window.innerWidth - width - 8),
      ),
      top: up ? box.top - maxHeight - 6 : box.bottom + 6,
      width,
      maxHeight,
    });
    menu.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
  }, [open, options.length]);
  useLayoutEffect(() => {
    const source = anchor();
    if (!submenuOpen || !source || !menu.current) return;
    const row = source.getBoundingClientRect();
    const parent = menu.current.getBoundingClientRect();
    const maxHeight = Math.min(
      (reasoning ? levels.length + 1 : (variantOptions?.length ?? 0)) * 36 + 10,
      window.innerHeight - 16,
    );
    const width = reasoning ? 140 : 220;
    setSubPosition({
      left: Math.max(
        8,
        Math.min(
          parent.left >= width + 8 ? parent.left - width : parent.right,
          window.innerWidth - width - 8,
        ),
      ),
      top: Math.max(
        8,
        Math.min(row.bottom - maxHeight, window.innerHeight - maxHeight - 8),
      ),
      maxHeight,
    });
    if (focusSubmenu.current) {
      focusSubmenuItem();
      focusSubmenu.current = false;
    }
  }, [submenuTarget, levels.length, position]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (
        ![trigger.current, menu.current, submenu.current].some((el) =>
          el?.contains(e.target as Node),
        )
      )
        close(false);
    };
    const resize = () => close();
    const key = (e: KeyboardEvent) => {
      if (
        ![
          "ArrowDown",
          "ArrowUp",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
          "Escape",
          "Tab",
          "Enter",
          " ",
        ].includes(e.key)
      )
        return;
      e.stopImmediatePropagation();
      if (e.key === "Tab") {
        close(false);
        return;
      }
      e.preventDefault();
      if (e.key === "Escape" || e.key === "ArrowLeft") {
        if (submenuOpen) {
          anchor()?.focus();
          showSubmenu(null);
        } else if (e.key === "Escape") close();
        return;
      }
      if (e.key === "ArrowRight") {
        if (document.activeElement === footer.current) showReasoning(true);
        else {
          const model = (document.activeElement as HTMLElement)?.dataset
            .variantModel;
          if (model) showSubmenu(`model:${model}`, true);
        }
        return;
      }
      const inSubmenu = submenu.current?.contains(document.activeElement);
      const root = inSubmenu ? submenu.current : menu.current;
      const buttons = Array.from(
        root?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
          [],
      );
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (e.key === "Enter" || e.key === " ") {
        buttons[index]?.click();
        return;
      }
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length;
      buttons[next]?.focus();
      buttons[next]?.scrollIntoView({ block: "nearest" });
      if (!inSubmenu) showSubmenu(null);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, submenuTarget, levels.length, options]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        aria-label="Model and reasoning effort"
        title={selected}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected}</span>
        {levels.length > 0 && (
          <span className="model-effort-value">{effortValue}</span>
        )}
        <ChevronDown size={15} />
      </button>
      {open &&
        createPortal(
          <>
            <div
              ref={menu}
              id={id}
              role="menu"
              aria-label="Model"
              className="select-popover compact model-menu"
              style={position}
            >
              <div className="select-menu-title" role="presentation">
                Model
              </div>
              <div className="model-menu-options" role="presentation">
                {options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemradio"
                    data-variant-model={
                      o.variants?.length ? o.value : undefined
                    }
                    aria-haspopup={o.variants?.length ? "menu" : undefined}
                    aria-expanded={
                      o.variants?.length
                        ? submenuTarget === `model:${o.value}`
                        : undefined
                    }
                    aria-controls={
                      !!o.variants?.length &&
                      submenuTarget === `model:${o.value}`
                        ? `${id}-variants`
                        : undefined
                    }
                    aria-checked={
                      o.value === value ||
                      !!o.variants?.some((v) => v.value === value)
                    }
                    title={
                      o.description
                        ? `${o.label} · ${o.description}`
                        : o.value && o.value !== o.label
                          ? `${o.label} · ${o.value}`
                          : o.label
                    }
                    tabIndex={-1}
                    onMouseEnter={(e) => {
                      showSubmenu(
                        o.variants?.length ? `model:${o.value}` : null,
                      );
                      e.currentTarget.focus();
                    }}
                    onClick={() => {
                      if (o.variants?.length)
                        showSubmenu(`model:${o.value}`, true);
                      else {
                        onChange(o.value);
                        close();
                      }
                    }}
                  >
                    <span className="model-option-name">{o.label}</span>
                    {!!o.variants?.length && (
                      <ChevronRight size={15} aria-hidden="true" />
                    )}
                    {o.description && (
                      <span className="model-option-alias">
                        {o.description}
                      </span>
                    )}
                    <Check
                      size={15}
                      className="model-option-check"
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
              <div className="model-menu-divider" role="separator" />
              <button
                ref={footer}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={reasoning}
                aria-controls={reasoning ? `${id}-effort` : undefined}
                disabled={!levels.length}
                title={
                  levels.length
                    ? "Options supported by the current Agent and model"
                    : "Not supported by this Agent and model"
                }
                className="model-menu-effort"
                tabIndex={-1}
                onMouseEnter={(e) => {
                  showReasoning();
                  e.currentTarget.focus();
                }}
                onClick={() => showReasoning(true)}
              >
                <SlidersHorizontal size={16} />
                <span>Effort</span>
                <span className="model-effort-value">
                  {levels.length ? effortValue : "—"}
                </span>
                <ChevronRight size={15} />
              </button>
            </div>
            {submenuOpen && (
              <div
                ref={submenu}
                id={`${id}-${reasoning ? "effort" : "variants"}`}
                role="menu"
                aria-label={reasoning ? "Reasoning effort" : "Model mode"}
                className="select-popover compact model-effort-menu"
                style={{ ...subPosition, width: reasoning ? 140 : 220 }}
              >
                {variantOptions?.map((variant) => (
                  <button
                    key={variant.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={variant.value === value}
                    tabIndex={-1}
                    aria-label={[variant.label, variant.description]
                      .filter(Boolean)
                      .join(" ")}
                    title={[variant.label, variant.description]
                      .filter(Boolean)
                      .join(" · ")}
                    onMouseEnter={(e) => e.currentTarget.focus()}
                    onClick={() => {
                      onChange(variant.value);
                      close();
                    }}
                  >
                    <span>{variant.label}</span>
                    {variant.description && (
                      <span className="model-effort-value">
                        {variant.description}
                      </span>
                    )}
                    <Check
                      size={15}
                      className="model-option-check"
                      aria-hidden="true"
                    />
                  </button>
                ))}
                {reasoning &&
                  ([null, ...levels] as (Effort | null)[]).map((level) => (
                    <button
                      key={level ?? "auto"}
                      type="button"
                      role="menuitemradio"
                      aria-checked={
                        level === effort || (!effort && level === null)
                      }
                      tabIndex={-1}
                      onMouseEnter={(e) => e.currentTarget.focus()}
                      onClick={() => {
                        onEffortChange(level);
                        close();
                      }}
                    >
                      <span>{level ?? "跟随 Agent"}</span>
                      <Check
                        size={15}
                        className="model-option-check"
                        aria-hidden="true"
                      />
                    </button>
                  ))}
              </div>
            )}
          </>,
          document.body,
        )}
    </>
  );
}
