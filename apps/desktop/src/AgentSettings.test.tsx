// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { AgentSettings } from "./AgentSettings";
import type { Workbench } from "./useWorkbench";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const host = {
  id: "env-devbox",
  name: "Env Devbox",
  ssh: "env-devbox",
  server_path: null,
};
const state = { host, hosts: [host] } as Workbench;
function setup(supported = true) {
  let saved = { claude: { HTTPS_PROXY: "http://saved.test:7890" } };
  invoke.mockImplementation(async (command, args) => {
    if (command === "connect_host")
      return {
        kind: "hello",
        server_id: "env-server",
        custom_agent_environment: supported,
        agents: [
          {
            id: "claude",
            name: "Claude Code",
            detail: "Fixture",
            provider_protocols: ["anthropic_messages"],
          },
          {
            id: "codex",
            name: "Codex",
            detail: "Fixture",
            provider_protocols: ["openai_responses"],
          },
        ],
      };
    if (command === "agent_providers")
      return { kind: "providers", providers: [], bindings: [] };
    if (command === "agent_environments")
      return args.hostId === host.id ? saved : {};
    if (command === "save_agent_environment") {
      saved = { ...saved, [args.agent]: args.environment };
      return args.environment;
    }
    throw new Error("Unexpected native command");
  });
}
function saveButton(field: HTMLElement) {
  return within(field.closest(".agent-card") as HTMLElement).getByRole(
    "button",
    { name: "保存环境变量" },
  ) as HTMLButtonElement;
}

it("loads host and Agent settings, saves literal ENV independently and restores after reopening", async () => {
  setup();
  const onBusy = vi.fn();
  const view = render(<AgentSettings state={state} active onBusy={onBusy} />);
  const field = (await screen.findByLabelText(
    "Claude Code 环境变量",
  )) as HTMLTextAreaElement;
  expect(field.value).toBe("HTTPS_PROXY=http://saved.test:7890");
  expect(
    (screen.getByLabelText("Codex 环境变量") as HTMLTextAreaElement).value,
  ).toBe("");
  expect(saveButton(field).disabled).toBe(true);
  fireEvent.change(field, {
    target: {
      value:
        "HTTP_PROXY=http://proxy:7890\nEMPTY=\nLITERAL=$(do-not-run)=value",
    },
  });
  fireEvent.click(saveButton(field));
  await screen.findByText(/环境变量已保存；下次启动/);
  expect(invoke).toHaveBeenCalledWith("save_agent_environment", {
    hostId: host.id,
    agent: "claude",
    environment: {
      HTTP_PROXY: "http://proxy:7890",
      EMPTY: "",
      LITERAL: "$(do-not-run)=value",
    },
  });
  expect(onBusy.mock.calls).toEqual([[true], [false]]);
  expect(saveButton(field).disabled).toBe(true);
  view.rerender(<AgentSettings state={state} active={false} onBusy={onBusy} />);
  view.rerender(<AgentSettings state={state} active onBusy={onBusy} />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
        .value,
    ).toContain("HTTP_PROXY=http://proxy:7890"),
  );
  expect(
    invoke.mock.calls.some(
      ([command]) =>
        command === "host_request" || command === "bind_agent_provider",
    ),
  ).toBe(false);
});

it("rejects invalid ENV and retains edits after a save failure", async () => {
  setup();
  render(<AgentSettings state={state} active onBusy={() => {}} />);
  const field = (await screen.findByLabelText(
    "Claude Code 环境变量",
  )) as HTMLTextAreaElement;
  fireEvent.change(field, {
    target: { value: "TOKEN=private-value\nTOKEN=another" },
  });
  expect(screen.getByRole("alert").textContent).toContain("变量名重复");
  expect(screen.getByRole("alert").textContent).not.toContain("private-value");
  expect(saveButton(field).disabled).toBe(true);
  fireEvent.change(field, {
    target: { value: "HTTP_PROXY=http://retry.test:7890" },
  });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) =>
    command === "save_agent_environment"
      ? Promise.reject(new Error("无法保存配置"))
      : original(command, args),
  );
  fireEvent.click(saveButton(field));
  await screen.findByText("无法保存配置");
  expect(field.value).toBe("HTTP_PROXY=http://retry.test:7890");
  expect(saveButton(field).disabled).toBe(false);
});

