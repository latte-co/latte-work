// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionHoverCard } from "./SidebarHoverCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function renderCard(onClick = vi.fn()) {
  return render(
    <SessionHoverCard
      title="A complete conversation title"
      project="Project"
      host="Devbox"
      taskStatus="已完成"
      agentState="open"
    >
      <button onClick={onClick}>Conversation</button>
    </SessionHoverCard>,
  );
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("delays brief hovers and stays readable while the pointer enters the card", () => {
  vi.useFakeTimers();
  const onClick = vi.fn();
  const view = renderCard(onClick);
  const row = screen.getByRole("button", { name: "Conversation" });
  fireEvent.mouseEnter(row);
  advance(200);
  fireEvent.mouseLeave(row);
  advance(400);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(row);
  advance(350);
  const info = screen.getByRole("tooltip");
  expect(within(info).getByText("A complete conversation title")).toBeTruthy();
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.mouseLeave(row);
  advance(50);
  fireEvent.mouseEnter(info);
  advance(1000);
  expect(screen.getByRole("tooltip")).toBe(info);
  fireEvent.mouseLeave(info);
  advance(100);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(row);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("describes keyboard focus, dismisses on Escape and does not cover activation", () => {
  vi.useFakeTimers();
  const onClick = vi.fn();
  renderCard(onClick);
  const row = screen.getByRole("button", { name: "Conversation" });
  fireEvent.focus(row);
  advance(350);
  expect(row.getAttribute("aria-describedby")).toBe(
    screen.getByRole("tooltip").id,
  );
  fireEvent.keyDown(row, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(row.getAttribute("aria-describedby")).toBeNull();
  fireEvent.blur(row);
  fireEvent.focus(row);
  advance(350);
  fireEvent.click(row);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("fits near the window edges and dismisses when the view moves", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const tip = this.classList.contains("sidebar-hover-card");
      return {
        x: 900,
        y: 740,
        left: 900,
        top: 740,
        right: tip ? 1240 : 1020,
        bottom: tip ? 870 : 770,
        width: tip ? 340 : 120,
        height: tip ? 130 : 30,
        toJSON: () => ({}),
      };
    },
  );
  renderCard();
  const row = screen.getByRole("button", { name: "Conversation" });
  fireEvent.mouseEnter(row);
  advance(350);
  const info = screen.getByRole("tooltip");
  const left = Number.parseFloat(info.style.left);
  const top = Number.parseFloat(info.style.top);
  expect(left).toBeGreaterThanOrEqual(8);
  expect(left + 340).toBeLessThanOrEqual(window.innerWidth - 8);
  expect(top + 130).toBeLessThanOrEqual(window.innerHeight - 8);
  fireEvent.scroll(document);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(row);
  advance(350);
  fireEvent.resize(window);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
