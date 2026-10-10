// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SubagentSummary, SubagentsPanel } from "./SubagentsPanel";
import type { Subagent } from "./protocol";
import { openSubagents, readWorkspace } from "./workspaceState";
afterEach(cleanup);
const task = (id: string, status: Subagent["status"]): Subagent => ({
  id,
  native_id: id,
  tool_use_id: null,
  title: id,
  status,
  summary: status === "completed" ? "结果已返回" : null,
  last_tool: "Read",
  started_at: 1,
  updated_at: 2000,
});
it("opens the workspace, separates running/completed/unknown and shows a selected native result", () => {
  const state = {
    tasks: [
      task("running child", "running"),
      task("completed child", "completed"),
      task("lost child", "unknown"),
    ],
    loading: false,
    error: "",
    truncated: false,
  };
  const id = crypto.randomUUID();
  const open = vi.fn(() => openSubagents(id));
  const select = vi.fn();
  const view = render(
    <>
      <SubagentSummary state={state} open={open} />
      <SubagentsPanel state={state} onOpen={select} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看子智能体" }));
  expect(readWorkspace(id)).toMatchObject({
    visible: true,
    current: "subagents",
    conversationActive: false,
  });
  expect(screen.getByRole("region", { name: "已开启" }).textContent).toContain(
    "running child",
  );
  expect(screen.getByRole("region", { name: "完成" }).textContent).toContain(
    "completed child",
  );
  fireEvent.click(screen.getByRole("button", { name: /completed child/ }));
  expect(select).toHaveBeenCalledWith(state.tasks[1]);
  expect(screen.getByRole("region", { name: "已开启" })).toBeTruthy();
  view.rerender(<SubagentsPanel state={state} taskId="completed child" />);
  expect(screen.getByText("结果已返回")).toBeTruthy();
  expect(screen.queryByText("任务标识")).toBeNull();
  expect(
    screen.queryByText("completed child", { selector: "code" }),
  ).toBeNull();
  view.rerender(
    <SubagentsPanel
      state={{ ...state, tasks: [task("other child", "running")] }}
      onOpen={select}
    />,
  );
  expect(screen.queryByText("结果已返回")).toBeNull();
  expect(screen.getByRole("button", { name: /other child/ })).toBeTruthy();
});
