// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSubagentTranscript } from "./useSubagentTranscript";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
beforeEach(() => mocks.request.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const reply = (text: string) => ({
  kind: "subagent_transcript",
  events: [{ seq: 1, session_id: "s", at: 1, event: { kind: "text", text } }],
  truncated: false,
});
it.each(["child", "host", "connection"])(
  "rejects a delayed response after %s changes",
  async (change) => {
    let resolve!: (value: unknown) => void;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(reply("fresh"));
    const hook = renderHook(
      ({ host, task, version }) =>
        useSubagentTranscript(host, "s", task, true, false, undefined, version),
      { initialProps: { host: "local", task: "a", version: 0 } },
    );
    hook.rerender({
      host: change === "host" ? "remote" : "local",
      task: change === "child" ? "b" : "a",
      version: change === "connection" ? 1 : 0,
    });
    await act(async () => {});
    await act(async () => resolve(reply("stale")));
    expect(hook.result.current.events[0].event).toEqual({
      kind: "text",
      text: "fresh",
    });
  },
);
it("polls visible running children, retains evidence while hidden and ignores a pending read after close", async () => {
  vi.useFakeTimers();
  mocks.request.mockResolvedValue(reply("first"));
  const hook = renderHook(
    ({ active }) => useSubagentTranscript("local", "s", "a", active, true),
    { initialProps: { active: true } },
  );
  await act(async () => {});
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  hook.rerender({ active: false });
  await act(async () => resolve(reply("late")));
  expect(hook.result.current.events[0].event).toEqual({
    kind: "text",
    text: "first",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("keeps recorded output on read failure and explains unsupported old servers", async () => {
  mocks.request
    .mockResolvedValueOnce(reply("recorded"))
    .mockRejectedValueOnce(new Error("unknown variant `subagent_transcript`"));
  const hook = renderHook(
    ({ revision }) =>
      useSubagentTranscript("local", "s", "a", true, false, revision),
    { initialProps: { revision: 0 } },
  );
  await act(async () => {});
  hook.rerender({ revision: 1 });
  await act(async () => {});
  expect(hook.result.current.events).toHaveLength(1);
  expect(hook.result.current.error).toContain("请更新 Server");
});

it("coalesces frequent task revisions without cancelling or overlapping a slow read", async () => {
  let resolve!: (v: unknown) => void;
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue(reply("latest"));
  const hook = renderHook(
    ({ revision }) =>
      useSubagentTranscript("local", "s", "a", true, true, revision),
    { initialProps: { revision: 0 } },
  );
  for (let revision = 1; revision <= 5; revision++) hook.rerender({ revision });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  await act(async () => resolve(reply("first read")));
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(hook.result.current.events[0].event).toEqual({
    kind: "text",
    text: "latest",
  });
});
it("does a final read when completion arrives during an active read, then stops polling", async () => {
  vi.useFakeTimers();
  let resolve!: (v: unknown) => void;
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue(reply("final"));
  const hook = renderHook(
    ({ running }) => useSubagentTranscript("local", "s", "a", true, running),
    { initialProps: { running: true } },
  );
  hook.rerender({ running: false });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  await act(async () => resolve(reply("progress")));
  expect(hook.result.current.events[0].event).toEqual({
    kind: "text",
    text: "final",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("retains captured output across a failed reconnect and rejects the old connection's response", async () => {
  mocks.request.mockResolvedValueOnce(reply("saved"));
  const hook = renderHook(
    ({ version }) =>
      useSubagentTranscript("local", "s", "a", true, false, 0, version),
    { initialProps: { version: 0 } },
  );
  await act(async () => {});
  let resolve!: (v: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  hook.rerender({ version: 1 });
  mocks.request.mockRejectedValueOnce(new Error("disconnected"));
  hook.rerender({ version: 2 });
  await act(async () => {});
  await act(async () => resolve(reply("stale connection")));
  expect(hook.result.current.events[0].event).toEqual({
    kind: "text",
    text: "saved",
  });
  expect(hook.result.current.error).toContain("disconnected");
});
