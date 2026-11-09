// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createExternalImageLoader } from "./externalImageLoader";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
}));
vi.mock("./sourceLoader", () => ({ loadSource: mocks.load }));

beforeEach(() => {
  mocks.load.mockReset().mockResolvedValue({
    bytes: new Uint8Array([137, 80, 78, 71]),
    mime: "image/png",
    size: 4,
    truncated: false,
  });
});
afterEach(() => vi.clearAllMocks());

describe("createExternalImageLoader", () => {
  it("reads through the display-only message-image channel with cancellation", async () => {
    const loader = createExternalImageLoader("host", "proj");
    const valid = () => true;
    await loader("/tmp/qr.png", valid);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    const [hostId, projectId, sessionId, path, forwarded, full, method] =
      mocks.load.mock.calls[0];
    expect(hostId).toBe("host");
    expect(projectId).toBe("proj");
    // The display-only request carries no session binding and no reference
    // grant round-trip; the method argument selects the message-image read.
    expect(sessionId).toBeUndefined();
    expect(path).toBe("/tmp/qr.png");
    expect(forwarded).toBe(valid);
    expect(method).toBe("preview_message_image");
    expect(full).toBe(false);
  });

  it("forwards the live cancellation flag even when it has flipped", async () => {
    const loader = createExternalImageLoader("host", "proj");
    let cancelled = false;
    const valid = () => !cancelled;
    const pending = loader("/tmp/qr.png", valid);
    cancelled = true;
    await pending;
    expect(mocks.load.mock.calls[0][4]).toBe(valid);
  });
});
