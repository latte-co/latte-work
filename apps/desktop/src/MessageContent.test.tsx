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
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  load: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./sourceLoader", () => ({ loadSource: mocks.load }));
const textData: SourceData = {
  bytes: new TextEncoder().encode("fixture body"),
  mime: "text/plain",
  size: 13,
  truncated: false,
};
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.load.mockReset().mockResolvedValue(textData);
  mocks.write.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mocks.write },
    configurable: true,
  });
});
afterEach(() => cleanup());
const menuLabels = () =>
  screen.queryByRole("menu")
    ? [...screen.queryByRole("menu")!.querySelectorAll("button")].map(
        (button) => button.textContent,
      )
    : [];

describe("MessageContent inline references", () => {
  it("opens project paths through the workspace hook with line hints stripped", () => {
    const openFile = vi.fn();
    render(
      <MessageActionsProvider
        value={{ openFile, localHost: true, projectRoot: "/repo" }}
      >
        <MessageContent
          text={"见 `apps/desktop/src/MessageContent.tsx:62` 的实现。"}
        />
      </MessageActionsProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "在工作区中打开，右键查看更多操作",
      }),
    );
    expect(openFile).toHaveBeenCalledWith(
      "apps/desktop/src/MessageContent.tsx",
    );
  });

  it("opens local external files with the default app and keeps reveal in the menu", () => {
    render(
      <MessageActionsProvider value={{ localHost: true }}>
        <MessageContent
          text={"产物在 `~/Downloads/Latte-Work-0.1.0-arm64.dmg`。"}
        />
      </MessageActionsProvider>,
    );
    const chip = screen.getByRole("button", {
      name: "打开文件，右键查看更多操作",
    });
    fireEvent.click(chip);
    expect(mocks.invoke).toHaveBeenCalledWith("open_path", {
      path: "~/Downloads/Latte-Work-0.1.0-arm64.dmg",
    });
    fireEvent.contextMenu(chip);
    expect(menuLabels()).toContain("在访达中显示");
    fireEvent.click(screen.getByRole("menuitem", { name: "在访达中显示" }));
    expect(mocks.invoke).toHaveBeenCalledWith("reveal_path", {
      path: "~/Downloads/Latte-Work-0.1.0-arm64.dmg",
    });
  });

  it("offers local external files the extended menu actions", async () => {
    mocks.invoke.mockResolvedValue("/tmp/copy.bin");
    render(
      <MessageActionsProvider value={{ localHost: true }}>
        <MessageContent text={"样本 `/tmp/data/notes.txt`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    expect(menuLabels()).toEqual([
      "打开文件",
      "在 VS Code 中打开",
      "另存为...",
      "复制路径",
      "复制文件内容",
      "在访达中显示",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "另存为..." }));
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("save_local_file_as", {
        path: "/tmp/data/notes.txt",
        name: "notes.txt",
      }),
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    mocks.invoke.mockResolvedValue("file body");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制文件内容" }));
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("read_local_text", {
        path: "/tmp/data/notes.txt",
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith("file body"),
    );
  });

  it("keeps remote external paths to path copy only", async () => {
    render(
      <MessageActionsProvider value={{ localHost: false }}>
        <MessageContent text={"产物在 `/home/dev/out.bin`。"} />
      </MessageActionsProvider>,
    );
    const chip = screen.getByRole("button");
    fireEvent.click(chip);
    await vi.waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith("/home/dev/out.bin"),
    );
    fireEvent.contextMenu(chip);
    expect(menuLabels()).toEqual(["复制路径"]);
  });

  it("hides the editor item while the project root is unknown", () => {
    render(
      <MessageActionsProvider value={{ openFile: vi.fn(), localHost: true }}>
        <MessageContent text={"入口 `./scripts/package-dmg.sh`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    expect(menuLabels()).toEqual(["打开文件", "复制路径"]);
  });

  it("resolves project paths to the project root for the local editor", () => {
    render(
      <MessageActionsProvider
        value={{ openFile: vi.fn(), localHost: true, projectRoot: "/repo" }}
      >
        <MessageContent text={"入口 `./scripts/package-dmg.sh`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "在 VS Code 中打开" }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("open_in_vscode", {
      path: "/repo/scripts/package-dmg.sh",
    });
  });

  it("saves remote project files through the bounded read and save dialog", async () => {
    render(
      <MessageActionsProvider
        value={{
          openFile: vi.fn(),
          localHost: false,
          readProjectFile: mocks.load,
        }}
      >
        <MessageContent text={"清单 `docs/providers.md`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    expect(menuLabels()).toContain("另存为...");
    fireEvent.click(screen.getByRole("menuitem", { name: "另存为..." }));
    await vi.waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith("docs/providers.md"),
    );
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("save_file_as", {
        name: "providers.md",
        data: Array.from(textData.bytes),
      }),
    );
  });

  it("copies remote project file content as text and reports binary refusal", async () => {
    const reportError = vi.fn();
    render(
      <MessageActionsProvider
        value={{
          openFile: vi.fn(),
          localHost: false,
          readProjectFile: mocks.load,
          reportError,
        }}
      >
        <MessageContent text={"清单 `docs/providers.md`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制文件内容" }));
    await vi.waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith("fixture body"),
    );
    mocks.load.mockResolvedValue({
      ...textData,
      bytes: new Uint8Array([0x89, 0, 0x50]),
    });
    fireEvent.contextMenu(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制文件内容" }));
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith("二进制文件不支持复制内容"),
    );
  });

  it("keeps inline code non-interactive without workspace actions", () => {
    render(
      <MessageContent text={"见 `docs/providers.md` 与 `npm run build`。"} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelectorAll("code").length).toBe(2);
  });

  it("renders urls through the shared web link handling", () => {
    render(
      <MessageActionsProvider value={{ localHost: true }}>
        <MessageContent
          text={"详情见 `https://github.com/latte-co/latte-work/pull/19`。"}
        />
        ,
      </MessageActionsProvider>,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/latte-co/latte-work/pull/19",
    );
    expect(link.className).toBe("inline-ref-link");
  });

  it("keeps fenced code blocks plain without interactive chips", () => {
    render(
      <MessageActionsProvider value={{ localHost: true, openFile: vi.fn() }}>
        <MessageContent
          text={
            "```sh\nmake clean\nnpm run build\n```\n结果见 `log/build.out`。"
          }
        />
      </MessageActionsProvider>,
    );
    const block = document.querySelector(".code-block pre code");
    expect(block?.textContent).toBe("make clean\nnpm run build");
    expect(
      document.querySelectorAll(".code-block .inline-ref-button"),
    ).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "在工作区中打开，右键查看更多操作" }),
    ).toBeTruthy();
  });
});

