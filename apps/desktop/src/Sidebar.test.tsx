// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
  const project = screen.getByTitle("/other · Local");
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
