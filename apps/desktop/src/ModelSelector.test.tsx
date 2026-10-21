// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ModelSelector } from "./ModelSelector";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const options = [
  { value: "", label: "default" },
  {
    value: "gpt",
    label: "GPT Test",
    variants: [
      { value: "gpt", label: "Standard", description: "475K context" },
      { value: "backend-large", label: "Max", description: "800K context" },
    ],
  },
  { value: "seed", label: "Seed" },
];
it.each([200000, undefined])(
  "shows the full model name, ID and reported context (%s) without selecting on hover",
  (contextWindow) => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const fullName =
      "A complete model name that is truncated in the compact menu";
    render(
      <ModelSelector
        value="gateway/full-model-id"
        options={[
          { value: "gateway/full-model-id", label: fullName, contextWindow },
        ]}
        onChange={onChange}
        effort={null}
        levels={[]}
        onEffortChange={vi.fn()}
        disabled={false}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Model and reasoning effort" }),
    );
    const row = screen.getByRole("menuitemradio", { name: fullName });
    fireEvent.mouseEnter(row);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(350));
    const hint = screen.getByRole("tooltip");
    expect(hint.textContent).toContain(fullName);
    expect(hint.textContent).toContain("gateway/full-model-id");
    expect(hint.textContent).toContain(
      contextWindow ? "上下文：200,000 tokens" : "上下文：未提供",
    );
    expect(row.getAttribute("aria-describedby")).toBe(hint.id);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row);
    fireEvent.mouseLeave(row);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(row);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.advanceTimersByTime(350));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  },
);
it("shows mode-specific context on keyboard focus and dismisses it on scroll and disabling", () => {
  vi.useFakeTimers();
  const props = {
    value: "backend-large",
    options: [
      {
        value: "gpt",
        label: "Complete GPT name",
        variants: [
          { value: "gpt", label: "Standard", contextWindow: 475000 },
          { value: "backend-large", label: "Max", contextWindow: 800000 },
        ],
      },
    ],
    onChange: vi.fn(),
    effort: null,
    levels: [],
    onEffortChange: vi.fn(),
    disabled: false,
  };
  const view = render(<ModelSelector {...props} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Model and reasoning effort" }),
  );
  act(() => vi.advanceTimersByTime(350));
  expect(screen.getByRole("tooltip").textContent).toContain(
    "Standard 上下文：475,000 tokens",
  );
  expect(screen.getByRole("tooltip").textContent).toContain(
    "Max 上下文：800,000 tokens",
  );
  fireEvent.keyDown(window, { key: "ArrowRight" });
  act(() => vi.advanceTimersByTime(350));
  const hint = screen.getByRole("tooltip");
  expect(hint.textContent).toContain("Complete GPT name / Max");
  expect(hint.textContent).toContain("backend-large");
  expect(hint.textContent).toContain("上下文：800,000 tokens");
  fireEvent.scroll(screen.getByRole("menu", { name: "Model mode" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(screen.getByRole("menuitemradio", { name: "Max" }));
  act(() => vi.advanceTimersByTime(350));
  expect(screen.getByRole("tooltip")).toBeTruthy();
  view.rerender(<ModelSelector {...props} disabled />);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
});
it.each(["click", "ArrowRight"])(
  "previews modes on hover without stealing focus, then enters via %s",
  (enter) => {
    render(
      <ModelSelector
        value="seed"
        options={options}
        onChange={vi.fn()}
        effort="high"
        levels={["low", "high"]}
        onEffortChange={vi.fn()}
        disabled={false}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Model and reasoning effort" }),
    );
    const group = screen.getByRole("menuitemradio", { name: "GPT Test" });
    const seed = screen.getByRole("menuitemradio", { name: "Seed" });
    fireEvent.mouseEnter(group);
    expect(screen.getByRole("menu", { name: "Model mode" })).toBeTruthy();
    expect(document.activeElement).toBe(group);
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(seed);
    expect(screen.queryByRole("menu", { name: "Model mode" })).toBeNull();
    fireEvent.mouseEnter(group);
    if (enter === "click") fireEvent.click(group);
    else fireEvent.keyDown(window, { key: enter });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "Standard 475K context" }),
    );
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(group);
  },
);
it("keeps hover focus on Effort until explicitly entering its submenu", () => {
  render(
    <ModelSelector
      value="seed"
      options={options}
      onChange={vi.fn()}
      effort="high"
      levels={["low", "high"]}
      onEffortChange={vi.fn()}
      disabled={false}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Model and reasoning effort" }),
  );
  const footer = screen.getByRole("menuitem", { name: /Effort/ });
  fireEvent.mouseEnter(footer);
  expect(document.activeElement).toBe(footer);
  expect(screen.getByRole("menu", { name: "Reasoning effort" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowUp" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Seed" }),
  );
  fireEvent.mouseEnter(footer);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "high" }),
  );
});
it("treats an empty variants list as a direct model choice", () => {
  const change = vi.fn();
  render(
    <ModelSelector
      value="seed"
      options={[{ value: "seed", label: "Seed", variants: [] }]}
      onChange={change}
      effort={null}
      levels={[]}
      onEffortChange={vi.fn()}
      disabled={false}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Model and reasoning effort",
  });
  expect(trigger.title).toBe("Seed");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Seed" }));
  expect(change).toHaveBeenCalledWith("seed");
  expect(screen.queryByRole("menu")).toBeNull();
});
it("opens model modes separately from reasoning and selects the native backend ID", () => {
  const model = vi.fn(),
    effort = vi.fn();
  render(
    <ModelSelector
      value="gpt"
      options={options}
      onChange={model}
      effort="high"
      levels={["low", "high"]}
      onEffortChange={effort}
      disabled={false}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Model and reasoning effort" }),
  );
  const group = screen.getByRole("menuitemradio", { name: "GPT Test" });
  expect(document.activeElement).toBe(group);
  fireEvent.keyDown(window, { key: "ArrowRight" });
  const menu = screen.getByRole("menu", { name: "Model mode" });
  expect(
    within(menu)
      .getByRole("menuitemradio", { name: "Standard 475K context" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(model).toHaveBeenCalledWith("backend-large");
  expect(effort).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});
it("restores Max, returns focus a level at a time, and closes when disabled", () => {
  const props = {
    value: "backend-large",
    options,
    onChange: vi.fn(),
    effort: null,
    levels: ["high" as const],
    onEffortChange: vi.fn(),
    disabled: false,
  };
  const view = render(<ModelSelector {...props} />);
  const trigger = screen.getByRole("button", {
    name: "Model and reasoning effort",
  });
  expect(trigger.title).toBe("GPT Test / Max");
  fireEvent.click(trigger);
  const group = screen.getByRole("menuitemradio", { name: "GPT Test" });
  expect(group.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(group);
  expect(document.activeElement?.textContent).toBe("Max800K context");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.activeElement).toBe(group);
  expect(screen.queryByRole("menu", { name: "Model mode" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: /Effort/ }));
  expect(screen.getByRole("menu", { name: "Reasoning effort" })).toBeTruthy();
  expect(screen.queryByRole("menu", { name: "Model mode" })).toBeNull();
  view.rerender(<ModelSelector {...props} disabled />);
  expect(screen.queryByRole("menu")).toBeNull();
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
});
it("leaves ordinary models as direct choices and supports pointer mode selection", () => {
  const change = vi.fn();
  render(
    <ModelSelector
      value="seed"
      options={options}
      onChange={change}
      effort={null}
      levels={[]}
      onEffortChange={vi.fn()}
      disabled={false}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Model and reasoning effort" }),
  );
  fireEvent.mouseEnter(screen.getByRole("menuitemradio", { name: "GPT Test" }));
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Max 800K context" }),
  );
  expect(change).toHaveBeenLastCalledWith("backend-large");
  fireEvent.click(
    screen.getByRole("button", { name: "Model and reasoning effort" }),
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Seed" }));
  expect(change).toHaveBeenLastCalledWith("seed");
});
