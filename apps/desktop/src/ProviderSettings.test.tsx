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
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "test-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  fireEvent.change(screen.getByLabelText("模型 ID 1"), {
    target: { value: "model-two" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  fireEvent.change(screen.getByLabelText("模型 ID 2"), {
    target: { value: "remove-me" },
  });
  fireEvent.click(screen.getByRole("button", { name: "删除模型 2" }));
  fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
  await screen.findByText("App-only");
  expect(invoke).toHaveBeenCalledWith("provider_request", {
    request: {
      method: "save_provider",
      provider: expect.objectContaining({
        model: "model",
        models: ["model-two"],
      }),
    },
  });
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
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "fixture-key" },
  });
  view.rerender(<ProviderSettings active={false} onBusy={() => {}} />);
  view.rerender(<ProviderSettings active onBusy={() => {}} />);
  await waitFor(() =>
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "unsaved",
    ),
  );
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
    "fixture-key",
  );
  expect(
    invoke.mock.calls.every(
      ([command, args]) =>
        command === "provider_request" && args.request.method === "providers",
    ),
  ).toBe(true);
});
it("saves an empty API Key as no authentication without an auth selector", async () => {
  invoke.mockResolvedValue({ kind: "providers", providers: [], bindings: [] });
  render(<ProviderSettings active onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 Provider" }));
  expect(screen.queryByLabelText("认证方式")).toBeNull();
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "Local" },
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "http://localhost:8000" },
  });
  fireEvent.change(screen.getByLabelText("默认模型 ID"), {
    target: { value: "model" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "temporary" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("provider_request", {
      request: {
        method: "save_provider",
        provider: expect.objectContaining({ auth: "none", credential: null }),
      },
    }),
  );
});
it("merges fetched models without replacing custom names and saves ID/name mappings", async () => {
  const provider = {
    id: "p",
    name: "Named",
    protocol: "anthropic_messages",
    base_url: "https://example.test",
    model: "one",
    models: ["one"],
    model_labels: { one: "My name" },
    auth: "api_key",
  };
  invoke.mockImplementation(async (command) =>
    command === "fetch_provider_models"
      ? [
          { id: "one", name: "Backend name" },
          { id: "two", name: "Second" },
        ]
      : { kind: "providers", providers: [provider], bindings: [] },
  );
  render(<ProviderSettings active onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("显示名称 2") as HTMLInputElement).value,
    ).toBe("Second"),
  );
  expect((screen.getByLabelText("显示名称 1") as HTMLInputElement).value).toBe(
    "My name",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("provider_request", {
      request: {
        method: "save_provider",
        provider: expect.objectContaining({
          models: ["one", "two"],
          model_labels: { one: "My name", two: "Second" },
          credential: null,
        }),
      },
    }),
  );
});
it("keeps the edited catalog after a model discovery failure", async () => {
  invoke.mockImplementation(async (command) => {
    if (command === "fetch_provider_models") throw new Error("HTTP 401");
    return { kind: "providers", providers: [], bindings: [] };
  });
  render(<ProviderSettings active onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "添加 Provider" }));
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  fireEvent.change(screen.getByLabelText("模型 ID 1"), {
    target: { value: "manual" },
  });
  fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
  await screen.findByText("HTTP 401");
  expect((screen.getByLabelText("模型 ID 1") as HTMLInputElement).value).toBe(
    "manual",
  );
});
