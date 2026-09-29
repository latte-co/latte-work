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
import { Conversation } from "./Conversation";
import { DraftStore } from "./drafts";
import type { Session } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("./useAgentPreferences", () => ({
  useAgentPreferences: () => ({
    model: null,
    effort: null,
    permissionMode: null,
  }),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./PermissionPicker", () => ({ PermissionPicker: () => null }));
vi.mock("./TaskProjectPicker", () => ({ TaskProjectPicker: () => null }));
beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.request.mockResolvedValue({
    kind: "files",
    entries: [{ name: "note.md", path: "note.md", directory: false }],
  });
});
afterEach(cleanup);
const session = (id: string) =>
  ({ id, agent: "claude", status: "ready", archived: false }) as Session;
const props = () => ({
  drafts: new DraftStore(),
  hostId: "local",
  projectId: "p",
  projectName: "Test",
  projects: [],
  hosts: [],
  settingsOpen: false,
  events: [],
  connected: true,
  available: true,
  selectTaskProject: vi.fn(),
  openProject: vi.fn(),
  send: vi.fn().mockResolvedValue(true),
  cancel: vi.fn(),
  approve: vi.fn(),
});
const input = () =>
  screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement;
it("keeps independent text and references across remounts, never replaces a nonempty draft with a suggestion", async () => {
  const p = props();
  const view = render(<Conversation {...p} key="a" session={session("a")} />);
  fireEvent.change(input(), { target: { value: "keep this" } });
  expect(screen.queryByRole("button", { name: "梳理项目结构" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "添加项目引用" }));
  fireEvent.click(await screen.findByRole("option", { name: "note.md" }));
  view.rerender(<Conversation {...p} key="b" session={session("b")} />);
  expect(input().value).toBe("");
  fireEvent.change(input(), { target: { value: "another" } });
  view.rerender(<Conversation {...p} key="a2" session={session("a")} />);
  expect(input().value).toBe("keep this");
  expect(screen.getByRole("button", { name: "移除引用 note.md" })).toBeTruthy();
  view.rerender(
    <Conversation {...p} key="remote" hostId="remote" session={session("a")} />,
  );
  expect(input().value).toBe("");
  expect(screen.queryByRole("button", { name: "移除引用 note.md" })).toBeNull();
});
it.each([true, false])(
  "handles first-send session creation without losing or duplicating a draft (accepted=%s)",
  async (accepted) => {
    const p = props();
    let finish!: (value: boolean) => void;
    p.send.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Conversation {...p} />);
    fireEvent.change(input(), { target: { value: "first send" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    view.rerender(<Conversation {...p} session={session("created")} />);
    expect(input().value).toBe("first send");
    await act(async () => finish(accepted));
    await waitFor(() =>
      expect(input().value).toBe(accepted ? "" : "first send"),
    );
    view.rerender(<Conversation {...p} key="new" />);
    expect(input().value).toBe("");
  },
);
it("a late accepted send cannot clear a new draft written after navigation", async () => {
  const p = props();
  let finish!: (value: boolean) => void;
  p.send.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<Conversation {...p} key="old" session={session("a")} />);
  fireEvent.change(input(), { target: { value: "submitted" } });
  fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
  view.rerender(<Conversation {...p} key="return" session={session("a")} />);
  fireEvent.change(input(), { target: { value: "new draft" } });
  await act(async () => finish(true));
  expect(input().value).toBe("new draft");
});
it.each([true, false])(
  "reconciles a session render that arrives after a fast send response (accepted=%s)",
  async (accepted) => {
    const p = props();
    p.send.mockResolvedValue(accepted);
    const view = render(<Conversation {...p} />);
    fireEvent.change(input(), { target: { value: "fast response" } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "发送任务" })),
    );
    view.rerender(<Conversation {...p} session={session("created")} />);
    expect(input().value).toBe(accepted ? "" : "fast response");
  },
);

it("shows actual thinking and stop progress, restoring status when cancellation fails", async () => {
  const p = props();
  let rejectStop!: (value: boolean) => void;
  p.cancel.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        rejectStop = resolve;
      }),
  );
  const running = { ...session("s"), status: "running" as const };
  const events = [
    {
      seq: 1,
      at: 0,
      session_id: "s",
      event: { kind: "progress" as const, phase: "thinking" as const },
    },
  ];
  const view = render(
    <Conversation {...p} session={running} events={events} />,
  );
  expect(screen.getByRole("status").textContent).toBe("正在思考");
  fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
  expect(screen.getByRole("status").textContent).toBe("正在停止");
  await act(async () => rejectStop(false));
  expect(screen.getByRole("status").textContent).toBe("正在思考");
  view.rerender(
    <Conversation
      {...p}
      session={{ ...running, status: "completed" }}
      events={events}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
});
