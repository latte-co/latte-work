// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageActionsProvider, MessageContent } from "./MessageContent";
import type { SourceData } from "./sourceLoader";

const pngData: SourceData = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  mime: "image/png",
  size: 4,
  truncated: false,
};
const textData: SourceData = {
  bytes: new TextEncoder().encode("not an image"),
  mime: "text/plain",
  size: 12,
  truncated: false,
};

const loadExternal = vi.fn();
const readProjectFile = vi.fn();

function renderMarkdown(text: string, provided = true) {
  return render(
    <MessageActionsProvider
      value={
        provided ? { loadExternalImage: loadExternal, readProjectFile } : {}
      }
    >
      <MessageContent text={text} />
    </MessageActionsProvider>,
  );
}

beforeEach(() => {
  loadExternal.mockReset().mockResolvedValue(pngData);
  readProjectFile.mockReset().mockResolvedValue(pngData);
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:mock"),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
  });
});
afterEach(() => cleanup());

describe("MessageContent markdown images", () => {
  it("keeps http image targets as plain img elements", () => {
    const { container } = renderMarkdown(
      "![截图](https://example.com/shot.png)",
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://example.com/shot.png");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an absolute path as a placeholder without a loader", () => {
    renderMarkdown("![二维码](/tmp/qr.png)", false);
    const placeholder = screen.getByText("/tmp/qr.png");
    expect(placeholder).toBeTruthy();
    expect(screen.getByText("当前视图无法加载图片")).toBeTruthy();
    expect(document.querySelector("img[src='/tmp/qr.png']")).toBeNull();
  });

  it("auto-loads external images in place", async () => {
    const { container } = renderMarkdown("![二维码](/tmp/qr.png)");
    await act(() => Promise.resolve());
    expect(loadExternal).toHaveBeenCalledWith("/tmp/qr.png");
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("blob:mock");
    expect(img!.getAttribute("alt")).toBe("二维码");
  });

  it("accepts file:// unwrapping for external images", async () => {
    const { container } = renderMarkdown("![二维码](file:///tmp/qr.png)");
    await act(() => Promise.resolve());
    expect(loadExternal).toHaveBeenCalledWith("/tmp/qr.png");
    expect(container.querySelector("img[src='blob:mock']")).not.toBeNull();
  });

  it("waits for viewport proximity before reading when observed", async () => {
    let visibility: (entries: { isIntersecting: boolean }[]) => void = () =>
      undefined;
    class StubObserver {
      constructor(callback: typeof visibility) {
        visibility = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "IntersectionObserver", {
      value: StubObserver,
      configurable: true,
    });
    try {
      renderMarkdown("![二维码](/tmp/qr.png)");
      await act(() => Promise.resolve());
      expect(loadExternal).not.toHaveBeenCalled();
      expect(screen.getByText("/tmp/qr.png")).toBeTruthy();
      act(() => visibility([{ isIntersecting: true }]));
      await act(() => Promise.resolve());
      expect(loadExternal).toHaveBeenCalledWith("/tmp/qr.png");
      expect(document.querySelector("img[src='blob:mock']")).not.toBeNull();
    } finally {
      delete (window as { IntersectionObserver?: unknown })
        .IntersectionObserver;
    }
  });

  it("rejects non-image payloads with an error placeholder", async () => {
    loadExternal.mockResolvedValue(textData);
    renderMarkdown("![二维码](/tmp/notes.txt)");
    await act(() => Promise.resolve());
    expect(screen.getByRole("alert").textContent).toContain("不能作为图片预览");
    expect(document.querySelector("img")).toBeNull();
  });

  it("surfaces loader failures and offers a retry", async () => {
    loadExternal.mockRejectedValueOnce(new Error("读取超时"));
    renderMarkdown("![二维码](/tmp/qr.png)");
    await act(() => Promise.resolve());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("读取超时");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(() => Promise.resolve());
    expect(loadExternal).toHaveBeenCalledTimes(2);
    expect(document.querySelector("img[src='blob:mock']")).not.toBeNull();
  });

  it("auto-loads project-relative images through the project reader", async () => {
    const { container } = renderMarkdown("![流程图](docs/flow.png)");
    await act(() => Promise.resolve());
    expect(readProjectFile).toHaveBeenCalledWith("docs/flow.png");
    expect(container.querySelector("img[src='blob:mock']")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("degrades project images to a placeholder without the project reader", () => {
    renderMarkdown("![流程图](docs/flow.png)", false);
    expect(screen.getByText("docs/flow.png")).toBeTruthy();
    expect(screen.getByText("当前视图无法加载图片")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("revokes the object URL when unmounted", async () => {
    const { unmount } = renderMarkdown("![二维码](/tmp/qr.png)");
    await act(() => Promise.resolve());
    expect(URL.createObjectURL).toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("refuses directory targets without offering a grant", () => {
    renderMarkdown("![产物](/tmp/build/)");
    expect(screen.getByText("/tmp/build/")).toBeTruthy();
    expect(screen.getByText("目录不能作为图片预览").textContent).toContain(
      "目录不能作为图片预览",
    );
    expect(loadExternal).not.toHaveBeenCalled();
  });

  it("explains that home-relative paths need absolute form", () => {
    renderMarkdown("![二维码](~/Pictures/qr.png)");
    expect(screen.getByText("~/Pictures/qr.png")).toBeTruthy();
    expect(screen.getByText("需要使用绝对路径才能加载")).toBeTruthy();
    expect(loadExternal).not.toHaveBeenCalled();
  });

  it("rejects truncated payloads with the error placeholder", async () => {
    loadExternal.mockResolvedValue({ ...pngData, truncated: true });
    renderMarkdown("![二维码](/tmp/qr.png)");
    await act(() => Promise.resolve());
    expect(screen.getByRole("alert").textContent).toContain("不能作为图片预览");
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows a decode failure when the blob cannot render", async () => {
    renderMarkdown("![二维码](/tmp/qr.png)");
    await act(() => Promise.resolve());
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(screen.getByRole("alert").textContent).toContain("图片格式无法解码");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});
