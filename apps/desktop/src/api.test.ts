// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { connect, request } from "./api";
import {
  HOST_DISCONNECTED_EVENT,
  HostConnectionError,
} from "./connectionErrors";
afterEach(() => vi.resetAllMocks());

it("reports confirmed native transport failure from metadata requests", async () => {
  const listener = vi.fn();
  window.addEventListener(HOST_DISCONNECTED_EVENT, listener);
  try {
    mocks.invoke.mockRejectedValue("HOST_CONNECTION_LOST:连接已失效");
    await expect(
      request("test-host", { method: "agent_permissions", agent: "claude" }),
    ).rejects.toBeInstanceOf(HostConnectionError);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toMatchObject({
      hostId: "test-host",
      message: "连接已失效",
    });
  } finally {
    window.removeEventListener(HOST_DISCONNECTED_EVENT, listener);
  }
});

it("does not classify Server or Provider configuration errors as disconnects", async () => {
  const listener = vi.fn();
  window.addEventListener(HOST_DISCONNECTED_EVENT, listener);
  try {
    mocks.invoke.mockResolvedValueOnce({
      kind: "error",
      code: "unsupported",
      message: "权限选项不支持",
    });
    await expect(
      request("test-host", { method: "agent_permissions", agent: "claude" }),
    ).rejects.toThrow("权限选项不支持");
    mocks.invoke.mockRejectedValueOnce("Provider 配置无效");
    await expect(
      request("test-host", {
        method: "models",
        agent: "claude",
        model: null,
        project_id: null,
      }),
    ).rejects.toBe("Provider 配置无效");
    expect(listener).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(HOST_DISCONNECTED_EVENT, listener);
  }
});

it("ignores a late failure from a transport replaced by reconnect", async () => {
  let reject!: (error: string) => void;
  mocks.invoke.mockImplementation((command) =>
    command === "host_request"
      ? new Promise((_, fail) => {
          reject = fail;
        })
      : Promise.resolve({ kind: "hello" }),
  );
  const listener = vi.fn();
  window.addEventListener(HOST_DISCONNECTED_EVENT, listener);
  try {
    const pending = request("reconnect-host", { method: "projects" });
    const failure = expect(pending).rejects.toBeInstanceOf(HostConnectionError);
    await connect({
      id: "reconnect-host",
      name: "Test",
      ssh: null,
      server_path: null,
    });
    reject("HOST_CONNECTION_LOST:连接已失效");
    await failure;
    expect(listener).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(HOST_DISCONNECTED_EVENT, listener);
  }
});
