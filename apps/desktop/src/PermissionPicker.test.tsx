// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostConnectionError } from "./connectionErrors";
import { PermissionPicker } from "./PermissionPicker";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const props = {
  hostId: "local",
  agent: "claude",
  connected: true,
  hidden: false,
  value: null as string | null,
  onChange: vi.fn(),
  disabled: false,
};
const catalog = {
  kind: "agent_permissions",
  modes: [
    {
      id: "native-mode",
      label: "Agent 自定义权限",
      description: "由当前 Agent 提供",
      elevated: false,
    },
    {
      id: "unrestricted",
      label: "完全访问权限",
      description: "跳过常规确认",
      elevated: true,
    },
  ],
};
it("renders native choices, supports keyboard selection and sends the original id", async () => {
  mocks.request.mockResolvedValue(catalog);
  const view = render(<PermissionPicker {...props} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("combobox", { name: "Agent 权限" }));
  expect(screen.queryByText("自动接受编辑")).toBeNull();
  expect(screen.getByText("由当前 Agent 提供")).toBeTruthy();
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(props.onChange).toHaveBeenCalledWith("native-mode");
  view.rerender(<PermissionPicker {...props} value="unrestricted" />);
  expect(
    screen.getByRole("combobox").parentElement?.classList.contains("elevated"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("combobox"));
  view.rerender(<PermissionPicker {...props} value="unrestricted" disabled />);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it("ignores previous-host replies and never silently changes a remembered permission", async () => {
  const resolve: ((value: unknown) => void)[] = [];
  mocks.request.mockImplementation(() => new Promise((r) => resolve.push(r)));
  const view = render(<PermissionPicker {...props} value="unrestricted" />);
  view.rerender(
    <PermissionPicker
      {...props}
      hostId="remote"
      agent="other"
      value="unrestricted"
    />,
  );
  await act(async () => resolve[0](catalog));
  expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => resolve[1]({ kind: "agent_permissions", modes: [] }));
  expect(props.onChange).not.toHaveBeenCalled();
  expect(screen.getByText("权限模式不可用")).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: /^跟随 Agent/ }));
  expect(props.onChange).toHaveBeenCalledWith(null);
});
it("offers retry and explicit inheritance after discovery failure", async () => {
  mocks.request
    .mockRejectedValueOnce(new Error("Host 旧版本"))
    .mockResolvedValue(catalog);
  render(<PermissionPicker {...props} />);
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "重新加载权限选项" }).title,
  ).toContain("Host 旧版本");
  const retry = screen.getByRole("button", { name: "重新加载权限选项" });
  expect(retry.textContent).toBe("");
  expect(retry.title).toContain("权限加载失败，点击重试");
  fireEvent.click(retry);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "重新加载权限选项" })).toBeNull();
});

it("does not offer a permission retry when the underlying connection is lost", async () => {
  mocks.request.mockRejectedValue(
    new HostConnectionError("local", "连接已失效"),
  );
  const view = render(<PermissionPicker {...props} value="unrestricted" />);
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "重新加载权限选项" })).toBeNull();
  view.rerender(
    <PermissionPicker {...props} value="unrestricted" connected={false} />,
  );
  expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(props.onChange).not.toHaveBeenCalled();
});
it("hides an old permission error while disconnected", async () => {
  mocks.request.mockRejectedValue(new Error("权限发现失败"));
  const view = render(<PermissionPicker {...props} />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: "重新加载权限选项" })).toBeTruthy();
  view.rerender(<PermissionPicker {...props} connected={false} />);
  expect(screen.queryByRole("button", { name: "重新加载权限选项" })).toBeNull();
});
