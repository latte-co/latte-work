import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

const STORAGE_KEY = "latte-work.file-tree-width.v1";
const DEFAULT_WIDTH = 240;

function savedWidth() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(value) && value > 0 && value <= 4096) return value;
  } catch {
    // Resizing remains available when local storage is unavailable.
  }
  return DEFAULT_WIDTH;
}

export function useFileTreeWidth(enabled: boolean) {
  const container = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(savedWidth);
  const [available, setAvailable] = useState(0);
  const cleanup = useRef<(() => void) | null>(null);
  // Preserve at least 120px for the preview, or half of a very narrow pane.
  const maximum =
    available > 0
      ? Math.max(0, available - Math.min(120, available / 2) - 1)
      : DEFAULT_WIDTH;
  const minimum = Math.min(160, maximum);
  const bounds = useRef({ minimum, maximum });
  bounds.current = { minimum, maximum };
  const width = Math.round(Math.max(minimum, Math.min(maximum, preferred)));

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setAvailable(element.clientWidth);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(preferred));
    } catch {
      // A storage failure must not interrupt the current resize gesture.
    }
  }, [preferred]);
  useEffect(() => {
    if (!enabled) cleanup.current?.();
    return () => cleanup.current?.();
  }, [enabled]);

  function change(value: number) {
    const { minimum, maximum } = bounds.current;
    setPreferred(Math.round(Math.max(minimum, Math.min(maximum, value))));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    cleanup.current?.();
    const handle = event.currentTarget;
    handle.focus();
    handle.dataset.resizing = "true";
    const startX = event.clientX;
    const startWidth = width;
    const pointerId = event.pointerId;
    const { userSelect, webkitUserSelect } = document.body.style;
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    window.getSelection()?.removeAllRanges();
    handle.setPointerCapture(pointerId);
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId)
        change(startWidth + startX - next.clientX);
    };
    const stop = () => {
      delete handle.dataset.resizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", stop);
      handle.removeEventListener("lostpointercapture", stop);
      if (handle.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId);
      document.body.style.userSelect = userSelect;
      document.body.style.webkitUserSelect = webkitUserSelect;
      cleanup.current = null;
    };
    const end = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", stop);
    handle.addEventListener("lostpointercapture", stop);
    cleanup.current = stop;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!enabled) return;
    const next =
      event.key === "ArrowLeft"
        ? width + 16
        : event.key === "ArrowRight"
          ? width - 16
          : event.key === "Home"
            ? minimum
            : event.key === "End"
              ? maximum
              : null;
    if (next === null) return;
    event.preventDefault();
    change(next);
  }

  return { container, width, minimum, maximum, onPointerDown, onKeyDown };
}