describe("MessageContent hover tooltips", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals the resolved full path with the line hint on hover", () => {
    vi.useFakeTimers();
    render(
      <MessageActionsProvider
        value={{ openFile: vi.fn(), localHost: true, projectRoot: "/repo" }}
      >
        <MessageContent
          text={"见 `apps/desktop/src/MessageContent.tsx:62`。"}
        />
      </MessageActionsProvider>,
    );
    const chip = screen.getByRole("button", {
      name: "在工作区中打开，右键查看更多操作",
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseOver(chip);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain(
      "/repo/apps/desktop/src/MessageContent.tsx (line 62)",
    );
    expect(tooltip.textContent).toContain("左键在工作区打开 · 右键更多操作");
    fireEvent.mouseOut(chip);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps remote external tooltips to the raw path and copy hint", () => {
    vi.useFakeTimers();
    render(
      <MessageActionsProvider value={{ localHost: false }}>
        <MessageContent text={"产物在 `/home/dev/out.bin:12`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.mouseOver(screen.getByRole("button"));
    act(() => {
      vi.advanceTimersByTime(350);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("/home/dev/out.bin (line 12)");
    expect(tooltip.textContent).toContain("点击复制路径 · 右键更多操作");
  });

  it("shows the tooltip from keyboard focus and hides it on Escape", () => {
    vi.useFakeTimers();
    render(
      <MessageActionsProvider value={{ localHost: true }}>
        <MessageContent text={"样本 `/tmp/data/notes.txt`。"} />
      </MessageActionsProvider>,
    );
    const chip = screen.getByRole("button");
    fireEvent.focus(chip);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(chip.getAttribute("aria-describedby")).toBe(tooltip.id);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(chip.getAttribute("aria-describedby")).toBeNull();
  });

  it("hides the tooltip on scroll and never opens it alongside the menu", () => {
    vi.useFakeTimers();
    render(
      <MessageActionsProvider value={{ localHost: true }}>
        <MessageContent text={"样本 `/tmp/data/notes.txt`。"} />
      </MessageActionsProvider>,
    );
    const chip = screen.getByRole("button");
    fireEvent.mouseOver(chip);
    fireEvent.scroll(window);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseOver(chip);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.contextMenu(chip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
