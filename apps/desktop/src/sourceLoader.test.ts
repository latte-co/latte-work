import { expect, it, vi, beforeEach } from "vitest";
import { loadSource } from "./sourceLoader";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request }));
beforeEach(() => vi.clearAllMocks());
it("assembles bounded chunks and rejects changed metadata or invalid cursors", async () => {
  const data = Array(65536).fill(65);
  mocks.request
    .mockResolvedValueOnce({
      kind: "source_preview",
      data,
      mime_type: "text/plain",
      size: 65538,
      next: 65536,
      has_more: true,
    })
    .mockResolvedValueOnce({
      kind: "source_preview",
      data: [66, 67],
      mime_type: "text/plain",
      size: 65538,
      next: 65538,
      has_more: false,
    });
  const result = await loadSource(
    "ssh",
    "p",
    "s",
    "/explicit/file",
    () => true,
  );
  expect(result.bytes.length).toBe(65538);
  expect(result.bytes.at(-1)).toBe(67);
  expect(mocks.request.mock.calls[1][1].offset).toBe(65536);
  mocks.request.mockResolvedValue({
    kind: "source_preview",
    data: [1],
    mime_type: "image/png",
    size: 4,
    next: 10,
    has_more: true,
  });
  await expect(
    loadSource("local", "p", "s", "file", () => true),
  ).rejects.toThrow("发生变化");
});
it("fences late responses and rejects oversized media without downloading remaining chunks", async () => {
  let valid = true;
  mocks.request.mockImplementation(async () => {
    valid = false;
    return {
      kind: "source_preview",
      data: [],
      next: 0,
      size: 0,
      has_more: false,
      mime_type: "text/plain",
    };
  });
  await expect(
    loadSource("local", "p", "s", "file", () => valid),
  ).rejects.toThrow("已取消");
  mocks.request.mockResolvedValue({
    kind: "source_preview",
    data: [1],
    next: 1,
    size: 32 * 1024 * 1024,
    has_more: true,
    mime_type: "image/png",
  });
  await expect(
    loadSource("local", "p", "s", "file", () => true),
  ).rejects.toThrow("16 MiB");
});
