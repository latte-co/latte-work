// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkbench } from "./useWorkbench";
import type { Request, Session } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({
  native: true,
  localHost: { id: "local", name: "Local" },
  loadHosts: async () => [{ id: "local", name: "Local" }],
  connect: async () => ({ kind: "hello", server_id: "server", agents: [] }),
  request: mocks.request,
  message: String,
}));
let unread: boolean;
let hasMore: boolean;
let focused: boolean;
let status: Session["status"];
const session = (): Session => ({
  id: "s",
  project_id: "p",
  title: "Task",
  agent: "claude",
  native_id: null,
  model: null,
  effort: null,
  status,
  created_at: 1,
  custom_title: false,
  pinned_at: null,
  unread,
  archived: false,
});
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.clearAllMocks();
  unread = true;
  hasMore = false;
  focused = false;
  status = "completed";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  mocks.request.mockImplementation(async (_host: string, r: Request) => {
    if (r.method === "projects")
      return {
        kind: "projects",
        projects: [{ id: "p", name: "P", path: "/p" }],
      };
    if (r.method === "sessions")
      return { kind: "sessions", sessions: [session()] };
    if (r.method === "pinned_sessions")
      return { kind: "sessions", sessions: [] };
    if (r.method === "poll")
      return {
        kind: "events",
        session: session(),
        events: [],
        has_more: hasMore,
      };
    if (r.method === "mark_session_unread") {
      unread = r.unread;
      return { kind: "session", session: session() };
    }
    throw new Error(r.method);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const acknowledgements = () =>
  mocks.request.mock.calls.filter(
    ([, r]) => r.method === "mark_session_unread",
  );
it("preserves completion unread in the background and acknowledges it when viewed", async () => {
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  expect(hook.result.current.session?.unread).toBe(true);
  expect(acknowledgements()).toHaveLength(0);
  focused = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(650);
  });
  expect(acknowledgements()).toHaveLength(1);
  expect(hook.result.current.session?.unread).toBe(false);
});
it("does not acknowledge running output, and marks the completed turn read only at the end of replay", async () => {
  focused = true;
  status = "running";
  renderHook(useWorkbench);
  await act(async () => {});
  expect(acknowledgements()).toHaveLength(0);
  status = "completed";
  hasMore = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(650);
  });
  expect(acknowledgements()).toHaveLength(0);
  hasMore = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(acknowledgements()).toHaveLength(1);
});
