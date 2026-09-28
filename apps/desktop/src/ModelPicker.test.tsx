// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import type { Response } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
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
