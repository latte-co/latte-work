import { expect, it, vi, beforeEach } from "vitest";
import { loadChangeImage } from "./changeImageLoader";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request }));
const target = { kind: "turn" as const, session_id: "s", request_id: "r" };
const chunk = {
  data: [137, 80],
  mime_type: "image/png",
  size: 4,
  next: 2,
  has_more: true,
  version: "saved",
  sha256: null,
};
beforeEach(() => mocks.request.mockReset());
it("reads bounded chunks from the selected host and exact saved request", async () => {
  mocks.request
    .mockResolvedValueOnce({ kind: "change_preview", chunk })
    .mockResolvedValueOnce({
      kind: "change_preview",
      chunk: { ...chunk, data: [78, 71], next: 4, has_more: false },
    });
  const image = await loadChangeImage(
    "devbox",
    target,
    "image.png",
    false,
    () => true,
  );
  expect([...image!.bytes]).toEqual([137, 80, 78, 71]);
  expect(mocks.request.mock.calls.map((c) => c[1].offset)).toEqual([0, 2]);
  expect(mocks.request.mock.calls[1]).toEqual([
    "devbox",
    {
      method: "preview_change",
      target,
      path: "image.png",
      before: false,
      offset: 2,
    },
  ]);
});
it("rejects changed versions, missing middle chunks, corrupt hashes and oversized images", async () => {
  for (const next of [
    { ...chunk, version: "later", next: 4, has_more: false },
    null,
    { ...chunk, next: 5 },
    { ...chunk, size: 17 * 1024 * 1024 },
  ]) {
    mocks.request
      .mockReset()
      .mockResolvedValueOnce({ kind: "change_preview", chunk })
      .mockResolvedValueOnce({ kind: "change_preview", chunk: next });
    await expect(
      loadChangeImage("h", target, "image.png", true, () => true),
    ).rejects.toThrow();
  }
  mocks.request.mockReset().mockResolvedValue({
    kind: "change_preview",
    chunk: { ...chunk, size: 2, has_more: false, sha256: "0".repeat(64) },
  });
  await expect(
    loadChangeImage("h", target, "image.png", true, () => true),
  ).rejects.toThrow("校验失败");
});
it("cancels late responses and keeps absent sides distinct from unsupported servers", async () => {
  let valid = true;
  mocks.request.mockImplementation(async () => {
    valid = false;
    return { kind: "change_preview", chunk };
  });
  await expect(
    loadChangeImage("h", target, "image.png", false, () => valid),
  ).rejects.toThrow("已取消");
  expect(mocks.request).toHaveBeenCalledTimes(1);
  mocks.request.mockResolvedValue({ kind: "change_preview", chunk: null });
  await expect(
    loadChangeImage("h", target, "image.png", true, () => true),
  ).resolves.toBeNull();
  mocks.request.mockResolvedValue({ kind: "content", text: "binary" });
  await expect(
    loadChangeImage("h", target, "image.png", true, () => true),
  ).rejects.toThrow("更新");
});
