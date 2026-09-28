// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentPreferences } from "./useAgentPreferences";
import type { Session } from "./protocol";
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const savedSession = (model: string | null, effort: Session["effort"]) =>
  ({ id: "session", model, effort }) as Session;
it("remembers independent user choices across projects and restarts, scoped by host and agent", () => {
  const hook = renderHook(
    ({ host, agent, project }) =>
      useAgentPreferences(host, agent, project, undefined, false),
    {
      initialProps: { host: "local", agent: "claude", project: "a" },
    },
  );
  expect(hook.result.current.model).toBeNull();
  expect(hook.result.current.effort).toBeNull();
  act(() => hook.result.current.chooseModel("opus"));
  expect(hook.result.current.effort).toBeNull();
  act(() => hook.result.current.chooseEffort("high"));
  hook.rerender({ host: "local", agent: "claude", project: "b" });
  expect(hook.result.current.model).toBe("opus");
  expect(hook.result.current.effort).toBe("high");
  hook.rerender({ host: "local", agent: "other", project: "b" });
  expect(hook.result.current.model).toBeNull();
  act(() => hook.result.current.chooseModel("other-model"));
  hook.rerender({ host: "remote", agent: "claude", project: "b" });
  expect(hook.result.current.effort).toBeNull();
  hook.unmount();
  const restored = renderHook(() =>
    useAgentPreferences("local", "claude", "c", undefined, false),
  );
  expect(restored.result.current.model).toBe("opus");
  expect(restored.result.current.effort).toBe("high");
});
it("keeps existing session overrides and explicit native inheritance separate from new-task preferences", () => {
  const hook = renderHook(
    ({ session }) =>
      useAgentPreferences("local", "claude", "p", session, false),
    { initialProps: { session: undefined as Session | undefined } },
  );
  act(() => {
    hook.result.current.chooseModel("opus");
    hook.result.current.chooseEffort("high");
  });
  hook.rerender({ session: savedSession("sonnet", null) });
  expect(hook.result.current.model).toBe("sonnet");
  expect(hook.result.current.effort).toBeNull();
  act(() => hook.result.current.chooseEffort("low"));
  hook.rerender({ session: undefined });
  expect(hook.result.current.model).toBe("opus");
  expect(hook.result.current.effort).toBe("low");
  act(() => {
    hook.result.current.chooseModel(null);
    hook.result.current.chooseEffort(null);
  });
  hook.unmount();
  const restored = renderHook(() =>
    useAgentPreferences("local", "claude", "p", undefined, false),
  );
  expect(restored.result.current.model).toBeNull();
  expect(restored.result.current.effort).toBeNull();
});
it("does not reset an in-flight or failed first send when the draft becomes a session", () => {
  const hook = renderHook(
    ({ session, sending }) =>
      useAgentPreferences("local", "claude", "p", session, sending),
    {
      initialProps: {
        session: undefined as Session | undefined,
        sending: false,
      },
    },
  );
  act(() => {
    hook.result.current.chooseModel("opus");
    hook.result.current.chooseEffort("high");
  });
  hook.rerender({ session: savedSession(null, null), sending: true });
  hook.rerender({ session: savedSession(null, null), sending: false });
  expect(hook.result.current.model).toBe("opus");
  expect(hook.result.current.effort).toBe("high");
});
it("capability cleanup does not erase the user's remembered choice and storage failures are visible", () => {
  const hook = renderHook(() =>
    useAgentPreferences("local", "claude", "p", undefined, false),
  );
  act(() => hook.result.current.chooseEffort("high"));
  act(() => hook.result.current.clearUnsupportedEffort());
  expect(hook.result.current.effort).toBeNull();
  hook.unmount();
  const restored = renderHook(() =>
    useAgentPreferences("local", "claude", "p", undefined, false),
  );
  expect(restored.result.current.effort).toBe("high");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  act(() => restored.result.current.chooseModel("sonnet"));
  expect(restored.result.current.model).toBe("sonnet");
  expect(restored.result.current.error).toContain("无法保存");
});
it("ignores malformed or unbounded stored preferences", () => {
  const key = 'latte-work.agent-selection.v1:["local","claude"]';
  for (const raw of [
    "{",
    "null",
    "[]",
    JSON.stringify({ model: "a".repeat(4097), effort: "invalid" }),
  ]) {
    localStorage.setItem(key, raw);
    const hook = renderHook(() =>
      useAgentPreferences("local", "claude", "p", undefined, false),
    );
    expect(hook.result.current.model).toBeNull();
    expect(hook.result.current.effort).toBeNull();
    hook.unmount();
  }
});
it("remembers native permission ids per host/agent and restores session inheritance", () => {
  const hook = renderHook(
    ({ host, agent, session }) =>
      useAgentPreferences(host, agent, "p", session, false),
    {
      initialProps: {
        host: "local",
        agent: "claude",
        session: undefined as Session | undefined,
      },
    },
  );
  expect(hook.result.current.permissionMode).toBeNull();
  act(() => hook.result.current.choosePermissionMode("bypassPermissions"));
  hook.rerender({ host: "remote", agent: "claude", session: undefined });
  expect(hook.result.current.permissionMode).toBeNull();
  hook.rerender({ host: "local", agent: "other", session: undefined });
  expect(hook.result.current.permissionMode).toBeNull();
  hook.rerender({
    host: "local",
    agent: "claude",
    session: savedSession(null, null),
  });
  expect(hook.result.current.permissionMode).toBeNull();
  hook.unmount();
  const restored = renderHook(() =>
    useAgentPreferences("local", "claude", "p2", undefined, false),
  );
  expect(restored.result.current.permissionMode).toBe("bypassPermissions");
  act(() => restored.result.current.choosePermissionMode(null));
  restored.unmount();
  const inherited = renderHook(() =>
    useAgentPreferences("local", "claude", "p3", undefined, false),
  );
  expect(inherited.result.current.permissionMode).toBeNull();
});