it("disables ENV editing on an older Server and explains the required update", async () => {
  setup(false);
  render(<AgentSettings state={state} active onBusy={() => {}} />);
  const field = (await screen.findByLabelText(
    "Claude Code 环境变量",
  )) as HTMLTextAreaElement;
  expect(field.disabled).toBe(true);
  expect(saveButton(field).disabled).toBe(true);
  expect(screen.getAllByText(/需要更新 Server 并重新连接/)).toHaveLength(2);
});

it("keeps hosts isolated when switching the settings target", async () => {
  setup();
  const other = { ...host, id: "other-env-host", name: "Other Host" };
  render(
    <AgentSettings
      state={{ ...state, hosts: [host, other] } as Workbench}
      active
      onBusy={() => {}}
    />,
  );
  const field = (await screen.findByLabelText(
    "Claude Code 环境变量",
  )) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "TOKEN=unsaved-private-value" } });
  fireEvent.click(screen.getByRole("combobox", { name: "运行主机" }));
  fireEvent.click(screen.getByRole("option", { name: "Other Host" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
        .value,
    ).toBe(""),
  );
  expect(invoke).toHaveBeenCalledWith("agent_environments", {
    hostId: other.id,
  });
  fireEvent.click(screen.getByRole("combobox", { name: "运行主机" }));
  fireEvent.click(screen.getByRole("option", { name: host.name }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
        .value,
    ).toBe("TOKEN=unsaved-private-value"),
  );
  expect(
    (screen.getByLabelText("Codex 环境变量") as HTMLTextAreaElement).value,
  ).toBe("");
  expect(
    invoke.mock.calls.some(([command]) => command === "save_agent_environment"),
  ).toBe(false);
});

it.each(["", "TOKEN=first\nTOKEN=invalid-draft"])(
  "retains an unsaved ENV draft (%j) across category changes and reconnects",
  async (draft) => {
    setup();
    const onBusy = vi.fn();
    const view = render(<AgentSettings state={state} active onBusy={onBusy} />);
    fireEvent.change(await screen.findByLabelText("Claude Code 环境变量"), {
      target: { value: draft },
    });
    fireEvent.change(screen.getByLabelText("Codex 环境变量"), {
      target: { value: "CODEX_TOKEN=independent-unsaved-value" },
    });
    view.rerender(
      <AgentSettings state={state} active={false} onBusy={onBusy} />,
    );
    view.rerender(<AgentSettings state={state} active onBusy={onBusy} />);
    const reopened = (await screen.findByLabelText(
      "Claude Code 环境变量",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(reopened.disabled).toBe(false));
    expect(reopened.value).toBe(draft);
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    const reconnected = (await screen.findByLabelText(
      "Claude Code 环境变量",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(reconnected.disabled).toBe(false));
    expect(reconnected.value).toBe(draft);
    expect(
      (screen.getByLabelText("Codex 环境变量") as HTMLTextAreaElement).value,
    ).toBe("CODEX_TOKEN=independent-unsaved-value");
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "save_agent_environment",
      ),
    ).toBe(false);
  },
);

it("refreshes clean ENV while retaining dirty input against the latest saved baseline", async () => {
  setup();
  render(<AgentSettings state={state} active onBusy={() => {}} />);
  await screen.findByLabelText("Claude Code 环境变量");
  const original = invoke.getMockImplementation()!;
  let saved = { HTTPS_PROXY: "http://external.test:7890" };
  invoke.mockImplementation((command, args) =>
    command === "agent_environments"
      ? Promise.resolve({ claude: saved })
      : original(command, args),
  );
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  let field = (await screen.findByLabelText(
    "Claude Code 环境变量",
  )) as HTMLTextAreaElement;
  await waitFor(() =>
    expect(field.value).toBe("HTTPS_PROXY=http://external.test:7890"),
  );
  expect(saveButton(field).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "TOKEN=keep-this-draft" } });
  saved = { HTTPS_PROXY: "http://newer.test:7890" };
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  field = (await screen.findByLabelText(
    "Claude Code 环境变量",
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  expect(field.value).toBe("TOKEN=keep-this-draft");
  expect(saveButton(field).disabled).toBe(false);
});
