// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { Workbench } from "./useWorkbench";
import type { Session } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
const session = (status: Session["status"], unread = false): Session => ({
  id: "s",
  project_id: "p",
  title: "Task",
  agent: "claude",
  native_id: null,
  model: null,
  effort: null,
  permission_mode: null,
  status,
  created_at: 1,
  custom_title: false,
  pinned_at: null,
  unread,
  archived: false,
});
const state = (sessions: Session[]) =>
  ({
    hosts: [{ id: "local", name: "Local" }],
    hostId: "local",
    connected: true,
    projects: [{ hostId: "local", id: "p", name: "Project", path: "/repo" }],
    projectId: "p",
    sessions,
    sessionId: "s",
    pinned: [],
    hostErrors: {},
    sidebarOpen: true,
    showArchived: false,
    openSession: vi.fn(),
  }) as unknown as Workbench;
beforeEach(() => {
  localStorage.clear();
  // Existing cases isolate project/pinned rows; recent navigation is covered below.
  localStorage.setItem(
    "latte-work.sidebar-sections.v1",
    JSON.stringify({ recent: false }),
  );
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("distinguishes running, waiting and unread, and reflects folder expansion", () => {
  const { rerender } = render(
    <Sidebar state={state([session("running", true)])} />,
  );
  const project = screen.getByRole("button", { name: "Project" });
  expect(project.querySelector(".lucide-folder-open")).not.toBeNull();
  expect(screen.getByRole("img", { name: "执行中" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "未读" })).toBeNull();
  fireEvent.click(project);
  expect(project.querySelector(".lucide-folder")).not.toBeNull();
  expect(
    within(project).getByRole("img", { name: "项目中有对话执行中" }),
  ).toBeTruthy();
  fireEvent.click(project);
  rerender(<Sidebar state={state([session("waiting", true)])} />);
  expect(screen.getByRole("img", { name: "等待确认" })).toBeTruthy();
  rerender(<Sidebar state={state([session("completed", true)])} />);
  expect(screen.queryByRole("img", { name: "执行中" })).toBeNull();
  expect(screen.getByRole("img", { name: "未读" })).toBeTruthy();
  rerender(<Sidebar state={state([session("completed", false)])} />);
  expect(screen.queryByRole("img", { name: "未读" })).toBeNull();
});
it("opens recent history across projects and hosts without selecting on startup", async () => {
  localStorage.clear();
  const base = state([]);
  const remote = {
    ...session("completed"),
    id: "same",
    title: "Remote history",
    project_id: "remote-project",
  };
  mocks.request.mockImplementation(async (hostId, request) =>
    request.method === "recent_sessions"
      ? {
          kind: "recent_sessions",
          sessions: [
            {
              session:
                hostId === "local"
                  ? {
                      ...session("completed"),
                      id: "same",
                      title: "Local history",
                    }
                  : remote,
              updated_at: hostId === "local" ? 3 : 5,
            },
          ],
          next: null,
        }
      : { kind: "sessions", sessions: [] },
  );
  const props = {
    ...base,
    hosts: [
      ...base.hosts,
      { id: "remote", name: "Remote", ssh: "remote", server_path: null },
    ],
    projects: [
      ...base.projects,
      {
        hostId: "remote",
        id: "remote-project",
        name: "Remote project",
        path: "/remote",
      },
    ],
  };
  render(<Sidebar state={props} />);
  const recent = within(screen.getByRole("region", { name: "最近对话" }));
  await recent.findByRole("button", { name: "Remote history" });
  expect(
    recent
      .getAllByRole("button")
      .filter((button) => button.classList.contains("session-row"))
      .map((button) => button.textContent),
  ).toEqual(["Remote history", "Local history"]);
  expect(props.openSession).not.toHaveBeenCalled();
  fireEvent.click(recent.getByRole("button", { name: "Remote history" }));
  expect(props.openSession).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "same",
      hostId: "remote",
      project_id: "remote-project",
    }),
  );
  expect(
    screen
      .getByRole("button", { name: "Remote project" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.click(recent.getByRole("button", { name: "最近" }));
  expect(recent.queryByRole("button", { name: "Remote history" })).toBeNull();
  expect(
    JSON.parse(localStorage.getItem("latte-work.sidebar-sections.v1")!).recent,
  ).toBe(false);
});
it("keeps loaded recent history visible through a failed refresh and retry", async () => {
  localStorage.clear();
  let fail = false;
  mocks.request.mockImplementation(async () => {
    if (fail) throw new Error("Host is offline");
    return {
      kind: "recent_sessions",
      sessions: [{ session: session("completed"), updated_at: 1 }],
      next: { updated_at: 1, id: "s" },
    };
  });
  render(<Sidebar state={state([])} />);
  const recent = within(screen.getByRole("region", { name: "最近对话" }));
  await recent.findByRole("button", { name: "Task" });
  fail = true;
  fireEvent.click(recent.getByRole("button", { name: "加载更早的对话" }));
  await recent.findByRole("button", { name: "Local 加载失败 · 重试" });
  expect(recent.getByRole("button", { name: "Task" })).toBeTruthy();
  expect(recent.queryByText("暂无历史对话")).toBeNull();
  fail = false;
  mocks.request.mockResolvedValue({
    kind: "recent_sessions",
    sessions: [{ session: session("completed"), updated_at: 1 }],
    next: null,
  });
  fireEvent.click(
    recent.getByRole("button", { name: "Local 加载失败 · 重试" }),
  );
  await waitFor(() =>
    expect(
      recent.queryByRole("button", { name: "Local 加载失败 · 重试" }),
    ).toBeNull(),
  );
});
it("refreshes collapsed background projects even while the current view rerenders", async () => {
  vi.useFakeTimers();
  const other = { hostId: "local", id: "other", name: "Other", path: "/other" };
  let status: Session["status"] = "running";
  mocks.request.mockImplementation(async () => ({
    kind: "sessions",
    sessions: [{ ...session(status), project_id: "other" }],
  }));
  const props = () => {
    const s = state([]);
    return { ...s, projects: [...s.projects, other] };
  };
  const view = render(<Sidebar state={props()} />);
  await act(async () => {});
  const project = screen.getByRole("button", { name: "Other" });
  expect(
    within(project).getByRole("img", { name: "项目中有对话执行中" }),
  ).toBeTruthy();
  status = "completed";
  for (let i = 0; i < 10; i++) {
    view.rerender(<Sidebar state={props()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
  }
  expect(
    within(project).queryByRole("img", { name: "项目中有对话执行中" }),
  ).toBeNull();
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("opens row menus without selecting a conversation and keeps the trigger marked open", () => {
  const s = state([session("running")]);
  render(<Sidebar state={s} />);
  const more = screen.getByRole("button", { name: "Task 的更多操作" });
  fireEvent.click(more);
  expect(s.openSession).not.toHaveBeenCalled();
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(more.closest(".session-item")?.getAttribute("data-menu-open")).toBe(
    "true",
  );
  expect(screen.getByRole("menu", { name: "Task 会话操作" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  const project = screen.getByRole("button", { name: "Project 的更多操作" });
  fireEvent.click(project);
  expect(project.getAttribute("aria-expanded")).toBe("true");
});
it("disables close until the live conversation is open and skips it with the keyboard", async () => {
  const base = state([{ ...session("completed"), agent_session_open: false }]);
  base.sessionAction = vi.fn().mockResolvedValue(undefined);
  const view = render(<Sidebar state={base} />);
  fireEvent.click(screen.getByRole("button", { name: "Task 的更多操作" }));
  const closeButton = () =>
    screen.getByRole("menuitem", { name: "关闭" }) as HTMLButtonElement;
  expect(closeButton().disabled).toBe(true);
  fireEvent.click(closeButton());
  expect(base.sessionAction).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "End" });
  fireEvent.keyDown(document, { key: "ArrowUp" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "复制…" }),
  );
  const opened = {
    ...base,
    sessions: [{ ...base.sessions[0], agent_session_open: true }],
  };
  view.rerender(<Sidebar state={opened} />);
  expect(closeButton().disabled).toBe(false);
  view.rerender(<Sidebar state={{ ...opened, connected: false }} />);
  expect(closeButton().disabled).toBe(true);
  expect(closeButton().title).toBe("会话状态待确认");
  view.rerender(
    <Sidebar state={{ ...opened, agentSessionState: () => "restoring" }} />,
  );
  expect(closeButton().disabled).toBe(true);
  view.rerender(<Sidebar state={base} />);
  expect(closeButton().disabled).toBe(true);
  view.rerender(<Sidebar state={opened} />);
  await act(async () => fireEvent.click(closeButton()));
  expect(base.sessionAction).toHaveBeenCalledExactlyOnceWith("local", {
    method: "close_agent_session",
    session_id: "s",
  });
});
it("uses the target host's latest state for a pinned conversation menu", async () => {
  const local = { ...session("completed"), agent_session_open: true };
  const remote = { ...local, hostId: "remote", agent_session_open: false };
  const base = {
    ...state([local]),
    pinned: [remote],
    isHostConnected: () => true,
    sessionAction: vi.fn().mockResolvedValue(undefined),
  };
  const view = render(<Sidebar state={base} />);
  fireEvent.click(
    screen.getAllByRole("button", { name: "Task 的更多操作" })[0],
  );
  const closeButton = () =>
    screen.getByRole("menuitem", { name: "关闭" }) as HTMLButtonElement;
  expect(closeButton().disabled).toBe(true);
  view.rerender(
    <Sidebar
      state={{ ...base, pinned: [{ ...remote, agent_session_open: true }] }}
    />,
  );
  expect(closeButton().disabled).toBe(false);
  await act(async () => fireEvent.click(closeButton()));
  expect(base.sessionAction).toHaveBeenCalledExactlyOnceWith("remote", {
    method: "close_agent_session",
    session_id: "s",
  });
});
it("scopes quick pin/archive actions and prevents archiving active tasks", async () => {
  const s = state([session("running")]);
  s.sessionAction = vi.fn().mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({
    kind: "sessions",
    sessions: [session("running")],
  });
  render(<Sidebar state={s} />);
  fireEvent.click(screen.getByRole("button", { name: "归档 Task" }));
  expect(s.sessionAction).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "置顶 Task" })),
  );
  expect(s.sessionAction).toHaveBeenCalledWith("local", {
    method: "pin_session",
    session_id: "s",
    pinned: true,
  });
});
it("keeps archived chats and archive navigation out of project sections", () => {
  render(
    <Sidebar state={state([{ ...session("completed"), archived: true }])} />,
  );
  expect(screen.queryByText("Task")).toBeNull();
  expect(screen.queryByText(/已归档/)).toBeNull();
});

it("mutes empty projects and restores their emphasis when a conversation exists", () => {
  const view = render(<Sidebar state={state([])} />);
  const project = screen.getByRole("button", { name: "Project" });
  expect(project.closest(".project-heading")?.classList.contains("empty")).toBe(
    true,
  );
  view.rerender(<Sidebar state={state([session("completed")])} />);
  expect(project.closest(".project-heading")?.classList.contains("empty")).toBe(
    false,
  );
  const pinned = { ...session("completed"), pinned_at: 1, hostId: "local" };
  view.rerender(<Sidebar state={{ ...state([]), pinned: [pinned] }} />);
  expect(project.closest(".project-heading")?.classList.contains("empty")).toBe(
    false,
  );
  expect(screen.queryByText("还没有任务")).toBeNull();
});

it("shows pinned sessions only once and restores them under the project after unpinning", () => {
  const pinned = { ...session("completed"), pinned_at: 1 };
  const base = state([pinned]);
  const view = render(
    <Sidebar state={{ ...base, pinned: [{ ...pinned, hostId: "local" }] }} />,
  );
  expect(screen.getAllByText("Task")).toHaveLength(1);
  expect(
    within(screen.getByRole("region", { name: "置顶会话" })).getByText("Task"),
  ).toBeTruthy();
  expect(screen.queryByText("还没有任务")).toBeNull();
  view.rerender(<Sidebar state={state([session("completed")])} />);
  expect(screen.getAllByText("Task")).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "置顶会话" })).toBeNull();
});

