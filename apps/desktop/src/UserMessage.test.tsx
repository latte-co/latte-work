// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UserMessage } from "./UserMessage";
const mocks = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock("./clipboard", () => ({ copyText: mocks.copyText }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("uses the persisted timestamp and copies the exact original message", async () => {
  mocks.copyText.mockResolvedValue(undefined);
  const at = Date.parse("2026-09-30T09:35:00Z");
  const text = "第一行\n第二行  ";
  const view = render(<UserMessage text={text} at={at} />);
  const time = view.container.querySelector("time")!;
  expect(time.dateTime).toBe("2026-09-30T09:35:00.000Z");
  expect(time.textContent).toMatch(/^星期三\d{2}:35$/);
  expect(time.title).toContain("2026");
  fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy(),
  );
  expect(mocks.copyText).toHaveBeenCalledWith(text);
});

it("reports copy failure and does not show a success indicator", async () => {
  mocks.copyText.mockRejectedValue(new Error("Clipboard unavailable"));
  render(<UserMessage text="继续" at={Date.now()} />);
  fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Clipboard unavailable",
  );
  expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
});

it("keeps copying available without inventing a timestamp for invalid input", () => {
  const view = render(<UserMessage text="继续" at={NaN} />);
  expect(view.container.querySelector("time")).toBeNull();
  expect(screen.getByRole("button", { name: "复制消息" })).toBeTruthy();
});
