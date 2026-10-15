// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderWithStatus as render } from "./test/renderWithStatus";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskInfo } from "./TaskInfo";
import { readWorkspace } from "./workspaceState";
import { LinkHandling } from "./LinkHandling";
import type { Request } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
const props = {
  workspaceId: "",
  active: true,
  hostId: "local",
  connected: true,
  project: { id: "p", name: "Project", path: "/project" },
  sessionId: "s",
  events: [
    {
      seq: 1,
      at: 1,
      session_id: "s",
      event: {
        kind: "text" as const,
        text: "[Report](/project/report.md) [Docs](https://example.com/docs)",
      },
    },
  ],
  subagents: { tasks: [], loading: false, error: "", truncated: false },
};
beforeEach(() => {
  props.workspaceId = crypto.randomUUID();
  mocks.request
    .mockReset()
    .mockImplementation(async (_host: string, request: Request) =>
      request.method === "resolve_reference"
        ? {
            kind: "file_reference",
            entry: { path: "report.md", name: "report.md", directory: false },
          }
        : request.method === "git_review"
          ? {
              kind: "git_review",
              review: {
                entries: [{ path: "report.md" }],
                added: 8,
                removed: 2,
                truncated: false,
              },
            }
          : {
              kind: "sources",
              entries: [
                {
                  id: "Read",
                  name: "Read",
                  kind: "tool",
                  tools: ["Read"],
                  uses: 3,
                },
              ],
              truncated: false,
            },
    );
});
afterEach(cleanup);
it("renders ordered information and routes links and files into reusable tabs", async () => {
  render(
    <LinkHandling workspaceId={props.workspaceId}>
      <TaskInfo {...props} />
    </LinkHandling>,
  );
  await screen.findByText("1 个文件");
  expect(
    screen
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent),
  ).toEqual([
    "变更概览",
    "子智能体",
    "待办事项",
    "调用的 Skill",
    "调用的 Tools",
    "任务产物",
    "任务资源",
  ]);
  expect(screen.getByText("+8")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "调用的 Tools" })).getByText(
      "3 次",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Docs" }));
  expect(readWorkspace(props.workspaceId).tabs).toContainEqual(
    expect.objectContaining({
      kind: "browser",
      url: "https://example.com/docs",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Report/ }));
  await waitFor(() =>
    expect(readWorkspace(props.workspaceId).tabs).toContainEqual(
      expect.objectContaining({
        kind: "files",
        file: "report.md",
        hostId: "local",
        project: props.project,
        sessionId: "s",
      }),
    ),
  );
  expect(
    mocks.request.mock.calls.every(([, value]) =>
      ["git_review", "sources", "resolve_reference"].includes(value.method),
    ),
  ).toBe(true);
});
it("offers older history without claiming missing records are empty", () => {
  const load = vi.fn();
  render(<TaskInfo {...props} hasEarlierHistory loadEarlierHistory={load} />);
  expect(screen.getAllByText("暂无记录").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "查看更早记录" }));
  expect(load).toHaveBeenCalledOnce();
});
it("does not read hidden/offline panes and fences late snapshots after session changes", async () => {
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<TaskInfo {...props} active={false} />);
  await new Promise((done) => setTimeout(done, 120));
  expect(mocks.request).not.toHaveBeenCalled();
  view.rerender(<TaskInfo {...props} />);
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  view.rerender(
    <TaskInfo {...props} hostId="remote" sessionId="other" connected={false} />,
  );
  finish({
    kind: "sources",
    entries: [{ id: "stale", name: "Stale", kind: "tool", uses: 7, tools: [] }],
    truncated: false,
  });
  await waitFor(() => expect(screen.queryByText("Stale")).toBeNull());
  expect(screen.queryByText("Report")).toBeNull();
  expect(screen.getByText("状态待确认")).toBeTruthy();
});
it("reports source failures through the shared status entry and supports explicit retry", async () => {
  mocks.request.mockRejectedValue(new Error("offline read"));
  render(<TaskInfo {...props} />);
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "调用的 Tools" })).getByText(
        "暂不可用",
      ),
    ).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: /状态提示/ }));
  expect(screen.getByText("任务工具列表暂不可用")).toBeTruthy();
  mocks.request.mockResolvedValue({
    kind: "sources",
    entries: [],
    truncated: false,
  });
  fireEvent.click(screen.getAllByRole("button", { name: "重试" })[1]);
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "调用的 Tools" })).getByText(
        "暂无记录",
      ),
    ).toBeTruthy(),
  );
});
it("keeps scope information out of the header and uses one empty-state phrase", async () => {
  const view = render(
    <TaskInfo
      {...props}
      events={[]}
      hasEarlierHistory
      loadEarlierHistory={vi.fn()}
    />,
  );
  await screen.findByText("1 个文件");
  expect(screen.queryByText("Project")).toBeNull();
  expect(screen.queryByText(/按已加载的对话记录整理/)).toBeNull();
  for (const title of [
    "子智能体",
    "待办事项",
    "调用的 Skill",
    "任务产物",
    "任务资源",
  ]) {
    expect(
      within(screen.getByRole("region", { name: title })).getByText("暂无记录"),
    ).toBeTruthy();
  }
  expect(screen.getByRole("button", { name: "查看更早记录" }).title).toContain(
    "已加载",
  );
  view.rerender(<TaskInfo {...props} events={[]} />);
  expect(screen.queryByRole("button", { name: "查看更早记录" })).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "待办事项" })).getByText(
      "暂无记录",
    ),
  ).toBeTruthy();
});

it("keeps Git reads independent of streamed events and refreshes tools at a bounded cadence", async () => {
  vi.useFakeTimers();
  try {
    const view = render(<TaskInfo {...props} running />);
    await act(async () => {});
    const count = (method: string) =>
      mocks.request.mock.calls.filter(([, r]) => r.method === method).length;
    expect(count("git_review")).toBe(1);
    const entries = [...props.events];
    for (let i = 0; i < 40; i++) {
      entries.push({
        seq: i + 2,
        at: i + 2,
        session_id: "s",
        event: { kind: "text", text: "fragment" },
      });
      view.rerender(<TaskInfo {...props} running events={[...entries]} />);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(count("git_review")).toBe(1);
    expect(count("sources")).toBe(2);
    view.rerender(<TaskInfo {...props} events={entries} />);
    await act(async () => {});
    expect(count("git_review")).toBe(2);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
