// @vitest-environment jsdom
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StatusCenter } from "./StatusCenter";
import {
  useStatusIssues,
  useStatusNotices,
  type StatusIssue,
  type StatusNotice,
} from "./statusNotices";

afterEach(cleanup);
const notice: StatusNotice = {
  id: "connection:remote",
  level: "error",
  title: "Devbox 暂时无法连接",
  detail: "SSH connection closed",
};
function Source({ notices }: { notices: StatusNotice[] }) {
  useStatusNotices(notices);
  return null;
}
function Issues({ issues }: { issues: StatusIssue[] }) {
  useStatusIssues(issues);
  return null;
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: /^状态提示/ }));
  return within(screen.getByRole("dialog", { name: "状态提示" }));
}

it("deduplicates shared failures, removes resolved sources, and works under StrictMode", () => {
  const view = render(
    <StrictMode>
      <StatusCenter />
      <Source notices={[notice]} />
      <Source notices={[notice]} />
    </StrictMode>,
  );
  expect(screen.getByRole("button", { name: "状态提示（1）" })).toBeTruthy();
  expect(screen.queryByText(notice.detail)).toBeNull();
  expect(open().getAllByText(notice.title)).toHaveLength(1);
  view.rerender(
    <StrictMode>
      <StatusCenter />
      <Source notices={[]} />
      <Source notices={[notice]} />
    </StrictMode>,
  );
  expect(screen.getByRole("button", { name: "状态提示（1）" })).toBeTruthy();
  view.rerender(
    <StrictMode>
      <StatusCenter />
      <Source notices={[]} />
    </StrictMode>,
  );
  expect(screen.getByRole("button", { name: "状态提示" })).toBeTruthy();
  expect(screen.queryByText(notice.title)).toBeNull();
  expect(screen.getByRole("dialog").textContent).toContain("当前没有状态提示");
});

it("retains a retry failure until confirmed success and uses the latest action without replay", async () => {
  const first = vi.fn();
  let finish!: () => void;
  const latest = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const issue = {
    id: "history:remote",
    title: "历史暂不可用",
    error: "Read failed",
    action: { label: "重试", run: first },
  };
  const view = render(
    <>
      <StatusCenter />
      <Issues issues={[issue]} />
    </>,
  );
  open();
  view.rerender(
    <>
      <StatusCenter />
      <Issues issues={[{ ...issue, action: { label: "重试", run: latest } }]} />
    </>,
  );
  expect(first).not.toHaveBeenCalled();
  expect(latest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  fireEvent.click(screen.getByRole("button", { name: "处理中…" }));
  expect(latest).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  view.rerender(
    <>
      <StatusCenter />
      <Issues issues={[{ ...issue, error: "", pending: true }]} />
    </>,
  );
  expect(screen.getByText("Read failed")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "处理中…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => finish());
  view.rerender(
    <>
      <StatusCenter />
      <Issues issues={[{ ...issue, error: "", pending: false }]} />
    </>,
  );
  expect(screen.queryByText("Read failed")).toBeNull();
});

it("keeps actions explicit, orders severity, and reports action failure in the same place", async () => {
  const action = vi.fn().mockRejectedValue(new Error("Retry failed"));
  render(
    <>
      <StatusCenter />
      <Source
        notices={[
          {
            ...notice,
            id: "legacy",
            level: "warning",
            title: "完整历史暂不可用",
          },
          { ...notice, action: { label: "重新连接", run: action } },
        ]}
      />
    </>,
  );
  expect(action).not.toHaveBeenCalled();
  const panel = open();
  expect(panel.getAllByRole("listitem")[0].textContent).toContain(notice.title);
  fireEvent.click(panel.getByRole("button", { name: "重新连接" }));
  expect((await panel.findByRole("alert")).textContent).toContain(
    "Retry failed",
  );
  expect(action).toHaveBeenCalledOnce();
});

it("restores focus on Escape and closes when focus or pointer leaves the popover", () => {
  render(
    <>
      <StatusCenter />
      <button>Other</button>
      <Source notices={[notice]} />
    </>,
  );
  open();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "关闭状态提示" }),
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "状态提示（1）" }),
  );
  open();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Other" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  open();
  act(() => screen.getByRole("button", { name: "Other" }).focus());
  expect(screen.queryByRole("dialog")).toBeNull();
});
