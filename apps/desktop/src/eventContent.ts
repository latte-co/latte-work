import { request } from "./api";
import type { ContentEncoding, Request, Response } from "./protocol";

export interface EventContentTarget {
  hostId: string;
  sessionId: string;
  seq: number;
}

export interface EventContentProgress {
  encoding: ContentEncoding;
  /** Concatenation of every chunk received so far. */
  accumulated: string;
  /** Bytes confirmed by the server cursor; exact progress against `total`. */
  received: number;
  total: number;
}

/**
 * Streams one stored event payload in server-bounded chunks. Byte offsets come
 * only from the server's `next` cursor — chunk string lengths are character
 * counts and never mix into byte arithmetic — with strict monotonicity so a
 * broken cursor cannot loop or stall the stream.
 */
export async function streamEventContent(
  target: EventContentTarget,
  onChunk: (progress: EventContentProgress) => void,
  issue: (hostId: string, request: Request) => Promise<Response> = request,
): Promise<{ encoding: ContentEncoding; content: string }> {
  const { hostId, sessionId, seq } = target;
  let offset = 0;
  let accumulated = "";
  let encoding: ContentEncoding | null = null;
  let total = -1;
  for (let guard = 0; ; guard += 1) {
    if (guard > 10_000) throw new Error("事件内容分块数量异常");
    const response = await issue(hostId, {
      method: "event_content",
      session_id: sessionId,
      seq,
      offset,
    });
    if (response.kind !== "event_content")
      throw new Error("事件内容加载失败，请更新服务端后重试");
    if (encoding == null) {
      encoding = response.encoding;
      total = response.total;
    } else if (response.encoding !== encoding || response.total !== total) {
      throw new Error("事件内容在加载期间发生变化，请重试");
    }
    accumulated += response.chunk;
    const next = response.next;
    if (next == null) {
      onChunk({ encoding, accumulated, received: total, total });
      return { encoding, content: accumulated };
    }
    if (next <= offset || next > total) throw new Error("事件内容游标无效");
    offset = next;
    onChunk({ encoding, accumulated, received: offset, total });
  }
}

/**
 * Renders streamed bytes back into the preview shape: `text` payloads display
 * as-is; `json` payloads pretty-print once parsed whole.
 */
export function reassembleFullContent(
  encoding: ContentEncoding,
  content: string,
): string {
  if (encoding === "text") return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    throw new Error("事件内容解析失败");
  }
}
