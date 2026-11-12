// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageGallery } from "./ImageGallery";
import { AttachmentImage } from "./AttachmentImage";
import { ToolImages } from "./ToolImages";
import { MessageActionsProvider, MessageContent } from "./MessageContent";
import { ReviewImageDiff } from "./ReviewImageDiff";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./sourceLoader", () => ({ loadSource: mocks.load }));
const data = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  mime: "image/png",
  size: 4,
  truncated: false,
};
const props = {
  hostId: "local",
  projectId: "p",
  sessionId: "s",
  connected: true,
  variant: "chip" as const,
};
const reference = (name: string) => ({
  name,
  path: `/images/${name}`,
  directory: false,
});
const tool = {
  type: "image" as const,
  mime_type: "image/png",
  data_base64: "iVBORw0KGgo=",
};
const dialog = () => screen.getByRole("dialog");
const next = () => screen.getByRole("button", { name: "下一张图片" });
const previous = () => screen.getByRole("button", { name: "上一张图片" });
beforeEach(() => {
  mocks.load.mockReset().mockResolvedValue(data);
  let index = 0;
  URL.createObjectURL = vi.fn(() => `blob:image-${++index}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("switches across transcript image types in DOM order and restores the original trigger", async () => {
  render(
    <ImageGallery>
      <AttachmentImage {...props} reference={reference("first.png")} />
      <ToolImages images={[tool]} />
      <MessageActionsProvider value={{ readProjectFile: async () => data }}>
        <MessageContent text="![last](last.png)" />
      </MessageActionsProvider>
    </ImageGallery>,
  );
  await screen.findByRole("button", { name: "放大图片 last" });
  const trigger = screen.getByRole("button", { name: "预览图片 first.png" });
  fireEvent.click(trigger);
  const modal = dialog();
  await within(modal).findByRole("img", { name: "first.png" });
  expect(previous().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(previous());
  expect(dialog()).toBe(modal);
  expect(screen.getByText("1 / 3")).toBeTruthy();
  next().focus();
  fireEvent.click(next());
  expect(dialog()).toBe(modal);
  expect(
    within(modal).getByRole("img", { name: "工具输出图片 1" }),
  ).toBeTruthy();
  expect(screen.getByText("2 / 3")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(within(modal).getByRole("img", { name: "last" })).toBeTruthy();
  expect(next().getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(next());
  fireEvent.click(next());
  expect(screen.getByText("3 / 3")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(screen.getByText("2 / 3")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("reads only the selected attachment, fences late data and allows leaving a failed image", async () => {
  let finish!: (value: typeof data) => void;
  let valid!: () => boolean;
  mocks.load
    .mockImplementationOnce((_host, _project, _session, _path, current) => {
      valid = current;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockRejectedValueOnce(new Error("读取失败"));
  render(
    <ImageGallery>
      {["one.png", "two.png", "three.png"].map((name) => (
        <AttachmentImage key={name} {...props} reference={reference(name)} />
      ))}
    </ImageGallery>,
  );
  expect(mocks.load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "预览图片 one.png" }));
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
  fireEvent.click(next());
  expect(valid()).toBe(false);
  expect((await within(dialog()).findByRole("alert")).textContent).toContain(
    "读取失败",
  );
  await act(async () => finish(data));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(within(dialog()).queryByRole("img", { name: "one.png" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "重试" }), {
    key: "ArrowRight",
  });
  await within(dialog()).findByRole("img", { name: "three.png" });
  expect(mocks.load).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
});

it("preserves image identity and reading order when older images are inserted", async () => {
  const gallery = (names: string[]) => (
    <ImageGallery>
      {names.map((name) => (
        <AttachmentImage key={name} {...props} reference={reference(name)} />
      ))}
    </ImageGallery>
  );
  const view = render(gallery(["b.png", "c.png"]));
  fireEvent.click(screen.getByRole("button", { name: "预览图片 b.png" }));
  await within(dialog()).findByRole("img", { name: "b.png" });
  const modal = dialog();
  view.rerender(gallery(["a.png", "b.png", "c.png"]));
  expect(dialog()).toBe(modal);
  expect(screen.getByText("2 / 3")).toBeTruthy();
  fireEvent.click(previous());
  await within(dialog()).findByRole("img", { name: "a.png" });
  expect(screen.getByText("1 / 3")).toBeTruthy();
  view.rerender(gallery(["b.png", "c.png"]));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps galleries isolated, hides navigation for one image and closes on scope/hide changes", async () => {
  const content = (scope: string, active = true) => (
    <>
      <ImageGallery scope={scope} active={active}>
        <AttachmentImage {...props} reference={reference("a.png")} />
      </ImageGallery>
      <ImageGallery>
        <AttachmentImage {...props} reference={reference("draft.png")} />
      </ImageGallery>
    </>
  );
  const view = render(content("session-a"));
  const open = async () => {
    fireEvent.click(screen.getByRole("button", { name: "预览图片 a.png" }));
    await within(dialog()).findByRole("img", { name: "a.png" });
  };
  await open();
  expect(screen.queryByRole("navigation", { name: "图片切换" })).toBeNull();
  fireEvent.keyDown(dialog(), { key: "ArrowRight" });
  expect(within(dialog()).queryByRole("img", { name: "draft.png" })).toBeNull();
  view.rerender(content("session-b"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await open();
  view.rerender(content("session-b", false));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(content("session-b"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("switches between before/after images in a standalone change preview", async () => {
  render(<ReviewImageDiff path="changed.png" load={async () => data} active />);
  const trigger = await screen.findByRole("button", {
    name: "放大图片 changed.png · 修改前",
  });
  fireEvent.click(trigger);
  fireEvent.click(next());
  expect(
    within(dialog()).getByRole("img", { name: "changed.png · 修改后" }),
  ).toBeTruthy();
  expect(screen.getByText("2 / 2")).toBeTruthy();
});
