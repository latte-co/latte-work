// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import { updateWorkspace, readWorkspace } from "./workspaceState";
import type { Request, Response, TerminalInfo } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn(), disposed: vi.fn() }));
vi.mock("./api", () => ({
  request: mocks.request,
  message: (e: unknown) => String(e),
}));
vi.mock("./WorkspaceFiles", () => ({
  WorkspaceFiles: () => <div>文件预览</div>,
}));
vi.mock("./TerminalPane", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalPane: ({ terminal }: { terminal: TerminalInfo }) => {
      useEffect(() => () => mocks.disposed(terminal.id), [terminal.id]);
      return <div>Shell {terminal.id}</div>;
    },
  };
});
const project = { id: "one", name: "One", path: "/one" };
const props = {
  workspaceId: "",
  hostId: "local",
  hostName: "本机",
  project,
  visible: true,
  connected: true,
  close: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  props.workspaceId = crypto.randomUUID();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.request.mockImplementation(
    async (_host: string, r: Request): Promise<Response> => {
      if (r.method === "terminals") return { kind: "terminals", terminals: [] };
      if (r.method === "create_terminal")
        return {
          kind: "terminal",
          terminal: {
            id: r.terminal_id,
            project_id: r.project_id,
            title: "sh",
            exited: false,
            exit_code: null,
          },
        };
      return { kind: "ok" };
    },
  );
});
afterEach(cleanup);
it("opens independent child tabs, reuses a selected child, retains the list and closes without stopping", async () => {
  updateWorkspace(props.workspaceId, {
    tabs: [{ id: "subagents", kind: "subagents" }],
    current: "subagents",
    visible: true,
  });
  const subagents = {
    tasks: ["alpha", "beta"].map((id) => ({
      id,
      native_id: `native-${id}`,
      tool_use_id: `tool-${id}`,
      title: id,
      status: "completed" as const,
      summary: `${id} result`,
      last_tool: "Read",
      started_at: 1,
      updated_at: 2,
    })),
    loading: false,
    error: "",
    truncated: false,
  };
  const view = render(<Workspace {...props} subagents={subagents} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /alpha.*已完成/ }));
  expect(
    screen.getByRole("tab", { name: "alpha" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByText("alpha result")).toBeTruthy();
  expect(screen.queryByText("任务标识")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "子智能体" }));
  fireEvent.click(screen.getByRole("button", { name: /beta.*已完成/ }));
  fireEvent.click(screen.getByRole("tab", { name: "子智能体" }));
  fireEvent.click(screen.getByRole("button", { name: /alpha.*已完成/ }));
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  const live = {
    ...subagents,
    tasks: subagents.tasks.map((task) =>
      task.id === "alpha" ? { ...task, summary: "updated alpha result" } : task,
    ),
  };
  view.rerender(<Workspace {...props} subagents={live} />);
  expect(screen.getByText("updated alpha result")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭alpha" }));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(
    mocks.request.mock.calls.some(([, request]) =>
      ["send", "cancel", "close_agent_session"].includes(request.method),
    ),
  ).toBe(false);
});
it("adds independent tabs, retains mounted shells on hide, and closes explicitly", async () => {
  const view = render(<Workspace {...props} />);
  await act(async () => {});
  const add = async () => {
    if (screen.queryByRole("button", { name: "添加工作区标签" })) {
      fireEvent.click(screen.getByRole("button", { name: "添加工作区标签" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "终端" }));
      });
    } else
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "终端" }));
      });
  };
  await add();
  await add();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  const ids = mocks.request.mock.calls
    .filter((c) => c[1].method === "create_terminal")
    .map((c) => c[1].terminal_id);
  expect(new Set(ids).size).toBe(2);
  view.rerender(<Workspace {...props} visible={false} />);
  view.rerender(<Workspace {...props} />);
  expect(mocks.disposed).not.toHaveBeenCalled();
  expect(
    mocks.request.mock.calls.filter((c) => c[1].method === "close_terminal"),
  ).toHaveLength(0);
  await act(async () => {
    fireEvent.click(
      screen.getAllByRole("button", { name: "关闭sh · 本机" })[1],
    );
  });
  expect(mocks.request).toHaveBeenLastCalledWith("local", {
    method: "close_terminal",
    terminal_id: ids[1],
  });
  expect(mocks.disposed).toHaveBeenCalledWith(ids[1]);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
});
it("keeps a terminal tab when closing fails and scopes host project restoration", async () => {
  mocks.request.mockImplementation(
    async (_host: string, r: Request): Promise<Response> => {
      if (r.method === "terminals")
        return {
          kind: "terminals",
          terminals:
            r.project_id === "one"
              ? [
                  {
                    id: "shell-one",
                    project_id: "one",
                    title: "sh",
                    exited: false,
                    exit_code: null,
                  },
                ]
              : [],
        };
      if (r.method === "close_terminal") throw new Error("offline");
      return { kind: "ok" };
    },
  );
  updateWorkspace(props.workspaceId, {
    tabs: [
      {
        id: "shell-one",
        kind: "terminal",
        terminal: {
          id: "shell-one",
          project_id: "one",
          title: "sh",
          exited: false,
          exit_code: null,
        },
      },
    ],
    current: "shell-one",
  });
  const view = render(<Workspace {...props} />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "关闭sh · 本机" }));
  });
  expect(screen.getByRole("alert").textContent).toContain("offline");
  expect(screen.getByRole("tab", { name: "sh · 本机" })).toBeTruthy();
  view.rerender(
    <Workspace
      {...props}
      workspaceId="ssh-other-conversation"
      hostId="ssh"
      hostName="远程"
      project={{ id: "two", name: "Two", path: "/two" }}
    />,
  );
  await act(async () => {});
  expect(
    within(screen.getByRole("tablist")).queryByRole("tab", {
      name: "sh · 本机",
    }),
  ).toBeNull();
  expect(screen.getByLabelText("工作区入口")).toBeTruthy();
  expect(mocks.request.mock.calls.some((c) => c[0] === "ssh")).toBe(false);
  expect(mocks.disposed).not.toHaveBeenCalled();
  view.rerender(<Workspace {...props} />);
  await act(async () => {});
  expect(screen.getByRole("tab", { name: "sh · 本机" })).toBeTruthy();
  expect(mocks.disposed).not.toHaveBeenCalled();
});