it("shows delayed history feedback only beside the selected conversation", () => {
  vi.useFakeTimers();
  const s = state([
    session("completed"),
    { ...session("completed"), id: "other", title: "Other task" },
  ]);
  const view = render(<Sidebar state={s} historyPending />);
  expect(screen.queryByLabelText("正在加载对话")).toBeNull();
  act(() => vi.advanceTimersByTime(300));
  const indicator = screen.getByLabelText("正在加载对话");
  expect(indicator.closest("button")?.textContent).toContain("Task");
  expect(screen.queryByText("正在加载")).toBeNull();
  act(() => vi.advanceTimersByTime(4700));
  expect(screen.queryByText("正在加载")).toBeNull();
  expect(within(indicator).getAllByRole("status")).toHaveLength(1);
  view.rerender(<Sidebar state={s} historyPending={false} />);
  expect(screen.queryByLabelText("正在加载对话")).toBeNull();
});

it.each(["opening", "restoring"] as const)(
  "merges %s and history feedback into one indicator on the right",
  (phase) => {
    vi.useFakeTimers();
    const s = state([session("running")]);
    s.agentSessionState = () => phase;
    render(<Sidebar state={s} historyPending />);
    const row = screen.getByRole("button", { name: "Task" });
    const expectSingleIndicator = () => {
      const indicator = within(row).getByRole("status");
      expect(indicator.closest(".row-status")).not.toBeNull();
      expect(row.querySelector(".session-agent-open")).toBeNull();
      expect(within(row).queryByRole("img", { name: "执行中" })).toBeNull();
      expect(row.textContent).toBe("Task");
    };
    expectSingleIndicator();
    act(() => vi.advanceTimersByTime(5000));
    expectSingleIndicator();
    expect(within(row).getByLabelText("正在加载对话")).toBeTruthy();
  },
);

