// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import type { Response } from "./protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  selector: vi.fn((_props: unknown) => null),
}));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("./ModelSelector", () => ({ ModelSelector: mocks.selector }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("groups a declared Provider 1M mode as 默认 / 1M, restores it, and drops it when support is removed", async () => {
  const onChange = vi.fn();
  const ready = vi.fn();
  const catalog = {
    kind: "models",
    models: ["custom", "small", "custom[1m]"],
    provider: "Team",
    default_model: "custom",
    effort_levels: [],
    model_labels: { custom: "Custom model" },
    model_variants: {
      custom: [
        { model: "custom", label: "默认", context_window: 200000 },
        { model: "custom[1m]", label: "1M", context_window: 1000000 },
      ],
    },
  };
  mocks.request.mockResolvedValue(catalog);
  const props = {
    hostId: "devbox",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "custom[1m]",
    onChange,
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  const selected = mocks.selector.mock.calls.at(-1)![0] as {
    value: string;
    options: {
      value: string;
      variants?: { value: string; label: string; contextWindow?: number }[];
    }[];
    onChange: (value: string) => void;
  };
  expect(selected.value).toBe("custom[1m]");
  expect(selected.options.map((option) => option.value)).toEqual([
    "custom",
    "small",
  ]);
  expect(selected.options[0].variants).toEqual([
    expect.objectContaining({
      value: "custom",
      label: "默认",
      contextWindow: 200000,
      description: "200K context",
    }),
    expect.objectContaining({
      value: "custom[1m]",
      label: "1M",
      contextWindow: 1000000,
    }),
  ]);
  selected.onChange("custom[1m]");
  expect(onChange).toHaveBeenCalledWith("custom[1m]");
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
  onChange.mockClear();
  view.rerender(<ModelPicker {...props} settingsOpen />);
  mocks.request.mockResolvedValue({
    ...catalog,
    models: ["custom", "small"],
    model_variants: undefined,
  });
  view.rerender(<ModelPicker {...props} />);
  await act(async () => {});
  expect(onChange).toHaveBeenCalledWith("custom");
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});
it("presents Traex native names and sends the unchanged native ID when selected", async () => {
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["Doubao-Seed-Evolving", "alwaysday1"],
    provider: null,
    default_model: "Doubao-Seed-Evolving",
    effort_levels: [],
    model_labels: {
      "Doubao-Seed-Evolving": "Seed-Evolving",
      alwaysday1: "auto_model/alwaysday1",
    },
  });
  const onChange = vi.fn();
  render(
    <ModelPicker
      hostId="local"
      agent="traex"
      connected
      settingsOpen={false}
      value="Doubao-Seed-Evolving"
      onChange={onChange}
      effort={null}
      onEffortChange={vi.fn()}
      disabled={false}
    />,
  );
  await act(async () => {});
  const props = mocks.selector.mock.calls.at(-1)![0] as unknown as {
    options: { value: string; label: string; description?: string }[];
    onChange: (value: string) => void;
  };
  expect(props.options).toEqual([
    { value: "", label: "default" },
    {
      value: "Doubao-Seed-Evolving",
      label: "Seed-Evolving",
      description: undefined,
    },
    {
      value: "alwaysday1",
      label: "auto_model/alwaysday1",
      description: undefined,
    },
  ]);
  props.onChange("alwaysday1");
  expect(onChange).toHaveBeenCalledWith("alwaysday1");
});
it("ignores stale catalogs and clears unsupported effort without recording a user preference", async () => {
  const responses: ((value: Response) => void)[] = [];
  mocks.request.mockImplementation(
    () => new Promise((resolve) => responses.push(resolve)),
  );
  const change = vi.fn(),
    invalid = vi.fn();
  const props = {
    hostId: "local",
    projectId: "p",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "haiku",
    onChange: vi.fn(),
    effort: "high" as const,
    onEffortChange: change,
    onEffortInvalid: invalid,
    disabled: false,
  };
  const view = render(<ModelPicker {...props} />);
  view.rerender(<ModelPicker {...props} value="opus" />);
  const catalog = (levels: "high"[]): Response => ({
    kind: "models",
    models: ["haiku", "opus"],
    provider: null,
    default_model: null,
    effort_levels: levels,
    model_labels: {},
  });
  await act(async () => responses[0](catalog([])));
  expect(invalid).not.toHaveBeenCalled();
  await act(async () => responses[1](catalog(["high"])));
  expect(invalid).not.toHaveBeenCalled();
  view.rerender(<ModelPicker {...props} />);
  await act(async () => responses[2](catalog([])));
  expect(invalid).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});

it("replaces a stale Claude alias with the provider model while preserving valid selections", async () => {
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["team-code", "team-fast"],
    provider: "Team",
    default_model: "team-code",
    effort_levels: [],
    model_labels: {},
  });
  const onChange = vi.fn();
  const props = {
    hostId: "local",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "opus",
    onChange,
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  expect(onChange).toHaveBeenCalledWith("team-code");
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "team-code",
      options: [
        expect.objectContaining({ value: "team-code" }),
        expect.objectContaining({ value: "team-fast" }),
      ],
    }),
    undefined,
  );
  onChange.mockClear();
  view.rerender(<ModelPicker {...props} value="team-fast" />);
  await act(async () => {});
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<ModelPicker {...props} value={null} />);
  await act(async () => {});
  expect(onChange).toHaveBeenCalledWith("team-code");
});

it("keeps sending blocked until a provider fallback and its capabilities are both current", async () => {
  const responses: ((value: Response) => void)[] = [];
  mocks.request.mockImplementation(
    () => new Promise((resolve) => responses.push(resolve)),
  );
  const ready = vi.fn(),
    change = vi.fn();
  const props = {
    hostId: "remote",
    projectId: "p",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "opus",
    onChange: change,
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  const catalog: Response = {
    kind: "models",
    models: ["real-id"],
    provider: "Dev",
    default_model: "real-id",
    effort_levels: [],
    model_labels: {},
  };
  await act(async () => responses[0](catalog));
  expect(change).toHaveBeenCalledWith("real-id");
  expect(ready.mock.calls.some(([value]) => value.ready)).toBe(false);
  view.rerender(<ModelPicker {...props} value="real-id" />);
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  await act(async () => responses[1](catalog));
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
  view.rerender(<ModelPicker {...props} value="real-id" connected={false} />);
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});

it("groups native backend modes and keeps the persisted Max value ready", async () => {
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["gpt", "backend-large"],
    provider: null,
    default_model: "gpt",
    effort_levels: ["low"],
    model_labels: { gpt: "GPT", "backend-large": "GPT / Max" },
    model_variants: {
      gpt: [
        { model: "gpt", label: "Standard", context_window: 475000 },
        { model: "backend-large", label: "Max", context_window: 800000 },
      ],
    },
  });
  const ready = vi.fn();
  render(
    <ModelPicker
      hostId="devbox"
      agent="traex"
      connected
      settingsOpen={false}
      value="backend-large"
      onChange={vi.fn()}
      effort="low"
      onEffortChange={vi.fn()}
      disabled={false}
      onReadyChange={ready}
    />,
  );
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "backend-large",
      levels: ["low"],
      options: [
        expect.objectContaining({ value: "" }),
        expect.objectContaining({
          value: "gpt",
          contextWindow: 475000,
          variants: [
            {
              value: "gpt",
              label: "Standard",
              description: "475K context",
              contextWindow: 475000,
            },
            {
              value: "backend-large",
              label: "Max",
              description: "800K context",
              contextWindow: 800000,
            },
          ],
        }),
      ],
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
});
