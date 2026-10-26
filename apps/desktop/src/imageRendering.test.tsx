// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolImages } from "./ToolImages";
import { ReviewImageDiff } from "./ReviewImageDiff";
const image = {
  type: "image" as const,
  mime_type: "image/png",
  data_base64: "iVBORw0KGgo=",
};
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:image");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
it("shows inline tool images, enlarges with focus restoration, and releases them when hidden", async () => {
  const view = render(<ToolImages images={[image]} />);
  expect(
    await screen.findByRole("img", { name: "工具输出图片 1" }),
  ).toBeTruthy();
  const trigger = screen.getByRole("button", {
    name: "放大图片 工具输出图片 1",
  });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  view.rerender(<ToolImages images={[image]} active={false} />);
  await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
it("shows added and deleted image sides, and fences a previous comparison response", async () => {
  const data = { bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png" };
  let resolve!: (v: typeof data) => void;
  const old = vi.fn(
    () =>
      new Promise<typeof data>((r) => {
        resolve = r;
      }),
  );
  const view = render(<ReviewImageDiff path="old.png" load={old} active />);
  await waitFor(() => expect(old).toHaveBeenCalled());
  const load = vi.fn(async (_path: string, before: boolean) =>
    before ? null : data,
  );
  view.rerender(<ReviewImageDiff path="new.png" load={load} active />);
  expect(
    await screen.findByRole("img", { name: "new.png · 修改后" }),
  ).toBeTruthy();
  expect(screen.getByText("此版本没有文件")).toBeTruthy();
  await act(async () => resolve(data));
  expect(screen.queryByRole("img", { name: "old.png · 修改后" })).toBeNull();
});
