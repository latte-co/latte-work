import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps, PointerEvent } from "react";

/** A temporary overlay never changes the saved sidebar layout. */
export function useSidebarPreview({
  open,
  enabled,
  interactionLocked,
  toggle,
}: {
  open: boolean;
  enabled: boolean;
  interactionLocked: boolean;
  toggle: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const pointerInside = useRef(false);
  const focusAfterPin = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef({ open, enabled, interactionLocked });
  current.current = { open, enabled, interactionLocked };
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const leave = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (
        !pointerInside.current &&
        !current.current.interactionLocked &&
        !panel.current?.contains(document.activeElement)
      )
        setPreview(false);
    }, 150);
  }, [cancel]);
  const dismiss = useCallback(() => {
    cancel();
    pointerInside.current = false;
    setPreview(false);
  }, [cancel]);
  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    if (open || !enabled) dismiss();
    if (open && focusAfterPin.current) {
      focusAfterPin.current = false;
      panel.current
        ?.querySelector<HTMLButtonElement>("[data-sidebar-toggle]")
        ?.focus();
    }
  }, [open, enabled, dismiss]);
  useEffect(() => {
    if (!preview) return;
    if (interactionLocked) cancel();
    else if (!pointerInside.current) leave();
  }, [interactionLocked, preview, cancel, leave]);
  const visible = preview && enabled && !open;
  useEffect(() => {
    if (!visible) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        !current.current.interactionLocked &&
        target instanceof Element &&
        !panel.current?.contains(target) &&
        !target.closest("[data-sidebar-trigger]")
      )
        dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        current.current.interactionLocked
      )
        return;
      event.preventDefault();
      const restoreFocus = panel.current?.contains(document.activeElement);
      dismiss();
      if (restoreFocus && trigger.current?.isConnected) trigger.current.focus();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", dismiss);
    };
  }, [visible, dismiss]);
  const pin = () => {
    dismiss();
    focusAfterPin.current = true;
    toggle();
  };
  const triggerProps: Pick<
    ComponentProps<"button">,
    "onPointerEnter" | "onPointerLeave" | "onClick"
  > = {
    onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "touch") return;
      trigger.current = event.currentTarget;
      pointerInside.current = true;
      cancel();
      if (current.current.open || !current.current.enabled) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!current.current.open && current.current.enabled) setPreview(true);
      }, 200);
    },
    onPointerLeave: () => {
      pointerInside.current = false;
      leave();
    },
    onClick: pin,
  };
  const panelProps: Pick<
    ComponentProps<"aside">,
    "onPointerEnter" | "onPointerLeave" | "onFocusCapture" | "onBlurCapture"
  > = {
    onPointerEnter: () => {
      pointerInside.current = true;
      cancel();
    },
    onPointerLeave: () => {
      pointerInside.current = false;
      leave();
    },
    onFocusCapture: cancel,
    onBlurCapture: (event) => {
      if (!panel.current?.contains(event.relatedTarget)) leave();
    },
  };
  return { visible, panel, pin, triggerProps, panelProps };
}

export type SidebarPreview = ReturnType<typeof useSidebarPreview>;
