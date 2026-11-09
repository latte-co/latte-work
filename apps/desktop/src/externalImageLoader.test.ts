// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createExternalImageLoader } from "./externalImageLoader";
import type { SourceData } from "./sourceLoader";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  load: vi.fn(),
}));
vi.mock("./api", () => ({ request: mocks.request }));
vi.mock("./sourceLoader", () => ({ loadSource: mocks.load }));

const pngData: SourceData = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  mime: "image/png",
  size: 4,
  truncated: false,
};

beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue({
    kind: "file_reference",
    entry: { path: "/tmp/qr.png", name: "qr.png", directory: false },
  });
  mocks.load.mockReset().mockResolvedValue(pngData);
});
afterEach(() => vi.clearAllMocks());

describe("createExternalImageLoader", () => {
  it("grants access then returns the verified image payload", async () => {
    const loader = createExternalImageLoader("host", "proj", "session");
    const data = await loader("/tmp/qr.png");
    expect(data).toEqual(pngData);
    expect(mocks.request).toHaveBeenCalledWith("host", {
      method: "resolve_reference",
      project_id: "proj",
      path: "/tmp/qr.png",
    });
    expect(mocks.load).toHaveBeenCalledWith(
      "host",
      "proj",
      "session",
      "/tmp/qr.png",
      expect.any(Function),
      true,
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("revokes the grant when the payload cannot render as an image", async () => {
    mocks.load.mockResolvedValue({ ...pngData, mime: "text/plain" });
    const loader = createExternalImageLoader("host", "proj", undefined);
    await expect(loader("/tmp/notes.txt")).rejects.toThrow(
      "此文件不能作为图片预览",
    );
    expect(mocks.request).toHaveBeenLastCalledWith("host", {
      method: "revoke_reference_access",
      project_id: "proj",
      path: "/tmp/notes.txt",
    });
  });

  it("revokes the grant when the read fails", async () => {
    mocks.load.mockRejectedValue(new Error("来源文件在读取期间发生变化"));
    const loader = createExternalImageLoader("host", "proj", undefined);
    await expect(loader("/tmp/qr.png")).rejects.toThrow(
      "来源文件在读取期间发生变化",
    );
    expect(mocks.request).toHaveBeenLastCalledWith("host", {
      method: "revoke_reference_access",
      project_id: "proj",
      path: "/tmp/qr.png",
    });
  });

  it("fails without reading when the server cannot resolve the reference", async () => {
    mocks.request.mockResolvedValue({ kind: "ok" });
    const loader = createExternalImageLoader("host", "proj", undefined);
    await expect(loader("/tmp/qr.png")).rejects.toThrow("无法解析引用");
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("keeps the original failure even if the revoke itself fails", async () => {
    mocks.load.mockRejectedValue(new Error("读取超时"));
    mocks.request.mockImplementation((_host, payload) =>
      payload.method === "revoke_reference_access"
        ? Promise.reject(new Error("revoke failed"))
        : Promise.resolve({
            kind: "file_reference",
            entry: { path: "/tmp/qr.png", name: "qr.png", directory: false },
          }),
    );
    const loader = createExternalImageLoader("host", "proj", undefined);
    await expect(loader("/tmp/qr.png")).rejects.toThrow("读取超时");
  });
});
