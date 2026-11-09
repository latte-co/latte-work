import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Hover tooltip for inline reference chips: the full path (resolved against
 * the project root when known) plus a muted action hint. Portal-rendered and
 * clamped to the viewport like the context menus and sidebar hover cards; the
 * chip positions it below and flips above when space runs out.
 */
export function InlineRefTooltip({
  anchor,
  id,
  primary,
  secondary,
}: {
  anchor: DOMRect;
  id: string;
  primary: string;
  secondary: string;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect();
    if (!box) return;
    const below = anchor.bottom + 6;
    setPosition({
      left: Math.max(
        8,
        Math.min(
          anchor.left + anchor.width / 2 - box.width / 2,
          window.innerWidth - box.width - 8,
        ),
      ),
      top:
        below + box.height <= window.innerHeight - 8
          ? below
          : Math.max(8, anchor.top - box.height - 6),
    });
  }, [anchor]);
  return createPortal(
    <div
      ref={card}
      id={id}
      role="tooltip"
      className="inline-ref-tooltip"
      style={{
        left: position?.left,
        top: position?.top,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <span className="inline-ref-tooltip-path">{primary}</span>
      <span className="inline-ref-tooltip-hint">{secondary}</span>
    </div>,
    document.body,
  );
}
