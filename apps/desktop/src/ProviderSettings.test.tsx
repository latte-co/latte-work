// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ProviderSettings } from "./ProviderSettings";
import { AgentSettings } from "./AgentSettings";
import type { Workbench } from "./useWorkbench";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("manages App Providers while every Server is unavailable", async () => {
  invoke.mockImplementation(async (command, { request }) => {
    if (command !== "provider_request") throw new Error("Server unavailable");
    return {
      kind: "providers",
      providers:
        request.method === "save_provider"
          ? [
              {
                ...request.provider,
                id: "saved",
                has_credential: true,
                revision: "r",
                credential: undefined,
              },
            ]
          : [],
      bindings: [],
    };
  });
  render(<ProviderSettings active onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 Provider" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "App-only" },
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://example.test" },
  });
  fireEvent.change(screen.getByLabelText("默认模型 ID"), {
    target: { value: "model" },
  });
  fireEvent.change(screen.getByLabelText("凭据"), {
    target: { value: "test-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
  await screen.findByText("App-only");
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByText("App-only")).toBeNull());
  expect(
    invoke.mock.calls.every(([command]) => command === "provider_request"),
  ).toBe(true);
  expect(invoke).toHaveBeenCalledWith("provider_request", {
    request: { method: "delete_provider", id: "saved" },
  });
});
it("loads and saves remote Agent associations without connecting to the local Server", async () => {
  const remote = {
    id: "devbox",
    name: "Devbox",
    ssh: "devbox",
    server_path: null,
  };
  invoke.mockImplementation(async (command, args) => {
    if (command === "connect_host") {
      if (args.host.id === "local") throw new Error("Local Server unavailable");
      return {
        kind: "hello",
        server_id: "remote",
        agents: [
          {
            id: "claude",
            name: "Claude Code",
            detail: "Remote",
            provider_protocols: ["anthropic_messages"],
          },
        ],
      };
    }
    if (command === "agent_providers" || command === "bind_agent_provider")
      return { kind: "providers", providers: [], bindings: [] };
    throw new Error("Unexpected call");
  });
  render(
    <AgentSettings
      state={{ host: remote, hosts: [remote] } as Workbench}
      active
      onBusy={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "保存关联" }));
  await screen.findByText("关联已保存；下次发送消息时使用最新配置。");
  expect(invoke).toHaveBeenCalledWith("bind_agent_provider", {
    hostId: "devbox",
    agent: "claude",
    providerId: null,
  });
  expect(
    invoke.mock.calls.filter(([command]) => command === "connect_host"),
  ).toEqual([["connect_host", { host: remote, password: undefined }]]);
});
