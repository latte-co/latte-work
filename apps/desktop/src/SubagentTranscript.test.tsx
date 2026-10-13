// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SubagentTranscript } from "./SubagentTranscript";
import type { Event, EventKind, Subagent } from "./protocol";
afterEach(cleanup);
const task: Subagent = {
  id: "a",
  native_id: "native-a",
  tool_use_id: "p",
  title: "检查项目",
  status: "running",
  summary: null,
  last_tool: "Read",
  started_at: 0,
  updated_at: 1000,
};
const rows = (...values: EventKind[]): Event[] =>
  values.map((event, seq) => ({ seq, session_id: "s", at: seq, event }));
const events = rows(
  { kind: "text", text: "child progress" },
  { kind: "tool", id: "read", name: "Read", input: { file_path: "child.txt" } },
  {
    kind: "tool_result",
    id: "read",
    content: "native read output",
    is_error: false,
  },
);
it("shows live child prose and native tool input/output, then folds it on completion", () => {
  const view = render(
    <SubagentTranscript task={task} events={events} elapsed="1s" />,
  );
  expect(screen.getByText("child progress")).toBeTruthy();
  expect(screen.getByText("native read output")).toBeTruthy();
  expect(screen.getByText(/"file_path": "child.txt"/)).toBeTruthy();
  view.rerender(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: "child final" }}
      events={events}
      elapsed="3s"
    />,
  );
  expect(screen.queryByText("child progress")).toBeNull();
  expect(screen.getByText("child final").closest("details")).toBeNull();
  expect(screen.getAllByRole("button", { name: "复制回复" })).toHaveLength(1);
  const details = screen.getByText("用时 3s").closest("details")!;
  expect(details.open).toBe(false);
  details.open = true;
  fireEvent(details, new window.Event("toggle"));
  expect(screen.getByText("child progress").closest("details")).toBe(details);
  view.rerender(
    <SubagentTranscript
      task={{ ...task, id: "b", status: "completed", summary: "other final" }}
      events={events}
      elapsed="3s"
    />,
  );
  expect(screen.getByText("用时 3s").closest("details")!.open).toBe(false);
});
it.each(["failed", "stopped", "unknown", "paused"] as const)(
  "retains actual process evidence for %s children",
  (status) => {
    render(
      <SubagentTranscript
        task={{ ...task, status }}
        events={events}
        elapsed="3s"
      />,
    );
    expect(screen.getByText("child progress")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
  },
);
it("does not claim a missing tool result succeeded after completion and marks partial snapshots", () => {
  render(
    <SubagentTranscript
      task={{ ...task, status: "completed" }}
      events={events.slice(0, 2)}
      elapsed="3s"
      truncated
    />,
  );
  expect(screen.getByText("未收到最终输出")).toBeTruthy();
  const details = screen.getByText("用时 3s").closest("details")!;
  details.open = true;
  fireEvent(details, new window.Event("toggle"));
  expect(screen.getByText("结果待确认")).toBeTruthy();
  expect(screen.getByText(/部分过程或内容超出显示上限/)).toBeTruthy();
});
