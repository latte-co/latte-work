// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./Select";
afterEach(cleanup);
const options = [
  { value: "main", label: "origin/main" },
  { value: "feature", label: "feature/review" },
];
it("searches branches, keeps typing keys available and selects with the keyboard", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const choose = vi.fn();
  render(
    <Select
      label="基准"
      value="main"
      options={options}
      onChange={choose}
      searchable
      searchPlaceholder="搜索分支"
    />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "基准" }));
  const input = screen.getByRole("combobox", { name: "搜索分支" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "FEATURE" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(fireEvent.keyDown(input, { key: " " })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Home" })).toBe(true);
  expect(choose).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(choose).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(choose).toHaveBeenCalledExactlyOnceWith("feature");
  expect(document.activeElement).toBe(
    screen.getByRole("combobox", { name: "基准" }),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "基准" }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
});
it("keeps an empty search open on Enter and restores focus on Escape", () => {
  const choose = vi.fn();
  render(
    <Select
      label="基准"
      value="main"
      options={options}
      onChange={choose}
      searchable
      searchPlaceholder="搜索分支"
    />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "基准" }));
  const input = screen.getByRole("combobox", { name: "搜索分支" });
  fireEvent.change(input, { target: { value: "missing" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("status").textContent).toBe("没有匹配的选项");
  expect(choose).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("combobox", { name: "基准" }),
  );
});
