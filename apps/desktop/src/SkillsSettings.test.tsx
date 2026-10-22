// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SkillsSettings } from "./SkillsSettings";
import type { Workbench } from "./useWorkbench";
import type { ManagedSkill } from "./protocol";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request, message: (e: unknown) => String(e) }));
const state = {
  host: { id: "local", name: "本机" },
  hosts: [
    { id: "local", name: "本机" },
    { id: "devbox", name: "devbox" },
  ],
  projects: [{ id: "p", hostId: "local", name: "Project", path: "/project" }],
  projectId: "p",
  isHostConnected: () => true,
  hostConnectionVersions: {},
  hostSupportsSkills: () => true,
} as unknown as Workbench;
const platform: ManagedSkill = {
  id: "platform:context",
  name: "Work Context",
  description: "Only in Work",
  scope: "platform",
  state: "enabled",
  directory: null,
  origin: "Latte Work",
};
const system: ManagedSkill = {
  id: "file:system",
  name: "System Review",
  description: "Review code",
  scope: "system",
  state: "enabled",
  directory: "/home/.agents/skills/review",
  origin: "/home/.agents/skills",
};
function catalog(skills = [platform, system]) {
  return { kind: "skills", skills, warnings: [], truncated: false };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("searches and expands/collapses installed skills, and keeps every request global on the selected host", async () => {
  request.mockResolvedValue(
    catalog([
      platform,
      ...Array.from({ length: 8 }, (_, i) => ({
        ...system,
        id: `s${i}`,
        name: `Review ${i}`,
      })),
    ]),
  );
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  await screen.findByText("查看全部，另有 3 项");
  fireEvent.click(screen.getByText("查看全部，另有 3 项"));
  expect(screen.getByRole("button", { name: /Review 7/ })).toBeTruthy();
  fireEvent.click(screen.getByText("收起"));
  expect(screen.queryByRole("button", { name: /Review 7/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), {
    target: { value: "Review 7" },
  });
  expect(screen.getByRole("button", { name: /Review 7/ })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "项目" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "技能所在项目" })).toBeNull();
  expect(request).toHaveBeenCalledWith("local", {
    method: "skills",
    project_id: null,
  });
  fireEvent.click(screen.getByRole("combobox", { name: "技能所在主机" }));
  fireEvent.click(screen.getByRole("option", { name: "devbox" }));
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith("devbox", {
      method: "skills",
      project_id: null,
    }),
  );
});
it("requires confirmation for native mutation and refreshes actual state without launching an Agent", async () => {
  let entry = { ...system };
  request.mockImplementation(async (_host, action) => {
    if (action.method === "skill_detail")
      return {
        kind: "skill_detail",
        skill: entry,
        markdown:
          "---\nname: Review\n---\n# Safe body\n![private](https://example.test/image)",
      };
    if (action.method === "set_skill_state")
      entry = { ...entry, state: action.state };
    return catalog([entry]);
  });
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /System Review/ }));
  fireEvent.click(await screen.findByRole("switch", { name: "启用技能" }));
  const dialog = screen.getByRole("dialog", { name: /禁用 System Review/ });
  expect(
    request.mock.calls.some(
      ([, action]) => action.method === "set_skill_state",
    ),
  ).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.getByRole("dialog", { name: "System Review" })).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "启用技能" }));
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: /禁用 System Review/ }),
    ).getByRole("button", { name: "确认" }),
  );
  await screen.findByText("已保存。对后续新建的 Agent 会话生效。");
  expect(request).toHaveBeenCalledWith("local", {
    method: "set_skill_state",
    project_id: null,
    id: system.id,
    state: "disabled",
    expected_state: "enabled",
  });
  expect(
    request.mock.calls.every(([, action]) =>
      ["skills", "skill_detail", "set_skill_state"].includes(action.method),
    ),
  ).toBe(true);
});
it("ignores delayed inventory after switching hosts, and stops reads when hidden", async () => {
  let finish: (value: unknown) => void = () => {};
  request.mockImplementation((host) =>
    host === "local"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(catalog([{ ...system, name: "Remote Only" }])),
  );
  const view = render(
    <SkillsSettings state={state} active onBusy={() => {}} />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "技能所在主机" }));
  fireEvent.click(screen.getByRole("option", { name: "devbox" }));
  await screen.findByRole("button", { name: /Remote Only/ });
  finish(catalog([platform]));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Work Context/ })).toBeNull(),
  );
  const calls = request.mock.calls.length;
  view.rerender(
    <SkillsSettings state={state} active={false} onBusy={() => {}} />,
  );
  expect(request.mock.calls.length).toBe(calls);
});
it("shows unsupported-server errors and does not retry a failed mutation", async () => {
  request.mockResolvedValueOnce({ kind: "ok" });
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  await screen.findByRole("alert");
  expect(screen.getByText(/本机 的 Server 版本较旧/)).toBeTruthy();
  request.mockImplementation(async (_host, action) => {
    if (action.method === "skill_detail")
      return { kind: "skill_detail", skill: platform, markdown: "# Platform" };
    if (action.method === "set_skill_state") throw new Error("connection lost");
    return catalog([platform]);
  });
  fireEvent.click(screen.getByRole("button", { name: "刷新核对" }));
  const buttons = await screen.findAllByRole("button", {
    name: /Work Context/,
  });
  fireEvent.click(buttons[0]);
  fireEvent.click(await screen.findByRole("switch", { name: "启用技能" }));
  await screen.findByText(/不会自动重试操作/);
  expect(
    request.mock.calls.filter(
      ([, action]) => action.method === "set_skill_state",
    ),
  ).toHaveLength(1);
});
it("keeps host labels readable in a right-aligned menu wider than the compact trigger", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  request.mockResolvedValue(catalog());
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  await screen.findByRole("button", { name: /System Review/ });
  const trigger = screen.getByRole("combobox", { name: "技能所在主机" });
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    left: 600,
    right: 680,
    top: 50,
    bottom: 86,
    width: 80,
    height: 36,
    x: 600,
    y: 50,
    toJSON: () => ({}),
  });
  fireEvent.click(trigger);
  const menu = screen.getByRole("listbox").parentElement!;
  expect(menu.style.width).toBe("240px");
  expect(menu.style.left).toBe("440px");
  expect(screen.getByRole("option", { name: "本机" })).toBeTruthy();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith("devbox", {
      method: "skills",
      project_id: null,
    }),
  );
});
it("explains an older remote server without exposing the wire parser error, then reloads after reconnect", async () => {
  let remoteSupported = false;
  const capabilityState = {
    ...state,
    hostSupportsSkills: (id: string) => id === "local" || remoteSupported,
  };
  request.mockResolvedValue(catalog());
  const view = render(
    <SkillsSettings state={capabilityState} active onBusy={() => {}} />,
  );
  await screen.findByRole("button", { name: /System Review/ });
  fireEvent.click(screen.getByRole("combobox", { name: "技能所在主机" }));
  fireEvent.click(screen.getByRole("option", { name: "devbox" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("devbox 的 Server 版本较旧");
  expect(alert.textContent).toContain("在该远程主机上更新并重启");
  expect(request.mock.calls.some(([host]) => host === "devbox")).toBe(false);
  expect(
    (screen.getByRole("button", { name: "添加" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "刷新技能" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  const count = request.mock.calls.length;
  remoteSupported = true;
  request.mockResolvedValue(catalog([{ ...system, name: "Remote Updated" }]));
  view.rerender(
    <SkillsSettings
      state={{ ...capabilityState, hostConnectionVersions: { devbox: 2 } }}
      active
      onBusy={() => {}}
    />,
  );
  await screen.findByRole("button", { name: /Remote Updated/ });
  expect(request.mock.calls.length).toBe(count + 1);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("imports a directory on the selected host, only into the global directory", async () => {
  request.mockResolvedValue(catalog());
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  await screen.findByRole("button", { name: /System Review/ });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  const modal = screen.getByRole("dialog", { name: "添加技能" });
  expect(within(modal).queryByRole("combobox")).toBeNull();
  expect(within(modal).getByText(/~\/.agents\/skills/)).toBeTruthy();
  fireEvent.change(within(modal).getByRole("textbox"), {
    target: { value: "/import/my-skill" },
  });
  fireEvent.click(within(modal).getByRole("button", { name: "添加" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("local", {
      method: "install_skill",
      project_id: null,
      scope: "system",
      path: "/import/my-skill",
    }),
  );
});

it.each(["enabled", "disabled"] as const)(
  "shows an installed %s skill without a trial project or task action",
  async (skillState) => {
    const entry = { ...system, state: skillState };
    request.mockImplementation(async (_host, action) =>
      action.method === "skill_detail"
        ? { kind: "skill_detail", skill: entry, markdown: "# Skill" }
        : catalog([entry]),
    );
    render(<SkillsSettings state={state} active onBusy={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /System Review/ }),
    );
    const installed = await screen.findByRole("button", { name: "已安装" });
    expect((installed as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "立即试用" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "试用技能的项目" }),
    ).toBeNull();
    fireEvent.click(installed);
    expect(
      request.mock.calls.every(([, action]) =>
        ["skills", "skill_detail"].includes(action.method),
      ),
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  },
);
it("installs an uninstalled global skill with explicit confirmation and never creates a task", async () => {
  let entry: ManagedSkill = { ...system, state: "uninstalled" };
  request.mockImplementation(async (_host, action) => {
    if (action.method === "skill_detail")
      return { kind: "skill_detail", skill: entry, markdown: "# Skill" };
    if (action.method === "set_skill_state")
      entry = { ...entry, state: action.state };
    return catalog([entry]);
  });
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  await screen.findByRole("tab", { name: "系统" });
  fireEvent.click(screen.getByRole("tab", { name: "系统" }));
  fireEvent.click(await screen.findByRole("button", { name: /System Review/ }));
  fireEvent.click(await screen.findByRole("button", { name: "安装" }));
  const dialog = screen.getByRole("dialog", { name: "安装 System Review？" });
  expect(
    request.mock.calls.some(
      ([, action]) => action.method === "set_skill_state",
    ),
  ).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
  await screen.findByText("已保存。对后续新建的 Agent 会话生效。");
  expect(request).toHaveBeenCalledWith("local", {
    method: "set_skill_state",
    project_id: null,
    id: system.id,
    state: "enabled",
    expected_state: "uninstalled",
  });
  expect(
    request.mock.calls.every(([, action]) =>
      ["skills", "skill_detail", "set_skill_state"].includes(action.method),
    ),
  ).toBe(true);
});
it("ignores legacy project entries and current conversation project changes", async () => {
  request.mockResolvedValue(
    catalog([
      platform,
      system,
      { ...system, id: "project-only", scope: "project", name: "Project Only" },
    ]),
  );
  const view = render(
    <SkillsSettings state={state} active onBusy={() => {}} />,
  );
  await screen.findByRole("button", { name: /System Review/ });
  expect(screen.queryByRole("button", { name: /Project Only/ })).toBeNull();
  const calls = request.mock.calls.length;
  view.rerender(
    <SkillsSettings
      state={{ ...state, projectId: "another" }}
      active
      onBusy={() => {}}
    />,
  );
  expect(request.mock.calls.length).toBe(calls);
});

it("restores focus after uninstall removes the installed-row trigger and describes the confirmation impact", async () => {
  let entry = { ...system };
  request.mockImplementation(async (_host, action) => {
    if (action.method === "skill_detail")
      return { kind: "skill_detail", skill: entry, markdown: "# Skill" };
    if (action.method === "set_skill_state")
      entry = { ...entry, state: action.state };
    return catalog([platform, entry]);
  });
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  const row = await screen.findByRole("button", { name: /System Review/ });
  row.focus();
  fireEvent.click(row);
  fireEvent.click(await screen.findByRole("button", { name: "卸载" }));
  const confirm = screen.getByRole("dialog", { name: /卸载 System Review/ });
  const description = document.getElementById(
    confirm.getAttribute("aria-describedby")!,
  );
  expect(description?.textContent).toContain("会移动当前安装目录");
  expect(description?.textContent).toContain(system.directory);
  fireEvent.click(within(confirm).getByRole("button", { name: "确认" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(row.isConnected).toBe(false);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "刷新技能" }),
    ),
  );
});
it("associates import instructions and limits with the dialog and wraps category keyboard navigation", async () => {
  request.mockResolvedValue(catalog());
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  await screen.findByRole("button", { name: /System Review/ });
  const platformTab = screen.getByRole("tab", { name: "平台内置" });
  fireEvent.keyDown(platformTab, { key: "ArrowLeft" });
  expect(
    screen.getByRole("tab", { name: "系统" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(screen.getByRole("tab", { name: "系统" }), {
    key: "ArrowRight",
  });
  expect(platformTab.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  const dialog = screen.getByRole("dialog", { name: "添加技能" });
  const description = dialog
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");
  expect(description).toContain("现有目录导入完整技能");
  expect(description).toContain("512");
  expect(description).toContain("原目录保留");
});
