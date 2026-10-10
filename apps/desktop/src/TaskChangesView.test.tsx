// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskChangesView } from "./TaskChangesView";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
afterEach(cleanup);
const props = {
  hostId: "local",
  project: { id: "p", name: "P", path: "/p" },
  sessionId: "s",
  active: true,
};
it("opens task baseline diffs and labels legacy tasks without invented changes", async () => {
  mocks.request
    .mockResolvedValueOnce({
      kind: "change_summary",
      summary: {
        entries: [{ path: "a.txt", status: "M", added: 2, removed: 1 }],
        added: 2,
        removed: 1,
        binary_files: 0,
        unavailable: null,
        truncated: false,
      },
    })
    .mockResolvedValueOnce({
      kind: "content",
      text: "-before\n+after",
      truncated: false,
    });
  const view = render(<TaskChangesView {...props} />);
  await screen.findAllByText("+2");
  fireEvent.click(await screen.findByRole("button", { name: /a.txt/ }));
  await screen.findByText("-before");
  expect(mocks.request.mock.calls[1][1]).toEqual({
    method: "task_change_diff",
    session_id: "s",
    path: "a.txt",
  });
  view.unmount();
  mocks.request.mockResolvedValue({
    kind: "change_summary",
    summary: {
      entries: [],
      added: 0,
      removed: 0,
      unavailable: "此任务没有记录文件基线",
      truncated: false,
    },
  });
  render(<TaskChangesView {...props} />);
  await screen.findByText("此任务没有记录文件基线");
  expect(screen.queryByText("本任务尚无可确认的文件变更")).toBeNull();
});
it("loads frozen turn diffs and fences responses after switching turns", async () => {
  let finish!: (value: unknown) => void;
  mocks.request
    .mockReset()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({
      kind: "content",
      text: "-one\n+two",
      truncated: false,
    });
  const view = render(
    <TaskChangesView {...props} requestId="r1" initialPath="a.txt" />,
  );
  view.rerender(
    <TaskChangesView {...props} requestId="r2" initialPath="a.txt" />,
  );
  await screen.findByText("+two");
  finish({ kind: "content", text: "STALE_TURN", truncated: false });
  await Promise.resolve();
  expect(screen.queryByText("STALE_TURN")).toBeNull();
  expect(mocks.request).toHaveBeenLastCalledWith("local", {
    method: "turn_change_diff",
    session_id: "s",
    request_id: "r2",
    path: "a.txt",
  });
  expect(screen.queryByRole("button", { name: "工作区" })).toBeNull();
});
