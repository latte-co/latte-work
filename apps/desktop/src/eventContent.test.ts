// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "./protocol";
import { reassembleFullContent, streamEventContent } from "./eventContent";

function chunkResponse(
  chunk: string,
  total: number,
  next: number | null,
  encoding: "text" | "json" = "text",
): Response {
  return {
    kind: "event_content",
    encoding,
    chunk,
    total,
    next,
  } as Response;
}

describe("streamEventContent", () => {
  it("reassembles chunks in order and reports byte progress from the server cursor", async () => {
    const responses = [
      chunkResponse("第一段", 9, 6),
      chunkResponse("第二段", 9, null),
    ];
    const issue = vi.fn(async (_host: string, request: Request) => {
      expect(request.method).toBe("event_content");
      expect(request).toMatchObject({ session_id: "s1", seq: 7 });
      return responses.shift()!;
    });
    const seen: number[] = [];
    const result = await streamEventContent(
      { hostId: "h", sessionId: "s1", seq: 7 },
      ({ received }) => seen.push(received),
      issue as never,
    );
    expect(result).toEqual({ encoding: "text", content: "第一段第二段" });
    expect(seen).toEqual([6, 9]);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("rejects a cursor that does not strictly advance", async () => {
    const issue = vi.fn(async () => chunkResponse("片段", 9, 0));
    await expect(
      streamEventContent(
        { hostId: "h", sessionId: "s", seq: 1 },
        () => {},
        issue as never,
      ),
    ).rejects.toThrow("事件内容游标无效");
  });

  it("rejects a cursor beyond the declared total", async () => {
    const issue = vi.fn(async () => chunkResponse("片段", 3, 99));
    await expect(
      streamEventContent(
        { hostId: "h", sessionId: "s", seq: 1 },
        () => {},
        issue as never,
      ),
    ).rejects.toThrow("事件内容游标无效");
  });

  it("rejects mid-stream drift of encoding or total", async () => {
    let call = 0;
    const issue = vi.fn(async () =>
      call++ === 0 ? chunkResponse("a", 10, 1) : chunkResponse("b", 11, null),
    );
    await expect(
      streamEventContent(
        { hostId: "h", sessionId: "s", seq: 1 },
        () => {},
        issue as never,
      ),
    ).rejects.toThrow("事件内容在加载期间发生变化");
  });

  it("surfaces a clear error when the server predates event_content", async () => {
    const issue = vi.fn(
      async () => ({ kind: "error", code: "x", message: "y" }) as Response,
    );
    await expect(
      streamEventContent(
        { hostId: "h", sessionId: "s", seq: 1 },
        () => {},
        issue as never,
      ),
    ).rejects.toThrow("事件内容加载失败");
  });
});

describe("reassembleFullContent", () => {
  it("returns text payloads untouched", () => {
    expect(reassembleFullContent("text", "原文\n内容")).toBe("原文\n内容");
  });

  it("pretty-prints json payloads and rejects broken json", () => {
    expect(reassembleFullContent("json", '{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(() => reassembleFullContent("json", "{")).toThrow(
      "事件内容解析失败",
    );
  });
});
