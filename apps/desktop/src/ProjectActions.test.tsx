// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectActions } from "./ProjectActions";
import type { Workbench } from "./useWorkbench";
import type { Session } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn(), closeSession: vi.fn() }));
vi.mock("./api", () => ({
  request: mocks.request,
  message: String,
  revealProject: vi.fn(),
}));
const session = (id: string, busy = false): Session => ({
  id,
  project_id: "p",
  title: id,
  agent: "claude",
  native_id: null,
  model: null,
  effort: null,
  permission_mode: null,
  status: "completed",
  created_at: 0,
  custom_title: false,
  pinned_at: id === "pinned" ? 1 : null,
  unread: true,
  archived: false,
  agent_session_open: true,
  agent_session_busy: busy,
});
let rows: Session[];
beforeEach(() => {
  vi.clearAllMocks();
  rows = [session("pinned"), session("other")];
  mocks.request.mockImplementation(async () => ({
    kind: "sessions",
    sessions: rows,
  }));
  mocks.closeSession.mockResolvedValue(undefined);
});
afterEach(cleanup);
const props = () => ({
  project: { hostId: "remote", id: "p", name: "Project", path: "/p" },
  point: { x: 20, y: 20 },
  close: vi.fn(),
  state: { sessionAction: mocks.closeSession } as unknown as Workbench,
});
it("shows the live count and directly closes all idle sessions on the right host", async () => {
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "关闭全部对话（2）" }),
  );
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.closeSession.mock.calls).toEqual([
    [
      "remote",
      {
        method: "close_agent_session",
        session_id: "pinned",
        only_if_idle: true,
      },
    ],
    [
      "remote",
      {
        method: "close_agent_session",
        session_id: "other",
        only_if_idle: true,
      },
    ],
  ]);
});
it("asks once for background work and closes only after confirmation", async () => {
  rows[1].agent_session_busy = true;
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "关闭全部对话（2）" }),
  );
  await screen.findByRole("dialog", { name: "关闭全部对话" });
  expect(mocks.closeSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭全部" }));
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(mocks.closeSession).toHaveBeenCalledWith(
    "remote",
    expect.objectContaining({ session_id: "other", only_if_idle: false }),
  );
});
it("reports partial failure and retries just that session", async () => {
  mocks.closeSession
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("temporarily busy"));
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "关闭全部对话（2）" }),
  );
  await screen.findByText("已关闭 1 个，1 个关闭失败。");
  rows = [session("other")];
  fireEvent.click(screen.getByRole("button", { name: "重试失败项" }));
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(mocks.closeSession.mock.calls.map(([, r]) => r.session_id)).toEqual([
    "pinned",
    "other",
    "other",
  ]);
});
it("shows unavailable live evidence instead of inventing a zero count", async () => {
  rows[0].agent_session_open = undefined;
  render(<ProjectActions {...props()} />);
  await screen.findByRole("alert");
  const button = screen.getByRole("menuitem", {
    name: "关闭全部对话",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(mocks.closeSession).not.toHaveBeenCalled();
});