it("starts empty, returns to the same launcher after last close, and persists the empty state", async () => {
  const view = render(<Workspace {...props} />);
  await act(async () => {});
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "添加工作区标签" })).toBeNull();
  expect(screen.getByLabelText("工作区入口")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  expect(screen.getByRole("tab", { name: "文件" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "关闭文件" }));
  });
  expect(screen.getByLabelText("工作区入口")).toBeTruthy();
  view.unmount();
  render(<Workspace {...props} />);
  await act(async () => {});
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(readWorkspace(props.workspaceId).tabs).toEqual([]);
});
it("isolates conversations in the same project and restores selection and expansion", async () => {
  const one = props.workspaceId,
    two = crypto.randomUUID();
  const view = render(<Workspace {...props} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "文件" }));
  fireEvent.click(screen.getByRole("button", { name: "展开工作区到主区域" }));
  view.rerender(<Workspace {...props} workspaceId={two} />);
  await act(async () => {});
  expect(screen.getByLabelText("工作区入口")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "展开工作区到主区域" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "变更" }));
  view.rerender(<Workspace {...props} workspaceId={one} />);
  await act(async () => {});
  expect(
    screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByRole("tab", { name: "变更" })).toBeNull();
  expect(screen.getByRole("button", { name: "分离右侧栏" })).toBeTruthy();
});
it("reconciles only this conversation's terminal IDs, never imports project terminals", async () => {
  const terminal = {
    id: "mine",
    project_id: "one",
    title: "sh",
    exited: false,
    exit_code: null,
  };
  updateWorkspace(props.workspaceId, {
    tabs: [{ id: "mine", kind: "terminal", terminal }],
    current: "mine",
  });
  mocks.request.mockResolvedValue({
    kind: "terminals",
    terminals: [terminal, { ...terminal, id: "other-conversation" }],
  });
  render(<Workspace {...props} />);
  await act(async () => {});
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(readWorkspace(props.workspaceId).tabs.map((t) => t.id)).toEqual([
    "mine",
  ]);
});

