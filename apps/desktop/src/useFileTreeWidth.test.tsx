// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFileTreeWidth } from "./useFileTreeWidth";

let available = 800;
let measure: () => void;
const capture = vi.fn();
const release = vi.fn();
const STORAGE_KEY = "latte-work.file-tree-width.v1";

function Harness({ enabled = true }: { enabled?: boolean }) {
  const tree = useFileTreeWidth(enabled);
  return (
    <div ref={tree.container}>
      <div
        role="separator"
        tabIndex={0}
        aria-valuenow={tree.width}
        aria-valuemin={tree.minimum}
        aria-valuemax={tree.maximum}
        onPointerDown={tree.onPointerDown}
        onKeyDown={tree.onKeyDown}
      />
      <nav style={{ flexBasis: tree.width }} />
    </div>
  );
}
const separator = () => screen.getByRole("separator");
const width = () => Number(separator().getAttribute("aria-valuenow"));

beforeEach(() => {
  available = 800;
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => available,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    },
  );
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: capture },
    hasPointerCapture: { configurable: true, value: () => true },
    releasePointerCapture: { configurable: true, value: release },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  capture.mockClear();
  release.mockClear();
  for (const key of [
    "setPointerCapture",
    "hasPointerCapture",
    "releasePointerCapture",
  ])
    Reflect.deleteProperty(HTMLElement.prototype, key);
  document.body.style.userSelect = "";
  document.body.style.webkitUserSelect = "";
  localStorage.clear();
});

it("keeps the saved preference through narrow panes, hide/show and remount", () => {
  localStorage.setItem(STORAGE_KEY, "420");
  const view = render(<Harness />);
  expect(width()).toBe(420);
  act(() => {
    available = 350;
    measure();
  });
  expect(width()).toBe(229);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("420");
  view.rerender(<Harness enabled={false} />);
  act(() => {
    available = 800;
    measure();
  });
  view.rerender(<Harness />);
  expect(width()).toBe(420);
  view.unmount();
  render(<Harness />);
  expect(width()).toBe(420);
  act(() => {
    available = 100;
    measure();
  });
  expect(width()).toBe(49);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("420");
});

it("drags left to widen the right tree, clamps both sides and ignores other pointers", () => {
  render(<Harness />);
  document.body.style.userSelect = "text";
  document.body.style.webkitUserSelect = "text";
  fireEvent.pointerDown(separator(), { button: 0, pointerId: 7, clientX: 560 });
  expect(document.activeElement).toBe(separator());
  expect(capture).toHaveBeenCalledWith(7);
  expect(document.body.style.userSelect).toBe("none");
  fireEvent.pointerMove(window, { pointerId: 8, clientX: 1 });
  expect(width()).toBe(240);
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 460 });
  expect(width()).toBe(340);
  fireEvent.pointerMove(window, { pointerId: 7, clientX: -1000 });
  expect(width()).toBe(679);
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 2000 });
  expect(width()).toBe(160);
  fireEvent.pointerUp(window, { pointerId: 8 });
  expect(document.body.style.userSelect).toBe("none");
  fireEvent.pointerCancel(window, { pointerId: 7 });
  expect(document.body.style.userSelect).toBe("text");
  expect(document.body.style.webkitUserSelect).toBe("text");
  expect(separator().dataset.resizing).toBeUndefined();
  expect(release).toHaveBeenCalledWith(7);
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 460 });
  expect(width()).toBe(160);
});

it("ends a drag when hidden, blurred or unmounted without leaving selection disabled", () => {
  const view = render(<Harness />);
  const start = () =>
    fireEvent.pointerDown(separator(), { button: 0, clientX: 560 });
  start();
  view.rerender(<Harness enabled={false} />);
  expect(document.body.style.userSelect).toBe("");
  view.rerender(<Harness />);
  start();
  fireEvent.blur(window);
  expect(document.body.style.userSelect).toBe("");
  start();
  view.unmount();
  expect(document.body.style.userSelect).toBe("");
});

it("supports bounded keyboard resizing and restores it after remount", () => {
  localStorage.setItem(STORAGE_KEY, "invalid");
  const view = render(<Harness />);
  expect(width()).toBe(240);
  fireEvent.keyDown(separator(), { key: "ArrowLeft" });
  expect(width()).toBe(256);
  fireEvent.keyDown(separator(), { key: "ArrowRight" });
  expect(width()).toBe(240);
  fireEvent.keyDown(separator(), { key: "End" });
  expect(width()).toBe(679);
  fireEvent.keyDown(separator(), { key: "Home" });
  expect(width()).toBe(160);
  fireEvent.keyDown(separator(), { key: "ArrowRight" });
  expect(width()).toBe(160);
  view.unmount();
  render(<Harness />);
  expect(width()).toBe(160);
});
