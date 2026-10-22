import { useLayoutEffect, useRef, type ComponentProps } from "react";

const stack: HTMLElement[] = [];
// Different dialogs may suspend the same background node. A previous-value
// snapshot per dialog would restore stale inert=true when both close together.
const inertOwners = new Map<
  HTMLElement,
  { count: number; previous: boolean }
>();
const canFocus = (item: HTMLElement) =>
  item.tabIndex >= 0 &&
  !item.matches(":disabled") &&
  !item.closest("[hidden], [inert]") &&
  getComputedStyle(item).display !== "none" &&
  getComputedStyle(item).visibility !== "hidden" &&
  (!item.closest("details:not([open])") || item.tagName === "SUMMARY");
const focusable =
  "button, input, textarea, select, a[href], summary, [tabindex]";
/** Native modal behavior shared by every dialog. Nested dialogs suspend their parent. */
export function Modal(props: ComponentProps<"section">) {
  const root = useRef<HTMLElement>(null);
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const element = root.current!;
    stack.push(element);
    const ancestors: HTMLElement[] = [];
    for (
      let node = trigger.current?.parentElement;
      node && node !== document.body;
      node = node.parentElement
    )
      ancestors.push(node);
    const inert: HTMLElement[] = [];
    let branch: HTMLElement = element;
    while (branch.parentElement) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          const owner = inertOwners.get(sibling) ?? {
            count: 0,
            previous: !!sibling.inert,
          };
          owner.count++;
          inertOwners.set(sibling, owner);
          inert.push(sibling);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const candidates = () =>
      Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter(
        canFocus,
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
      for (const item of inert) {
        const owner = inertOwners.get(item)!;
        if (--owner.count === 0) {
          // A page transition may already have removed inert explicitly.
          if (item.inert) item.inert = owner.previous;
          inertOwners.delete(item);
        }
      }
      const target = trigger.current;
      if (target?.isConnected && canFocus(target)) {
        target.focus();
      } else {
        // Wait for the closing subtree to be removed and all inert leases released.
        // A surviving parent dialog or the trigger's nearest live section is the
        // logical fallback; preserve any focus explicitly moved by the caller.
        queueMicrotask(() => {
          const active = document.activeElement;
          if (
            active instanceof HTMLElement &&
            active !== document.body &&
            active.isConnected &&
            !element.contains(active) &&
            canFocus(active)
          )
            return;
          const parent = stack.at(-1);
          const regions = parent ? [parent] : ancestors;
          for (const region of regions) {
            if (!region.isConnected || region.closest("[hidden], [inert]"))
              continue;
            const candidate = Array.from(
              region.querySelectorAll<HTMLElement>(focusable),
            ).find(canFocus);
            if (candidate) {
              candidate.focus();
              return;
            }
          }
        });
      }
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
