// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import type { Response } from "./protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  selector: vi.fn(() => null),
}));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("./ModelSelector", () => ({ ModelSelector: mocks.selector }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
