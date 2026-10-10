// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSubagents } from "./useSubagents";
import type { Subagent } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
afterEach(cleanup);
const task: Subagent = {
  id: "child",
  native_id: "child",
  title: "检查",
  tool_use_id: null,
  status: "running",
  summary: null,
  last_tool: null,
  started_at: 1,
  updated_at: 1,
};
it("ignores late snapshots after host/session switching and marks disconnected live evidence unknown", async () => {
  let first!: (value: unknown) => void;
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    )
    .mockResolvedValue({ kind: "subagents", tasks: [task], truncated: false });
  const hook = renderHook(
    ({ host, session, connected }) =>
      useSubagents(host, session, connected, []),
    { initialProps: { host: "local", session: "one", connected: true } },
  );
  hook.rerender({ host: "remote", session: "two", connected: true });
  await act(async () => {});
  expect(hook.result.current.tasks[0].id).toBe("child");
  await act(async () =>
    first({
      kind: "subagents",
      tasks: [{ ...task, id: "stale" }],
      truncated: false,
    }),
  );
  expect(hook.result.current.tasks[0].id).toBe("child");
  hook.rerender({ host: "remote", session: "two", connected: false });
  expect(hook.result.current.tasks[0].status).toBe("unknown");
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
