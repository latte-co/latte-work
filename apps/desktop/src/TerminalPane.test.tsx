// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APPEARANCE_EVENT } from "./appearance";
import { TerminalPane } from "./TerminalPane";
import type { Request, Response, TerminalInfo } from "./protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  write: vi.fn(),
  input: null as null | ((text: string) => void),
  dispose: vi.fn(),
  options: {} as Record<string, unknown>,
}));
vi.mock("./api", () => ({
  request: mocks.request,
  message: (e: unknown) => String(e),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = mocks.options;
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    reset() {}
    dispose = mocks.dispose;
    write = mocks.write;
    onData(fn: (text: string) => void) {
      mocks.input = fn;
    }
    onBinary() {}
    attachCustomKeyEventHandler() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
const terminal: TerminalInfo = {
  id: "test-terminal",
  project_id: "project",
  title: "sh",
  exited: false,
  exit_code: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.options = {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.write.mockImplementation((_data, done) => done());
  mocks.request.mockImplementation(
    async (_host: string, request: Request): Promise<Response> =>
      request.method === "read_terminal"
        ? {
            kind: "terminal_output",
            terminal,
            data: [],
            next: 0,
            has_more: false,
            truncated: false,
          }
        : { kind: "ok" },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps emulator and cursor across hidden tabs and serializes pending output", async () => {
  let finish!: () => void;
  mocks.write.mockImplementationOnce((_data, done) => {
    finish = done;
  });
  mocks.request.mockImplementation(
    async (_host: string, request: Request): Promise<Response> =>
      request.method === "read_terminal"
        ? {
            kind: "terminal_output",
            terminal,
            data: request.after === 0 ? [65] : [],
            next: 1,
            has_more: false,
            truncated: false,
          }
        : { kind: "ok" },
  );
  const props = { hostId: "host", terminal, active: true, connected: true };
  const view = render(<TerminalPane {...props} />);
  await act(async () => {});
  expect(mocks.write).toHaveBeenCalledTimes(1);
  view.rerender(<TerminalPane {...props} active={false} />);
  view.rerender(<TerminalPane {...props} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(
    mocks.request.mock.calls.filter((c) => c[1].method === "read_terminal"),
  ).toHaveLength(1);
  await act(async () => {
    finish();
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(mocks.request).toHaveBeenLastCalledWith("host", {
    method: "read_terminal",
    terminal_id: "test-terminal",
    after: 1,
  });
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).not.toHaveBeenCalled();
});
it("does not replay ambiguous input or queued commands on retry", async () => {
  mocks.request.mockImplementation(
    async (_host: string, request: Request): Promise<Response> => {
      if (request.method === "write_terminal")
        throw new Error("transport lost");
      return {
        kind: "terminal_output",
        terminal,
        data: [],
        next: 0,
        has_more: false,
        truncated: false,
      };
    },
  );
  render(<TerminalPane hostId="host" terminal={terminal} active connected />);
  await act(async () => {});
  await act(async () => {
    mocks.input?.("command one\r");
    mocks.input?.("command two\r");
  });
  expect(screen.getByRole("alert").textContent).toContain("未自动重发");
  expect(
    mocks.request.mock.calls.filter((c) => c[1].method === "write_terminal"),
  ).toHaveLength(1);
  await act(async () => {
    screen.getByText("重新连接").click();
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(
    mocks.request.mock.calls.filter((c) => c[1].method === "write_terminal"),
  ).toHaveLength(1);
});

it("refreshes colors and fonts without recreating a live terminal or replaying input", async () => {
  const view = render(
    <TerminalPane hostId="local" terminal={terminal} active connected />,
  );
  const pane = view.container.querySelector<HTMLElement>(".terminal-screen")!;
  pane.style.setProperty("--color-canvas", "#ffffff");
  pane.style.setProperty("--color-text", "#202020");
  pane.style.setProperty("--font-code", "Menlo, monospace");
  pane.style.setProperty("--weight-code", "500");
  await act(async () => window.dispatchEvent(new Event(APPEARANCE_EVENT)));
  expect(mocks.options.theme).toMatchObject({
    background: "#ffffff",
    foreground: "#202020",
  });
  expect(mocks.options.fontFamily).toBe("Menlo, monospace");
  expect(mocks.options.fontWeight).toBe(500);
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(
    mocks.request.mock.calls.some(
      ([, request]) => request.method === "write_terminal",
    ),
  ).toBe(false);
});
