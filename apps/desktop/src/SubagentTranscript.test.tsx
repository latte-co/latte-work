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
it("keeps a child review report visible around later tools and a delivery receipt", () => {
  render(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: "交付完成" }}
      elapsed="3s"
      events={rows(
        { kind: "text", text: "完整子评审报告" },
        { kind: "tool", id: "save", name: "Write", input: {} },
        { kind: "tool_result", id: "save", content: "saved", is_error: false },
        { kind: "text", text: "交付完成" },
      )}
    />,
  );
  const report = screen.getByText("完整子评审报告");
  expect(report.closest("details")).toBeNull();
  const process = screen.getByText("用时 3s").closest("details")!;
  expect(process.open).toBe(false);
  expect(
    report.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    process.compareDocumentPosition(screen.getByText("交付完成")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
it("shows a delivered report only once when the summary repeats prose before a trailing tool", () => {
  render(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: "完整报告" }}
      elapsed="3s"
      events={rows(
        { kind: "text", text: "完整报告" },
        { kind: "tool", id: "save", name: "Write", input: {} },
        { kind: "tool_result", id: "save", content: "saved", is_error: false },
      )}
    />,
  );
  expect(screen.getAllByText("完整报告")).toHaveLength(1);
  expect(screen.getByText("完整报告").closest("details")).toBeNull();
  expect(screen.queryByText("未收到最终输出")).toBeNull();
  expect(screen.getAllByRole("button", { name: "复制回复" })).toHaveLength(1);
});
it("keeps child prose visible and folds only native tool records on completion", () => {
  const view = render(
    <SubagentTranscript task={task} events={events} elapsed="1s" />,
  );
  expect(screen.getByText("child progress")).toBeTruthy();
  expect(view.container.querySelector("time")).toBeNull();
  expect(screen.getByText("native read output")).toBeTruthy();
  expect(screen.getByText(/"file_path": "child.txt"/)).toBeTruthy();
  view.rerender(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: "child final" }}
      events={events}
      elapsed="3s"
    />,
  );
  expect(screen.getByText("child progress").closest("details")).toBeNull();
  expect(screen.getByText("child final").closest("details")).toBeNull();
  expect(view.container.querySelector("time")!.dateTime).toBe(
    new Date(task.updated_at).toISOString(),
  );
  expect(screen.getAllByRole("button", { name: "复制回复" })).toHaveLength(1);
  const details = screen.getByText("用时 3s").closest("details")!;
  expect(details.open).toBe(false);
  details.open = true;
  fireEvent(details, new window.Event("toggle"));
  expect(screen.getByText("child progress").closest("details")).toBeNull();
  expect(screen.getByText("native read output").closest(".turn-process")).toBe(
    details,
  );
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
      incomplete
    />,
  );
  expect(screen.getByText("未收到最终输出")).toBeTruthy();
  const details = screen.getByText("用时 3s").closest("details")!;
  details.open = true;
  fireEvent(details, new window.Event("toggle"));
  expect(screen.getByText("结果待确认")).toBeTruthy();
  expect(screen.getByText(/部分原始记录暂不可读取/)).toBeTruthy();
});
it("shows the normalized delivered report instead of the task delivery receipt", () => {
  const receipt =
    "This agent's report was delivered to you as a message. Read it there.";
  render(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: receipt }}
      events={rows(
        {
          kind: "tool",
          id: "handback",
          name: "SubagentHandback",
          input: { message: "历史报告正文" },
        },
        {
          kind: "tool_result",
          id: "handback",
          content: [{ type: "text", text: '{"success":true}' }],
          is_error: false,
        },
        { kind: "text", text: "历史报告" },
        { kind: "text", text: "正文" },
      )}
      elapsed="3s"
      incomplete
    />,
  );
  expect(screen.getByText("历史报告正文").closest("details")).toBeNull();
  expect(screen.queryByText(receipt)).toBeNull();
  expect(screen.getByRole("button", { name: "复制回复" })).toBeTruthy();
  expect(screen.getByText("用时 3s").closest("details")!.open).toBe(false);
});

it("reads all pages before claiming a final answer or folding the process", () => {
  const view = render(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: "delivery receipt" }}
      events={events}
      elapsed="3s"
      readingMore
    />,
  );
  expect(screen.getByText("正在读取完整记录")).toBeTruthy();
  expect(screen.queryByText("delivery receipt")).toBeNull();
  expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
  expect(screen.getByText("child progress").closest("details")).toBeNull();
  view.rerender(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: "delivery receipt" }}
      events={[
        ...events,
        {
          seq: 9,
          session_id: "s",
          at: 1,
          event: { kind: "text", text: "完整最终正文" },
        },
      ]}
      elapsed="3s"
    />,
  );
  expect(screen.getByText("完整最终正文").closest("details")).toBeNull();
  expect(screen.getByText("用时 3s").closest("details")!.open).toBe(false);
  expect(screen.queryByText(/显示上限/)).toBeNull();
});

it("keeps the original delegated prompt available above the folded process and final answer", () => {
  render(
    <SubagentTranscript
      task={{ ...task, status: "completed", summary: "Final report" }}
      events={events}
      elapsed="3s"
      prompt="Review the complete changes. Preserve this exact input."
    />,
  );
  const instruction = screen.getByText("任务指令").closest("details")!;
  expect(instruction.open).toBe(false);
  fireEvent.click(screen.getByText("任务指令"));
  expect(instruction.textContent).toContain(
    "Review the complete changes. Preserve this exact input.",
  );
  expect(screen.getByText("Final report").closest("details")).toBeNull();
});
it("preserves independently expanded child tool segments when later output and metadata arrive", () => {
  const initial = rows(
    { kind: "text", text: "review one" },
    { kind: "tool", id: "save", name: "Write", input: {} },
    {
      kind: "tool_result",
      id: "save",
      content: "save result",
      is_error: false,
    },
    { kind: "text", text: "review two" },
    { kind: "tool", id: "check", name: "Bash", input: {} },
    {
      kind: "tool_result",
      id: "check",
      content: "check result",
      is_error: false,
    },
    { kind: "text", text: "done" },
  );
  const content = (events: Event[], updated_at = 1000) => (
    <SubagentTranscript
      task={{ ...task, status: "completed", updated_at }}
      events={events}
      elapsed="3s"
    />
  );
  const view = render(content(initial));
  const parts = view.container.querySelectorAll(".turn-process");
  expect(parts).toHaveLength(2);
  const first = parts[0] as HTMLDetailsElement;
  first.open = true;
  fireEvent(first, new window.Event("toggle"));
  view.rerender(
    content(
      [
        ...initial,
        {
          seq: initial.length,
          at: 100,
          session_id: "s",
          event: { kind: "text", text: "; verification saved" },
        },
      ],
      2000,
    ),
  );
  expect(first.isConnected && first.open).toBe(true);
  expect((parts[1] as HTMLDetailsElement).open).toBe(false);
  expect(screen.getByText("review one").closest("details")).toBeNull();
  expect(screen.getByText("review two").closest("details")).toBeNull();
  expect(
    screen.getByText("done; verification saved").closest("details"),
  ).toBeNull();
});
