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
  onExited: vi.fn(),
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
  const props = {
    hostId: "host",
    terminal,
    active: true,
    connected: true,
    onExited: mocks.onExited,
  };
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
  render(
    <TerminalPane
      hostId="host"
      terminal={terminal}
      active
      connected
      onExited={mocks.onExited}
    />,
  );
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
    <TerminalPane
      hostId="local"
      terminal={terminal}
      active
      connected
      onExited={mocks.onExited}
    />,
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

it("closes a hidden terminal on App Quit and reports a failed close", async () => {
  const { appClose } = await import("./appLifecycle");
  let fail = true;
  mocks.request.mockImplementation(async (_host: string, r: Request) => {
    if (r.method === "close_terminal" && fail) throw new Error("offline");
    return { kind: "ok" };
  });
  render(
    <TerminalPane
      hostId="remote"
      terminal={terminal}
      active={false}
      connected={false}
      onExited={mocks.onExited}
    />,
  );
  await act(async () => {
    await expect(appClose.run()).rejects.toThrow("终端 sh · remote：offline");
  });
  fail = false;
  await act(async () => {
    appClose.resume();
    await appClose.run();
  });
  expect(mocks.request).toHaveBeenCalledWith("remote", {
    method: "close_terminal",
    terminal_id: terminal.id,
  });
  expect(mocks.onExited).not.toHaveBeenCalled();
});

it("reports confirmed shell exit once after draining and parsing all output", async () => {
  let finish!: () => void;
  mocks.request.mockImplementation(
    async (_host: string, r: Request): Promise<Response> => {
      if (r.method !== "read_terminal") return { kind: "ok" };
      return {
        kind: "terminal_output",
        terminal: { ...terminal, exited: true, exit_code: 0 },
        data: [r.after === 0 ? 65 : 66],
        next: r.after === 0 ? 1 : 2,
        has_more: r.after === 0,
        truncated: false,
      };
    },
  );
  mocks.write.mockImplementationOnce((_data, done) => done());
  mocks.write.mockImplementationOnce((_data, done) => {
    finish = done;
  });
  const props = {
    hostId: "remote",
    terminal,
    active: true,
    connected: true,
    onExited: mocks.onExited,
  };
  const view = render(<TerminalPane {...props} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(80);
  });
  expect(mocks.write).toHaveBeenCalledTimes(2);
  expect(mocks.onExited).not.toHaveBeenCalled();
  await act(async () => {
    finish();
  });
  expect(mocks.onExited).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Shell 已退出/)).toBeNull();
  expect(mocks.options.disableStdin).toBe(true);
  const laterCallback = vi.fn();
  view.rerender(<TerminalPane {...props} onExited={laterCallback} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(240);
    mocks.input?.("another command\r");
  });
  expect(laterCallback).not.toHaveBeenCalled();
  expect(
    mocks.request.mock.calls.filter(([, r]) => r.method === "read_terminal"),
  ).toHaveLength(2);
  expect(
    mocks.request.mock.calls.some(([, r]) => r.method === "write_terminal"),
  ).toBe(false);
});

it("retires a restored exited terminal even while hidden", async () => {
  const props = {
    hostId: "remote",
    terminal: { ...terminal, exited: true, exit_code: 0 },
    active: false,
    connected: true,
    onExited: mocks.onExited,
  };
  const view = render(<TerminalPane {...props} />);
  await act(async () => {});
  expect(mocks.onExited).toHaveBeenCalledTimes(1);
  view.rerender(<TerminalPane {...props} active />);
  await act(async () => {});
  expect(mocks.onExited).toHaveBeenCalledTimes(1);
});

it("keeps a live terminal after nested-shell logout, read failure, or disconnect", async () => {
  mocks.request.mockImplementation(
    async (_host: string, r: Request): Promise<Response> => {
      if (r.method !== "read_terminal") return { kind: "ok" };
      if (r.after > 0) throw new Error("transport lost");
      return {
        kind: "terminal_output",
        terminal,
        data: Array.from(new TextEncoder().encode("exit\r\nlogout\r\n$ ")),
        next: 20,
        has_more: false,
        truncated: false,
      };
    },
  );
  const props = {
    hostId: "local",
    terminal,
    active: true,
    connected: true,
    onExited: mocks.onExited,
  };
  const view = render(<TerminalPane {...props} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByRole("alert").textContent).toContain("transport lost");
  view.rerender(<TerminalPane {...props} connected={false} />);
  expect(screen.getByRole("status").textContent).toContain("连接已断开");
  expect(mocks.onExited).not.toHaveBeenCalled();
});
