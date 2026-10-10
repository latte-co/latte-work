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
  expect(result.current.hosts.local.errorKind).toBe("unsupported");
});
it("identifies the legacy server's command rejection and waits for retry or a new connection", async () => {
  vi.useFakeTimers();
  mocks.request.mockRejectedValueOnce(
    new Error(
      "unknown variant `recent_sessions`, expected one of `hello`, `projects`, `sessions`",
    ),
  );
  const view = renderHook(
    ({ version }) => useRecentSessions(["remote"], true, { remote: version }),
    { initialProps: { version: 1 } },
  );
  await act(async () => {});
  expect(view.result.current.hosts.remote.errorKind).toBe("unsupported");
  expect(view.result.current.hosts.remote.error).toContain("更新 Server");
  expect(view.result.current.hosts.remote.loaded).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(mocks.request).toHaveBeenCalledTimes(1);
  mocks.request.mockResolvedValueOnce({
    kind: "recent_sessions",
    sessions: [],
    next: null,
  });
  view.rerender({ version: 2 });
  await act(async () => {});
  expect(view.result.current.hosts.remote.loaded).toBe(true);
  expect(view.result.current.hosts.remote.errorKind).toBeNull();
  expect(mocks.request).toHaveBeenCalledTimes(2);
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
it("retains the previous error until a retry succeeds and preserves successfully loaded rows", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.request
    .mockResolvedValueOnce({
      kind: "recent_sessions",
      sessions: [{ session: { id: "saved" }, updated_at: 1 }],
      next: null,
    })
    .mockRejectedValueOnce(new Error("刷新失败"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const { result } = renderHook(() => useRecentSessions(["remote"], true));
  await waitFor(() => expect(result.current.hosts.remote.loaded).toBe(true));
  act(() => result.current.reload("remote"));
  await waitFor(() =>
    expect(result.current.hosts.remote.errorKind).toBe("refresh"),
  );
  act(() => result.current.reload("remote"));
  expect(result.current.hosts.remote.loading).toBe(true);
  expect(result.current.hosts.remote.error).toContain("刷新失败");
  expect(result.current.hosts.remote.errorKind).toBe("refresh");
  expect(result.current.hosts.remote.sessions[0].session.id).toBe("saved");
  await act(async () =>
    finish({ kind: "recent_sessions", sessions: [], next: null }),
  );
  expect(result.current.hosts.remote.loading).toBe(false);
  expect(result.current.hosts.remote.error).toBe("");
});
it("ignores late failures from a replaced connection after the new connection succeeds", async () => {
  let failOld: (error: Error) => void = () => {};
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failOld = reject;
        }),
    )
    .mockResolvedValueOnce({
      kind: "recent_sessions",
      sessions: [{ session: { id: "new" }, updated_at: 1 }],
      next: null,
    });
  const view = renderHook(
    ({ version }) => useRecentSessions(["remote"], true, { remote: version }),
    { initialProps: { version: 1 } },
  );
  view.rerender({ version: 2 });
  await waitFor(() =>
    expect(view.result.current.hosts.remote.loaded).toBe(true),
  );
  await act(async () => failOld(new Error("旧连接已关闭")));
  expect(view.result.current.hosts.remote.error).toBe("");
  expect(view.result.current.hosts.remote.sessions[0].session.id).toBe("new");
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
