// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArchivedChats } from "./ArchivedChats";
import type { Workbench } from "./useWorkbench";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const state = () =>
  ({
    projects: [{ id: "p", hostId: "remote", name: "Project" }],
    hosts: [{ id: "remote", name: "Remote" }],
    sessionAction: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Workbench;
it("searches only archives and restores through the owning host", async () => {
  mocks.request.mockResolvedValue({
    kind: "sessions",
    sessions: [
      { id: "s", project_id: "p", title: "Archived task", archived: true },
      { id: "live", title: "Live task", archived: false },
    ],
  });
  const s = state();
  render(<ArchivedChats state={s} active onBusy={vi.fn()} />);
  expect(await screen.findByText("Archived task")).toBeTruthy();
  expect(screen.queryByText("Live task")).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "missing" },
  });
  expect(screen.getByText("没有匹配的已归档聊天")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.click(
    screen.getByRole("button", { name: "取消归档 Archived task" }),
  );
  await waitFor(() =>
    expect(s.sessionAction).toHaveBeenCalledWith("remote", {
      method: "archive_session",
      session_id: "s",
      archived: false,
    }),
  );
  await screen.findByText("还没有已归档的聊天");
});
it("keeps failed restores visible and reports offline projects instead of empty success", async () => {
  mocks.request.mockRejectedValueOnce(new Error("主机未连接"));
  const s = state();
  render(<ArchivedChats state={s} active onBusy={vi.fn()} />);
  await screen.findByText("Error: 主机未连接");
  expect(screen.queryByText("还没有已归档的聊天")).toBeNull();
  mocks.request.mockResolvedValue({
    kind: "sessions",
    sessions: [{ id: "s", project_id: "p", title: "Keep me", archived: true }],
  });
  fireEvent.click(screen.getByText("重试"));
  await screen.findByText("Keep me");
  vi.mocked(s.sessionAction).mockRejectedValue(new Error("恢复失败"));
  fireEvent.click(screen.getByRole("button", { name: "取消归档 Keep me" }));
  await screen.findByText("Error: 恢复失败");
  expect(screen.getByText("Keep me")).toBeTruthy();
});
