// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageActionsProvider, MessageContent } from "./MessageContent";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("MessageContent inline references", () => {
  it("opens project paths through the workspace hook with line hints stripped", () => {
    const openFile = vi.fn();
    render(
      <MessageActionsProvider value={{ openFile, localHost: true }}>
        <MessageContent
          text={"见 `apps/desktop/src/MessageContent.tsx:62` 的实现。"}
        />
      </MessageActionsProvider>,
    );
    const chip = screen.getByRole("button", {
      name: "在工作区中打开 apps/desktop/src/MessageContent.tsx",
    });
    fireEvent.click(chip);
    expect(openFile).toHaveBeenCalledWith(
      "apps/desktop/src/MessageContent.tsx",
    );
  });

  it("reveals local external paths through the native command", () => {
    render(
      <MessageActionsProvider value={{ localHost: true }}>
        <MessageContent
          text={"产物在 `~/Downloads/Latte-Work-0.1.0-arm64.dmg`。"}
        />
      </MessageActionsProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "在访达中显示 ~/Downloads/Latte-Work-0.1.0-arm64.dmg",
      }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("reveal_path", {
      path: "~/Downloads/Latte-Work-0.1.0-arm64.dmg",
    });
  });

  it("refuses external paths on non-local hosts without invoking", () => {
    render(
      <MessageActionsProvider value={{ localHost: false }}>
        <MessageContent text={"产物在 `/tmp/latte/out.bin`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "仅本机路径可在访达中显示",
    );
  });

  it("reports a native reveal failure inline", async () => {
    mocks.invoke.mockRejectedValue(new Error("文件不存在或已移动"));
    render(
      <MessageActionsProvider value={{ localHost: true }}>
        <MessageContent text={"见 `/tmp/gone.bin`。"} />
      </MessageActionsProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("文件不存在或已移动"),
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
      screen.getByRole("button", { name: "在工作区中打开 log/build.out" }),
    ).toBeTruthy();
  });
});