it("keeps the same conversation sidebar when its host/project changes and routes old terminals to their original host", async () => {
  const terminal = {
    id: "original",
    project_id: "one",
    title: "sh",
    exited: false,
    exit_code: null,
  };
  updateWorkspace(props.workspaceId, {
    tabs: [
      {
        id: "original",
        kind: "terminal",
        hostId: "local",
        hostName: "本机",
        project,
        terminal,
      },
    ],
    current: "original",
  });
  mocks.request.mockImplementation(
    async (_host: string, r: Request): Promise<Response> =>
      r.method === "terminals"
        ? { kind: "terminals", terminals: [terminal] }
        : { kind: "ok" },
  );
  const view = render(<Workspace {...props} />);
  await act(async () => {});
  view.rerender(
    <Workspace
      {...props}
      hostId="remote"
      hostName="远程"
      project={{ id: "two", name: "Two", path: "/two" }}
    />,
  );
  await act(async () => {});
  expect(screen.getByRole("tab", { name: "sh · 本机" })).toBeTruthy();
  expect(mocks.request).toHaveBeenLastCalledWith("local", {
    method: "terminals",
    project_id: "one",
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "关闭sh · 本机" }));
  });
  expect(mocks.request).toHaveBeenLastCalledWith("local", {
    method: "close_terminal",
    terminal_id: "original",
  });
});

it("keeps conversation first in merged tabs, supports keyboard selection, and preserves resource instances", async () => {
  const terminal = {
    id: "merged-shell",
    project_id: "one",
    title: "sh",
    exited: false,
    exit_code: null,
  };
  mocks.request.mockResolvedValue({ kind: "terminals", terminals: [terminal] });
  updateWorkspace(props.workspaceId, {
    tabs: [
      { id: "files", kind: "files" },
      { id: terminal.id, kind: "terminal", terminal },
    ],
    current: "files",
    expanded: true,
    conversationActive: true,
  });
  const view = render(<Workspace {...props} conversationTitle="测试对话" />);
  await act(async () => {});
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "测试对话",
    "文件",
    "sh · 本机",
  ]);
  expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("button", { name: "关闭测试对话" })).toBeNull();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
  expect(screen.getByRole("tabpanel").textContent).toContain("文件预览");
  expect(document.activeElement).toBe(tabs[1]);
  fireEvent.keyDown(tabs[1], { key: "End" });
  expect(screen.getByRole("tabpanel").textContent).toContain(
    "Shell merged-shell",
  );
  fireEvent.keyDown(tabs[2], { key: "Home" });
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(mocks.disposed).not.toHaveBeenCalled();
  view.rerender(
    <Workspace {...props} conversationTitle="测试对话" visible={false} />,
  );
  view.rerender(<Workspace {...props} conversationTitle="测试对话" />);
  expect(
    screen.getByRole("tab", { name: "测试对话" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "分离右侧栏" }));
  expect(props.close).toHaveBeenCalledTimes(1);
  act(() => updateWorkspace(props.workspaceId, { expanded: false }));
  expect(screen.queryByRole("tab", { name: "测试对话" })).toBeNull();
  expect(screen.getByRole("tabpanel").textContent).toContain(
    "Shell merged-shell",
  );
  expect(mocks.disposed).not.toHaveBeenCalled();
});
it("keeps a merged conversation tab when all resources close or no project is selected", async () => {
  updateWorkspace(props.workspaceId, {
    tabs: [{ id: "files", kind: "files" }],
    current: "files",
    expanded: true,
  });
  const view = render(<Workspace {...props} conversationTitle="保留对话" />);
  await act(async () => {});
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "关闭文件" })),
  );
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(
    screen.getByRole("tab", { name: "保留对话" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "添加工作区标签" })).toBeTruthy();
  view.rerender(
    <Workspace {...props} project={undefined} conversationTitle="新任务" />,
  );
  expect(
    screen.getByRole("tab", { name: "新任务" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "分离右侧栏" })).toBeTruthy();
});
