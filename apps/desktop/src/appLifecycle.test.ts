// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { CloseCoordinator } from "./appLifecycle";
it("awaits every tab, including hidden resources, and coalesces repeated Quit", async () => {
  const close = new CloseCoordinator();
  let finish!: () => void;
  const terminal = vi.fn(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  const files = vi.fn();
  close.register({ label: "hidden terminal", close: terminal });
  close.register({ label: "files", close: files });
  const pending = close.run();
  expect(close.run()).toBe(pending);
  await Promise.resolve();
  expect(terminal).toHaveBeenCalledOnce();
  expect(files).toHaveBeenCalledOnce();
  let done = false;
  void pending.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  finish();
  await pending;
  expect(done).toBe(true);
});
it("aggregates named failures, still runs other tabs and supports retry/resume", async () => {
  const close = new CloseCoordinator();
  const resume = vi.fn();
  let fails = true;
  close.register({
    label: "SSH terminal",
    close: () => {
      if (fails) throw Error("offline");
    },
    resume,
  });
  const file = vi.fn();
  close.register({ label: "files", close: file });
  await expect(close.run()).rejects.toThrow("SSH terminal：offline");
  expect(file).toHaveBeenCalledOnce();
  close.resume();
  expect(resume).toHaveBeenCalledOnce();
  fails = false;
  await close.run();
});
it("unregisters closed tabs without closing resources on mere unmount", async () => {
  const close = new CloseCoordinator();
  const callback = vi.fn();
  const unregister = close.register({ label: "terminal", close: callback });
  unregister();
  expect(callback).not.toHaveBeenCalled();
  await close.run();
  expect(callback).not.toHaveBeenCalled();
});
