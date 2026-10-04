import { beforeEach, expect, it, vi } from "vitest";
import {
  openProjectSessions,
  needsCloseConfirmation,
  closeProjectSessions,
} from "./projectSessions";
import type { Session } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
const session = (id: string, patch = {}) =>
  ({
    id,
    project_id: "p",
    status: "completed",
    agent_session_open: true,
    agent_session_busy: false,
    ...patch,
  }) as Session;
beforeEach(() => vi.clearAllMocks());
it("includes pinned and unselected open sessions and excludes closed history", async () => {
  mocks.request.mockResolvedValue({
    kind: "sessions",
    sessions: [
      session("pinned", { pinned_at: 1 }),
      session("other"),
      session("history", { agent_session_open: false }),
    ],
  });
  expect((await openProjectSessions("remote", "p")).map((s) => s.id)).toEqual([
    "pinned",
    "other",
  ]);
  expect(mocks.request).toHaveBeenCalledWith("remote", {
    method: "sessions",
    project_id: "p",
  });
});
it("does not infer closed state from older servers or task completion", async () => {
  mocks.request.mockResolvedValue({
    kind: "sessions",
    sessions: [session("old", { agent_session_open: undefined })],
  });
  await expect(openProjectSessions("remote", "p")).rejects.toThrow(
    "未提供会话状态",
  );
  expect(
    needsCloseConfirmation([
      session("background", { agent_session_busy: true }),
    ]),
  ).toBe(true);
  expect(
    needsCloseConfirmation([session("waiting", { status: "waiting" })]),
  ).toBe(true);
  expect(
    needsCloseConfirmation([
      session("unknown", { agent_session_busy: undefined }),
    ]),
  ).toBe(true);
  expect(needsCloseConfirmation([session("idle")])).toBe(false);
});
it("reports partial failures and retries only failed sessions on their host", async () => {
  const close = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("offline"));
  const result = await closeProjectSessions(
    "remote",
    "p",
    [session("a"), session("b")],
    close,
  );
  expect(result.closed).toEqual(["a"]);
  expect(result.failed[0].session.id).toBe("b");
  close.mockResolvedValue(undefined);
  await closeProjectSessions(
    "remote",
    "p",
    result.failed.map((x) => x.session),
    close,
  );
  expect(close.mock.calls).toEqual([
    ["remote", "a"],
    ["remote", "b"],
    ["remote", "b"],
  ]);
});
