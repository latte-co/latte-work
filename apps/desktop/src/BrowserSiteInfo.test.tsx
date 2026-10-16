// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithStatus as render } from "./test/renderWithStatus";
import { BrowserSiteInfo } from "./BrowserSiteInfo";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const props = {
  id: "native-tab",
  url: "https://example.com/guide",
  active: true,
  ready: true,
};
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({
    url: props.url,
    title: "Example guide",
    connection: "secure",
  });
});
afterEach(cleanup);
it("reads the current native page, closes with Escape and restores the trigger", async () => {
  render(<BrowserSiteInfo {...props} />);
  const trigger = screen.getByRole("button", { name: "站点信息" });
  fireEvent.click(trigger);
  expect(await screen.findByText("连接是安全的")).toBeTruthy();
  expect(screen.getByText("example.com")).toBeTruthy();
  expect(screen.getByText("Example guide")).toBeTruthy();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("browser_site_info", {
    id: "native-tab",
    icon: false,
  });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "站点信息" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("does not infer trust from an HTTPS address or accept an old page snapshot", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<BrowserSiteInfo {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "站点信息" }));
  expect(screen.queryByText("连接是安全的")).toBeNull();
  await act(async () =>
    finish({ url: "https://old.example/", connection: "secure" }),
  );
  expect(screen.getByText("页面已变化，请重新查看站点信息")).toBeTruthy();
  expect(screen.queryByText("连接是安全的")).toBeNull();
});
it("shows actual HTTP status, closes when hidden, and keeps blank tabs disabled", async () => {
  invoke.mockResolvedValue({
    url: "http://example.com/",
    title: "Example",
    connection: "insecure",
  });
  const view = render(<BrowserSiteInfo {...props} url="http://example.com/" />);
  fireEvent.click(screen.getByRole("button", { name: "站点信息" }));
  expect(await screen.findByText("连接未加密")).toBeTruthy();
  view.rerender(<BrowserSiteInfo {...props} active={false} />);
  expect(screen.queryByRole("dialog", { name: "站点信息" })).toBeNull();
  view.rerender(<BrowserSiteInfo {...props} url="" />);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "站点信息" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
});
it("closes on outside click and does not expose fictitious permission settings", async () => {
  render(<BrowserSiteInfo {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "站点信息" }));
  await screen.findByText("连接是安全的");
  expect(screen.queryByText("网站设置")).toBeNull();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog", { name: "站点信息" })).toBeNull();
});
