// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHistoryLoadingIndicator } from "./useHistoryLoadingIndicator";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const mount = () =>
  renderHook(({ active, scope }) => useHistoryLoadingIndicator(active, scope), {
    initialProps: { active: true, scope: "local:a" },
  });

it("never shows feedback for a fast load", () => {
  const view = mount();
  advance(299);
  expect(view.result.current.visible).toBeFalsy();
  view.rerender({ active: false, scope: "local:a" });
  advance(6000);
  expect(view.result.current.visible).toBeFalsy();
});

it("keeps dots visible for at least 300ms without delaying content", () => {
  const view = mount();
  advance(300);
  expect(view.result.current).toEqual({ visible: true });
  advance(50);
  view.rerender({ active: false, scope: "local:a" });
  advance(249);
  expect(view.result.current.visible).toBe(true);
  advance(1);
  expect(view.result.current.visible).toBeFalsy();
});

it("keeps the same feedback through a slow load and clears when ready", () => {
  const view = mount();
  advance(4999);
  expect(view.result.current).toEqual({ visible: true });
  advance(1);
  expect(view.result.current).toEqual({ visible: true });
  view.rerender({ active: false, scope: "local:a" });
  expect(view.result.current.visible).toBeFalsy();
});

it("resets timing across sessions and hosts and cancels timers on unmount", () => {
  const view = mount();
  advance(5000);
  view.rerender({ active: true, scope: "remote:a" });
  expect(view.result.current.visible).toBeFalsy();
  advance(299);
  expect(view.result.current.visible).toBeFalsy();
  advance(1);
  expect(view.result.current).toEqual({ visible: true });
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
