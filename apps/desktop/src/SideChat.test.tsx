// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ModelPicker } from "./ModelPicker";
import { modelSelectionScope } from "./modelSelectionScope";
import { DraftStore } from "./drafts";
import { SideChat, sideDraftKey } from "./SideChat";
import type { Request, Session } from "./protocol";

vi.mock("./ModelPicker", async () => {
  const { useEffect } = await import("react");
  return {
    ModelPicker: ({
      hostId,
      projectId,
      agent,
      value,
      effort,
      onReadyChange,
      onChange,
    }: ComponentProps<typeof ModelPicker>) => {
      useEffect(
        () =>
          onReadyChange?.({
            scope: modelSelectionScope(hostId, projectId, agent, value, effort),
            ready: true,
          }),
        [hostId, projectId, agent, value, effort, onReadyChange],
      );
      return (
        <button onClick={() => onChange("chosen-model")}>
          选择侧边聊天模型
        </button>
      );
    },
  };
});
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({
  request,
  message: String,
  ServerRequestError: class extends Error {},
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});
const parent = {
  id: "main",
  project_id: "p",
  native_id: "native-main",
  agent: "codex",
  status: "running",
} as Session;
const child = {
  ...parent,
  id: "child",
  native_id: "native-child",
  status: "ready",
} as Session;

it("opens without sending, reconciles an ambiguous admission and keeps main input independent", async () => {
  const drafts = new DraftStore();
  const key = sideDraftKey("local", parent.id);
  const mainKey = JSON.stringify(["local", parent.id]);
  drafts.update(mainKey, { text: "main draft" });
  drafts.update(key, {
    text: "side question",
    quotes: ["selected detail", "remove me"],
  });
  let received = "";
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return {
        kind: "agent_permissions",
        modes: [
          {
            id: "bypass_permissions",
            label: "完全访问权限",
            elevated: true,
            description: "测试权限",
          },
        ],
      };
    if (action.method === "open_side_chat")
      return { kind: "session", session: child };
    if (action.method === "poll")
      return {
        kind: "events",
        session: child,
        has_more: false,
        events:
          received && !action.after
            ? [
                {
                  seq: 1,
                  at: 1,
                  session_id: child.id,
                  event: {
                    kind: "user",
                    text: "side question",
                    request_id: received,
                  },
                },
              ]
            : [],
      };
    if (action.method === "send") {
      received = action.request_id;
      throw new Error("receipt lost");
    }
    throw Error("unexpected request");
  });
  const props = {
    parent,
    hostId: "local",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  const view = render(<SideChat {...props} />);
  const send = screen.getByRole("button", {
    name: "发送侧边聊天消息",
  }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  expect(received).toBe("");
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "侧边聊天输入" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "移除文本片段 2" }));
  fireEvent.click(screen.getByRole("button", { name: "选择侧边聊天模型" }));
  fireEvent.click(
    await screen.findByRole("combobox", { name: "侧边聊天权限" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /完全访问权限/ }));
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  await screen.findByRole("alert");
  expect(request).toHaveBeenCalledWith(
    "local",
    expect.objectContaining({
      method: "send",
      session_id: "child",
      text: "> selected detail\n\nside question",
      model: "chosen-model",
      permission_mode: "bypass_permissions",
    }),
  );
  expect(drafts.get(key).text).toBe("side question");
  view.rerender(<SideChat {...props} connected={false} />);
  expect(send.disabled).toBe(true);
  view.rerender(<SideChat {...props} />);
  await waitFor(() => expect(drafts.get(key).text).toBe(""));
  expect(
    request.mock.calls.filter(([, cmd]) => cmd.method === "send"),
  ).toHaveLength(1);
  expect(drafts.get(mainKey).text).toBe("main draft");
});

it("stops only the side turn and never reads a hidden tab", async () => {
  const drafts = new DraftStore();
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "open_side_chat")
      return { kind: "session", session: child };
    if (action.method === "poll")
      return {
        kind: "events",
        session: { ...child, status: "running" },
        events: [],
        has_more: false,
      };
    return { kind: "ok" };
  });
  const props = {
    parent,
    hostId: "ssh",
    drafts,
    active: false,
    connected: true,
    supported: true,
  };
  const view = render(<SideChat {...props} />);
  expect(request).not.toHaveBeenCalled();
  view.rerender(<SideChat {...props} active />);
  fireEvent.click(await screen.findByRole("button", { name: "停止侧边聊天" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("ssh", {
      method: "cancel",
      session_id: "child",
    }),
  );
  expect(request).not.toHaveBeenCalledWith("ssh", {
    method: "cancel",
    session_id: "main",
  });
});
