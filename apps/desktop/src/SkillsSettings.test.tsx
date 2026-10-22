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
  isHostConnected: () => true,
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
it("searches and expands/collapses installed skills, and scopes requests to selected host/project", async () => {
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
  fireEvent.click(screen.getByRole("tab", { name: "项目" }));
  fireEvent.click(screen.getByRole("combobox", { name: "技能所在项目" }));
  fireEvent.click(screen.getByRole("option", { name: "Project" }));
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith("local", {
      method: "skills",
      project_id: "p",
    }),
  );
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
  expect(screen.getByText(/此 Server 不支持技能管理/)).toBeTruthy();
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
it("imports a directory on the selected host, keeping project and operation boundaries", async () => {
  request.mockResolvedValue(catalog());
  render(<SkillsSettings state={state} active onBusy={() => {}} />);
  await screen.findByRole("button", { name: /System Review/ });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  const modal = screen.getByRole("dialog", { name: "添加技能" });
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

it("Try now passes the chosen project without sending a prompt, and Escape closes only the dialog", async () => {
  const onTry = vi.fn().mockResolvedValue(undefined);
  request.mockImplementation(async (_host, action) =>
    action.method === "skill_detail"
      ? { kind: "skill_detail", skill: system, markdown: "# Skill" }
      : catalog(),
  );
  render(
    <SkillsSettings state={state} active onBusy={() => {}} onTry={onTry} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /System Review/ }));
  await screen.findByRole("switch");
  const trial = screen.getByRole("button", { name: "立即试用" });
  expect((trial as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("combobox", { name: "试用技能的项目" }));
  fireEvent.click(screen.getByRole("option", { name: "Project" }));
  fireEvent.click(trial);
  await waitFor(() => expect(onTry).toHaveBeenCalledWith("local", "p", system));
  expect(
    request.mock.calls.every(([, action]) =>
      ["skills", "skill_detail"].includes(action.method),
    ),
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
