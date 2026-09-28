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
      return {
        kind: "providers",
        providers: [
          {
            id: "test-provider",
            name: "Test Provider",
            protocol: "anthropic_messages",
            base_url: "https://example.test",
            model: "model",
            models: [],
            auth: "bearer",
            has_credential: true,
            revision: "r",
          },
        ],
        bindings:
          command === "bind_agent_provider"
            ? [{ agent: "claude", provider_id: "test-provider" }]
            : [],
      };
    throw new Error("Unexpected call");
  });
  render(
    <AgentSettings
      state={{ host: remote, hosts: [remote] } as Workbench}
      active
      onBusy={() => {}}
    />,
  );
  const save = await screen.findByRole("button", { name: "保存关联" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("combobox", { name: "Claude Code 关联 Provider" }),
  );
  fireEvent.click(screen.getByRole("option", { name: /Test Provider/ }));
  fireEvent.click(save);
  await screen.findByText("关联已保存；下次发送消息时使用最新配置。");
  expect(invoke).toHaveBeenCalledWith("bind_agent_provider", {
    hostId: "devbox",
    agent: "claude",
    providerId: "test-provider",
  });
  expect(
    invoke.mock.calls.filter(([command]) => command === "connect_host"),
  ).toEqual([["connect_host", { host: remote, password: undefined }]]);
});
it("retains an unsaved Provider form while settings are hidden, without saving credentials", async () => {
  invoke.mockResolvedValue({ kind: "providers", providers: [], bindings: [] });
  const view = render(<ProviderSettings active onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 Provider" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "unsaved" },
  });
  fireEvent.change(screen.getByLabelText("凭据"), {
    target: { value: "fixture-key" },
  });
  view.rerender(<ProviderSettings active={false} onBusy={() => {}} />);
  view.rerender(<ProviderSettings active onBusy={() => {}} />);
  await waitFor(() =>
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "unsaved",
    ),
  );
  expect((screen.getByLabelText("凭据") as HTMLInputElement).value).toBe(
    "fixture-key",
  );
  expect(
    invoke.mock.calls.every(
      ([command, args]) =>
        command === "provider_request" && args.request.method === "providers",
    ),
  ).toBe(true);
});
