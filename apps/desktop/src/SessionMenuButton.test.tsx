// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionMenuButton } from "./SessionMenuButton";
import type { Session } from "./protocol";
import type { Workbench } from "./useWorkbench";

const mocks = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("./clipboard", () => ({ copyText: mocks.copy }));
const session: Session = {
  id: "s",
  project_id: "p",
  title: "Remote task",
  agent: "claude",
  native_id: null,
  model: null,
  effort: null,
  permission_mode: null,
  status: "completed",
  created_at: 1,
  custom_title: false,
  pinned_at: null,
  unread: false,
  archived: false,
};
let state: Workbench;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(undefined);
  state = {
    hostId: "remote",
    session,
    agentSessionState: vi.fn(() => "closed"),
    sessionAction: vi.fn().mockResolvedValue(undefined),
  } as unknown as Workbench;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "当前对话操作" }));

it("disables actions for an unsaved draft", () => {
  render(<SessionMenuButton state={{ ...state, session: undefined }} />);
  const button = screen.getByRole("button", {
    name: "当前对话操作",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(state.sessionAction).not.toHaveBeenCalled();
});

it("anchors the current menu to the right, supports toggling and restores keyboard focus", () => {
  render(<SessionMenuButton state={state} />);
  const button = screen.getByRole("button", { name: "当前对话操作" });
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    right: 600,
    bottom: 36,
  } as DOMRect);
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("role") === "menu"
        ? ({ width: 224, height: 280 } as DOMRect)
        : measure.call(this);
    },
  );
  open();
  expect(screen.getByRole("menu").style.left).toBe("376px");
  expect(screen.getByRole("menu").style.top).toBe("40px");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "重命名" }),
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(button);
  open();
  fireEvent.pointerDown(button);
  fireEvent.click(button);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(state.sessionAction).not.toHaveBeenCalled();
});

it("uses the current host and follows live pin and Agent session state", async () => {
  const view = render(<SessionMenuButton state={state} />);
  open();
  expect(
    (screen.getByRole("menuitem", { name: "关闭" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const changed = {
    ...state,
    session: { ...session, pinned_at: 2 },
    agentSessionState: () => "open" as const,
  };
  view.rerender(<SessionMenuButton state={changed} />);
  expect(
    (screen.getByRole("menuitem", { name: "关闭" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await act(async () =>
    fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" })),
  );
  expect(state.sessionAction).toHaveBeenCalledExactlyOnceWith("remote", {
    method: "pin_session",
    session_id: "s",
    pinned: false,
  });
  expect(screen.queryByRole("menu")).toBeNull();
});

it("dismisses both menus and dialogs when the selected host or conversation changes", () => {
  const view = render(<SessionMenuButton state={state} />);
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  expect(screen.getByRole("dialog", { name: "重命名会话" })).toBeTruthy();
  view.rerender(<SessionMenuButton state={{ ...state, hostId: "local" }} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  open();
  view.rerender(
    <SessionMenuButton
      state={{ ...state, hostId: "local", session: { ...session, id: "next" } }}
    />,
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(state.sessionAction).not.toHaveBeenCalled();
});

it("renames the current conversation and reuses the copy submenu", async () => {
  render(<SessionMenuButton state={state} />);
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox", { name: "会话名称" });
  fireEvent.change(input, { target: { value: "New name" } });
  await act(async () => fireEvent.submit(input.closest("form")!));
  expect(state.sessionAction).toHaveBeenCalledExactlyOnceWith("remote", {
    method: "rename_session",
    session_id: "s",
    title: "New name",
  });
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "复制…" }));
  await act(async () =>
    fireEvent.click(screen.getByRole("menuitem", { name: "复制会话 ID" })),
  );
  expect(mocks.copy).toHaveBeenCalledExactlyOnceWith("s");
});

it("exposes stop during execution and keeps archive unavailable until it finishes", async () => {
  render(
    <SessionMenuButton
      state={{ ...state, session: { ...session, status: "running" } }}
    />,
  );
  open();
  const archive = screen.getByRole("menuitem", {
    name: "归档",
  }) as HTMLButtonElement;
  expect(archive.disabled).toBe(true);
  await act(async () =>
    fireEvent.click(screen.getByRole("menuitem", { name: "停止任务" })),
  );
  expect(state.sessionAction).toHaveBeenCalledExactlyOnceWith("remote", {
    method: "cancel",
    session_id: "s",
  });
});
