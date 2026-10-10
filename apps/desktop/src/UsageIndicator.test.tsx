// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { UsageIndicator, usageSnapshot, cacheRate } from "./UsageIndicator";
import { transcript } from "./transcript";
import type { Event, EventKind, TurnUsage } from "./protocol";
afterEach(cleanup);
const event = (seq: number, value: EventKind, session_id = "s"): Event => ({
  seq,
  at: 0,
  session_id,
  event: value,
});
const totals: TurnUsage = {
  input_tokens: 100,
  cache_read_tokens: 600,
  cache_write_tokens: 300,
  output_tokens: 20,
  model_time_ms: 1000,
  steps: 3,
};
const usage: EventKind = {
  kind: "usage",
  context: { model: "test", used_tokens: 1000, window_tokens: 2000 },
  totals,
};
it("uses latest snapshot, isolates sessions and clears current-turn totals on send", () => {
  const events = [event(1, usage), event(2, usage)];
  expect(usageSnapshot(events, "s").context?.used_tokens).toBe(1000);
  expect(usageSnapshot(events, "other").context).toBeNull();
  expect(usageSnapshot(events).context).toBeNull();
  events.push(event(3, { kind: "user", text: "next", request_id: "r" }));
  expect(usageSnapshot(events, "s")).toEqual({
    context: usage.context,
    totals: null,
  });
  events.push(event(4, { kind: "usage", context: null, totals: null }));
  expect(usageSnapshot(events, "s").context).toBeNull();
  expect(cacheRate(totals)).toBe(60);
  expect(cacheRate({ ...totals, cache_write_tokens: null })).toBeNull();
  expect(
    cacheRate({
      ...totals,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    }),
  ).toBeNull();
});
it("telemetry never splits streamed prose or creates process rows", () => {
  expect(
    transcript([
      event(1, { kind: "text", text: "a" }),
      event(2, usage),
      event(3, { kind: "text", text: "b" }),
    ]),
  ).toEqual([{ key: 1, type: "assistant", text: "ab" }]);
});
it("shows only a ring until clicked, dismisses with Escape and outside clicks", () => {
  render(<UsageIndicator events={[event(1, usage)]} sessionId="s" />);
  const button = screen.getByRole("button", { name: "上下文与用量统计" });
  expect(button.textContent).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(button);
  expect(screen.getByText("50% 已用")).toBeTruthy();
  expect(screen.getByText("60%")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("unknown capacity is not displayed as zero and session change closes the panel", () => {
  const view = render(<UsageIndicator events={[]} sessionId="s" />);
  fireEvent.click(screen.getByRole("button", { name: "上下文与用量统计" }));
  expect(screen.getByText("暂无用量数据")).toBeTruthy();
  expect(screen.queryByText("占比未知")).toBeNull();
  expect(screen.getByRole("dialog").querySelector(".usage-track")).toBeNull();
  view.rerender(<UsageIndicator events={[]} sessionId="other" />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows only measured usage when a gateway or old history has no capacity", () => {
  render(
    <UsageIndicator
      events={[
        event(1, {
          ...usage,
          context: {
            model: "model_api/experimental_0812",
            used_tokens: 69692,
            window_tokens: null,
          },
        }),
      ]}
      sessionId="s"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "上下文与用量统计" }));
  const panel = screen.getByRole("dialog");
  expect(screen.getByText("已用 Token")).toBeTruthy();
  expect(screen.getByText("69,692")).toBeTruthy();
  expect(screen.queryByText("已用 / 总容量")).toBeNull();
  expect(screen.queryByText("占比未知")).toBeNull();
  expect(panel.querySelector(".usage-track")).toBeNull();
});

it("retains live totals across context updates and rejects legacy zero placeholders", () => {
  expect(
    usageSnapshot(
      [
        event(1, usage),
        event(2, { kind: "usage", context: usage.context, totals: null }),
      ],
      "s",
    ).totals,
  ).toEqual(totals);
  expect(
    usageSnapshot(
      [
        event(1, {
          kind: "usage",
          context: { model: "gateway", used_tokens: 0, window_tokens: null },
          totals,
        }),
      ],
      "s",
    ),
  ).toEqual({ context: null, totals });
});
