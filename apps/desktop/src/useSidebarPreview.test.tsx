// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSidebarPreview } from "./useSidebarPreview";
import { SidebarToggle } from "./SidebarToggle";

const toggle = vi.fn();
function Harness({ enabled = true, locked = false }) {
  const [open, setOpen] = useState(false);
  const preview = useSidebarPreview({
    open,
    enabled,
    interactionLocked: locked,
    toggle: () => {
      toggle();
      setOpen((old) => !old);
    },
  });
  return (
    <>
      {!open && <SidebarToggle toggle={toggle} preview={preview} />}
      <aside
        ref={preview.panel}
        aria-label="导航"
        hidden={!open && !preview.visible}
        {...preview.panelProps}
      >
        <button
          data-sidebar-toggle
          onClick={open ? () => setOpen(false) : preview.pin}
        >
          {open ? "收起侧栏" : "固定侧栏"}
        </button>
        <button>对话</button>
      </aside>
      <button>正文</button>
      <output>{open ? "已固定" : "未固定"}</output>
    </>
  );
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const sidebar = () => screen.getByLabelText("导航");
const hover = () => {
  const trigger = screen.getByRole("button", { name: "展开侧栏" });
  fireEvent.pointerEnter(trigger);
  advance(200);
  return trigger;
};
beforeEach(() => {
  vi.useFakeTimers();
  toggle.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("delays hover preview, cancels brief passes, and never pins through hover", () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "展开侧栏" });
  fireEvent.pointerEnter(trigger);
  advance(199);
  expect(sidebar().hidden).toBe(true);
  fireEvent.pointerLeave(trigger);
  advance(500);
  expect(sidebar().hidden).toBe(true);
  fireEvent.pointerEnter(trigger);
  advance(200);
  expect(sidebar().hidden).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("未固定")).toBeTruthy();
  expect(toggle).not.toHaveBeenCalled();
});

it("allows crossing into the overlay and closes after leaving both regions", () => {
  render(<Harness />);
  const trigger = hover();
  fireEvent.pointerLeave(trigger);
  advance(100);
  fireEvent.pointerEnter(sidebar());
  advance(500);
  expect(sidebar().hidden).toBe(false);
  fireEvent.pointerLeave(sidebar());
  advance(149);
  expect(sidebar().hidden).toBe(false);
  advance(1);
  expect(sidebar().hidden).toBe(true);
});

it("holds keyboard focus inside, then dismisses when focus and pointer leave", () => {
  render(<Harness />);
  const trigger = hover();
  fireEvent.pointerLeave(trigger);
  const conversation = screen.getByRole("button", { name: "对话" });
  act(() => conversation.focus());
  advance(1000);
  expect(sidebar().hidden).toBe(false);
  act(() => screen.getByRole("button", { name: "正文" }).focus());
  advance(150);
  expect(sidebar().hidden).toBe(true);
});

it("keeps portal menu interactions open and lets their Escape handler run first", () => {
  const view = render(<Harness />);
  const trigger = hover();
  view.rerender(<Harness locked />);
  fireEvent.pointerLeave(trigger);
  advance(1000);
  fireEvent.pointerDown(screen.getByRole("button", { name: "正文" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(sidebar().hidden).toBe(false);
  view.rerender(<Harness />);
  advance(150);
  expect(sidebar().hidden).toBe(true);
});

it("Escape restores the opener focus; outside clicks dismiss without stealing focus", () => {
  render(<Harness />);
  const trigger = hover();
  act(() => screen.getByRole("button", { name: "对话" }).focus());
  fireEvent.keyDown(window, { key: "Escape" });
  expect(sidebar().hidden).toBe(true);
  expect(document.activeElement).toBe(trigger);
  hover();
  const body = screen.getByRole("button", { name: "正文" });
  act(() => body.focus());
  fireEvent.pointerDown(body);
  expect(sidebar().hidden).toBe(true);
  expect(document.activeElement).toBe(body);
});

it("clicks pin immediately and the pinned sidebar survives pointer leave and Escape", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(screen.getByText("已固定")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "收起侧栏" }),
  );
  fireEvent.pointerLeave(sidebar());
  advance(500);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(sidebar().hidden).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
  hover();
  fireEvent.click(sidebar().querySelector("[data-sidebar-toggle]")!);
  expect(screen.getByText("已固定")).toBeTruthy();
  expect(toggle).toHaveBeenCalledTimes(2);
});

it("disables preview for dialogs and cancels pending work when hidden or unmounted", () => {
  const view = render(<Harness />);
  hover();
  view.rerender(<Harness enabled={false} />);
  expect(sidebar().hidden).toBe(true);
  fireEvent.pointerEnter(screen.getByRole("button", { name: "展开侧栏" }));
  advance(500);
  expect(sidebar().hidden).toBe(true);
  view.rerender(<Harness />);
  fireEvent.pointerEnter(screen.getByRole("button", { name: "展开侧栏" }));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not open on keyboard focus alone and hides when the window loses focus", () => {
  render(<Harness />);
  act(() => screen.getByRole("button", { name: "展开侧栏" }).focus());
  advance(1000);
  expect(sidebar().hidden).toBe(true);
  hover();
  fireEvent.blur(window);
  expect(sidebar().hidden).toBe(true);
});
