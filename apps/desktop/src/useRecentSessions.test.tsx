// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRecentSessions } from "./useRecentSessions";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("rereads the loaded prefix so inserts and archived older rows do not leave stale pages", async () => {
  vi.useFakeTimers();
  let revision = 0;
  mocks.request.mockImplementation(async (_host, req) => ({
    kind: "recent_sessions",
    sessions: [
      {
        session: { id: req.before ? "old" : `new-${revision}` },
        updated_at: 3,
      },
    ],
    next: req.before ? null : { updated_at: 2, id: "cursor" },
  }));
  const { result } = renderHook(() => useRecentSessions(["local"], true));
  await act(async () => {});
  await act(async () => result.current.more("local"));
  expect(
    result.current.hosts.local.sessions.map((row) => row.session.id),
  ).toEqual(["new-0", "old"]);
  revision = 1;
  mocks.request.mockImplementation(async () => ({
    kind: "recent_sessions",
    sessions: [{ session: { id: "new-1" }, updated_at: 4 }],
    next: null,
  }));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(
    result.current.hosts.local.sessions.map((row) => row.session.id),
  ).toEqual(["new-1"]);
});
it("discards responses from a removed host and stops reading when collapsed", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(({ ids, active }) => useRecentSessions(ids, active), {
    initialProps: { ids: ["remote"], active: true },
  });
  view.rerender({ ids: [], active: false });
  await act(async () =>
    finish({ kind: "recent_sessions", sessions: [], next: null }),
  );
  expect(view.result.current.hosts.remote.loaded).toBe(false);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it("reports unsupported servers instead of a fabricated empty history", async () => {
  mocks.request.mockResolvedValue({ kind: "ok" });
  const { result } = renderHook(() => useRecentSessions(["local"], true));
  await waitFor(() =>
    expect(result.current.hosts.local.error).toContain("更新 Server"),
  );
  expect(result.current.hosts.local.loaded).toBe(false);
});
it("reconciles a mutation immediately after an already pending read", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ kind: "recent_sessions", sessions: [], next: null });
  const { result } = renderHook(() => useRecentSessions(["local"], true));
  act(() => result.current.reload("local"));
  await act(async () =>
    finish({
      kind: "recent_sessions",
      sessions: [{ session: { id: "archived" }, updated_at: 1 }],
      next: null,
    }),
  );
  await waitFor(() => expect(result.current.hosts.local.sessions).toEqual([]));
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
