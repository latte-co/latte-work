// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  attachmentKind,
  isLongPaste,
  storePastedFile,
} from "./pasteAttachments";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./api", () => ({ native: true }));
beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "finish_paste_upload")
      return {
        name: "test.bin",
        path: "/remote/paste/test.bin",
        directory: false,
      };
    return args.request.method === "begin_attachment"
      ? { kind: "attachment_upload", id: "upload" }
      : { kind: "ok" };
  });
});
function file(size: number): File {
  return {
    name: "test.bin",
    size,
    type: "application/octet-stream",
    slice: (start: number, end: number) => ({
      arrayBuffer: async () =>
        new Uint8Array(Math.min(size, end) - start).fill(42).buffer,
    }),
  } as File;
}
it("distinguishes media without treating ordinary document files as pasted text", () => {
  expect(attachmentKind("image.bin", "image/png")).toBe("image");
  expect(attachmentKind("clip.MOV")).toBe("video");
  expect(attachmentKind("report.pdf")).toBe("file");
  expect(attachmentKind("notes.txt")).toBe("file");
  expect(isLongPaste("x".repeat(8000))).toBe(false);
  expect(isLongPaste("x".repeat(8001))).toBe(true);
  expect(isLongPaste("line\n".repeat(200))).toBe(true);
});
it("streams bounded chunks in order and only exposes the destination path after completion", async () => {
  const progress = vi.fn();
  const entry = await storePastedFile(
    file(140000),
    "devbox",
    () => true,
    progress,
  );
  const requests = mocks.invoke.mock.calls
    .filter(([method]) => method === "paste_stage")
    .map(([, args]) => args.request);
  expect(requests.map((r) => r.offset).filter((v) => v !== undefined)).toEqual([
    0, 65536, 131072,
  ]);
  expect(requests.slice(1).every((r) => r.data.length <= 65536)).toBe(true);
  expect(mocks.invoke).toHaveBeenLastCalledWith("finish_paste_upload", {
    hostId: "devbox",
    id: "upload",
  });
  expect(entry.path).toBe("/remote/paste/test.bin");
  expect(entry.size).toBe(140000);
  expect(progress).toHaveBeenLastCalledWith(100);
});
it("aborts failed or cancelled streams and rejects oversized files before staging", async () => {
  await expect(
    storePastedFile(
      file(64 * 1024 * 1024 + 1),
      "local",
      () => true,
      () => {},
    ),
  ).rejects.toThrow("64 MiB");
  expect(mocks.invoke).not.toHaveBeenCalled();
  let valid = true;
  mocks.invoke.mockImplementation(async () => {
    valid = false;
    return { kind: "attachment_upload", id: "cancel" };
  });
  await expect(
    storePastedFile(
      file(1),
      "local",
      () => valid,
      () => {},
    ),
  ).rejects.toThrow("取消");
  expect(mocks.invoke).toHaveBeenLastCalledWith("paste_stage", {
    request: { method: "abort_attachment", id: "cancel" },
  });
  expect(
    mocks.invoke.mock.calls.some(
      ([method]) => method === "finish_paste_upload",
    ),
  ).toBe(false);
});
