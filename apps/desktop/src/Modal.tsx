import { useLayoutEffect, useRef, type ComponentProps } from "react";

const stack: HTMLElement[] = [];
const focusable =
  "button, input, textarea, select, a[href], summary, [tabindex]";
/** Native modal behavior shared by every dialog. Nested dialogs suspend their parent. */
export function Modal(props: ComponentProps<"section">) {
  const root = useRef<HTMLElement>(null);
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const element = root.current!;
    stack.push(element);
    const inert: { element: HTMLElement; previous: boolean }[] = [];
    let branch: HTMLElement = element;
    while (branch.parentElement) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          inert.push({ element: sibling, previous: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const candidates = () =>
      Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter(
        (item) =>
          item.tabIndex >= 0 &&
          !item.matches(":disabled") &&
          !item.closest("[hidden], [inert]") &&
          getComputedStyle(item).display !== "none" &&
          getComputedStyle(item).visibility !== "hidden" &&
          (!item.closest("details:not([open])") || item.tagName === "SUMMARY"),
      );
    if (!element.contains(document.activeElement))
      (candidates()[0] ?? element).focus();
    const key = (event: KeyboardEvent) => {
      if (
        stack.at(-1) !== element ||
        event.key !== "Tab" ||
        event.defaultPrevented
      )
        return;
      const items = candidates();
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      (
        items[
          (index + (event.shiftKey ? -1 : 1) + items.length) % items.length
        ] ?? element
      ).focus();
    };
    const focus = (event: FocusEvent) => {
      if (stack.at(-1) === element && !element.contains(event.target as Node))
        (candidates()[0] ?? element).focus();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", focus);
    return () => {
      stack.splice(stack.indexOf(element), 1);
      document.removeEventListener("keydown", key);
      document.removeEventListener("focusin", focus);
      for (const item of inert) item.element.inert = item.previous;
      const target = trigger.current;
      if (target?.isConnected && !target.closest("[hidden], [inert]"))
        target.focus();
    };
  }, []);
  return (
    <section
      {...props}
      ref={root}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    />
  );
}