it("shows live Agent evidence in hover information without a leading icon or an open request", () => {
  vi.useFakeTimers();
  const opened = { ...session("completed"), agent_session_open: true };
  const base = state([opened]);
  const view = render(<Sidebar state={base} />);
  const hover = (row: HTMLElement) => {
    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(350));
    return screen.getByRole("tooltip");
  };
  const row = screen.getByRole("button", { name: "Task" });
  expect(row.firstElementChild?.className).toBe("session-label");
  expect(screen.queryByRole("tooltip")).toBeNull();
  const info = hover(row);
  expect(within(info).getByText("Task")).toBeTruthy();
  expect(within(info).getByText("Project")).toBeTruthy();
  expect(within(info).getByText("Local · 已完成")).toBeTruthy();
  expect(within(info).getByText("已打开")).toBeTruthy();
  expect(base.openSession).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  const pinned = { ...opened, pinned_at: 1, hostId: "local" };
  view.rerender(
    <Sidebar state={{ ...base, sessions: [pinned], pinned: [pinned] }} />,
  );
  const pinnedRow = within(
    screen.getByRole("region", { name: "置顶会话" }),
  ).getByRole("button", { name: "Task" });
  expect(within(hover(pinnedRow)).getByText("已打开")).toBeTruthy();
  view.rerender(
    <Sidebar
      state={state([{ ...session("running"), agent_session_open: false }])}
    />,
  );
  expect(
    within(hover(screen.getByRole("button", { name: "Task" }))).queryByText(
      "已打开",
    ),
  ).toBeNull();
  expect(screen.getByRole("img", { name: "执行中" })).toBeTruthy();
  view.rerender(<Sidebar state={{ ...base, connected: false }} />);
  const disconnected = hover(screen.getByRole("button", { name: "Task" }));
  expect(within(disconnected).queryByText("已打开")).toBeNull();
  expect(within(disconnected).getByText("会话状态待确认")).toBeTruthy();
  view.rerender(<Sidebar state={state([session("completed")])} />);
  expect(within(screen.getByRole("tooltip")).queryByText("已打开")).toBeNull();
});

