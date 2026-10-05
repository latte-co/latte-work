// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { Modal } from "./Modal";
import { Select } from "./Select";
afterEach(cleanup);
function Harness() {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return (
    <>
      <div data-testid="background">
        <button
          onClick={(e) => {
            e.currentTarget.focus();
            setOpen(true);
          }}
        >
          打开
        </button>
      </div>
      {open && (
        <div>
          <Modal aria-label="外层">
            <input aria-label="名称" autoFocus />
            <Select
              label="来源"
              value="a"
              options={[
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ]}
              onChange={() => {}}
            />
            <button onClick={() => setNested(true)}>嵌套</button>
            <button onClick={() => setOpen(false)}>关闭</button>
            {nested && (
              <div>
                <Modal aria-label="内层">
                  <button onClick={() => setNested(false)}>返回</button>
                </Modal>
              </div>
            )}
          </Modal>
        </div>
      )}
    </>
  );
}
it("contains Tab and Shift+Tab, suspends the background, and restores the trigger", () => {
  render(<Harness />);
  const trigger = screen.getByText("打开");
  fireEvent.click(trigger);
  expect((screen.getByTestId("background") as HTMLElement).inert).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText("关闭"));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByLabelText("名称"));
  fireEvent.click(screen.getByText("关闭"));
  expect(document.activeElement).toBe(trigger);
  expect((screen.getByTestId("background") as HTMLElement).inert).not.toBe(
    true,
  );
});
it("keeps Select portals inside the modal and isolates nested dialog focus", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("打开"));
  fireEvent.click(screen.getByRole("combobox"));
  expect(
    screen
      .getByRole("dialog", { name: "外层" })
      .contains(screen.getByRole("listbox")),
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("dialog")).toBeTruthy();
  screen.getByText("嵌套").focus();
  fireEvent.click(screen.getByText("嵌套"));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByText("返回"));
  fireEvent.click(screen.getByText("返回"));
  expect(document.activeElement).toBe(screen.getByText("嵌套"));
});