it("keeps live session evidence scoped to its host and hides it after host disconnect", () => {
  vi.useFakeTimers();
  const remote = {
    ...session("completed"),
    pinned_at: 1,
    agent_session_open: true,
    hostId: "remote",
  };
  const base = state([]);
  const props = {
    ...base,
    hosts: [
      ...base.hosts,
      { id: "remote", name: "Remote", ssh: "remote", server_path: null },
    ],
    projects: [
      ...base.projects,
      { hostId: "remote", id: "p", name: "Remote project", path: "/remote" },
    ],
    pinned: [remote],
    isHostConnected: (id: string) => id === "remote",
  };
  const view = render(<Sidebar state={props} />);
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Task" }));
  act(() => vi.advanceTimersByTime(350));
  expect(within(screen.getByRole("tooltip")).getByText("已打开")).toBeTruthy();
  view.rerender(<Sidebar state={{ ...props, isHostConnected: () => false }} />);
  expect(within(screen.getByRole("tooltip")).queryByText("已打开")).toBeNull();
  expect(
    within(screen.getByRole("tooltip")).getByText("会话状态待确认"),
  ).toBeTruthy();
});

it("includes pinned and unselected conversations once in project hover counts and does not guess after disconnect", () => {
  vi.useFakeTimers();
  const opened = {
    ...session("completed"),
    agent_session_open: true,
    pinned_at: 1,
  };
  const other = {
    ...opened,
    id: "other",
    title: "Other pinned",
    hostId: "local",
  };
  const base = {
    ...state([
      opened,
      { ...session("completed"), id: "closed", agent_session_open: false },
      { ...opened, id: "archived", archived: true },
    ]),
    pinned: [{ ...opened, hostId: "local" }, other],
  };
  const view = render(<Sidebar state={base} />);
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Project" }));
  act(() => vi.advanceTimersByTime(350));
  const info = screen.getByRole("tooltip");
  expect(within(info).getByText("Project")).toBeTruthy();
  expect(within(info).getByText("/repo")).toBeTruthy();
  expect(within(info).getByText("Local")).toBeTruthy();
  expect(within(info).getByText("3 个任务 · 2 个已打开")).toBeTruthy();
  expect(mocks.request).not.toHaveBeenCalled();
  view.rerender(<Sidebar state={{ ...base, connected: false }} />);
  expect(within(info).getByText("3 个任务 · 会话状态待确认")).toBeTruthy();
});
