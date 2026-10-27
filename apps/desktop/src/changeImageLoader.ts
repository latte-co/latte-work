import { request } from "./api";
import type { ChangePreviewTarget } from "./protocol";
export interface ChangeImage {
  bytes: Uint8Array;
  mime: string;
}
export type ChangeImageLoader = (
  path: string,
  before: boolean,
  valid: () => boolean,
) => Promise<ChangeImage | null>;
export async function loadChangeImage(
  hostId: string,
  target: ChangePreviewTarget,
  path: string,
  before: boolean,
  valid: () => boolean,
): Promise<ChangeImage | null> {
  let offset = 0,
    size = -1,
    version = "",
    mime = "",
    hash: string | null = null;
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + 30000;
  while (valid()) {
    if (Date.now() > deadline) throw new Error("图片预览读取超时");
    const response = await request(hostId, {
      method: "preview_change",
      target,
      path,
      before,
      offset,
    });
    if (!valid()) throw new Error("图片预览已取消");
    if (response.kind !== "change_preview")
      throw new Error("Server 不支持变更图片预览，请更新后重试");
    const chunk = response.chunk;
    if (!chunk) {
      if (offset) throw new Error("此图片版本在读取期间消失，请刷新");
      return null;
    }
    if (
      !Number.isSafeInteger(chunk.size) ||
      chunk.size <= 0 ||
      chunk.size > 16 * 1024 * 1024 ||
      chunk.data.length > 65536 ||
      chunk.next !== offset + chunk.data.length ||
      chunk.next > chunk.size ||
      chunk.has_more !== chunk.next < chunk.size ||
      (chunk.has_more && !chunk.data.length) ||
      !/^(image\/(png|jpeg|gif|webp))$/.test(chunk.mime_type) ||
      !chunk.version ||
      (offset &&
        (size !== chunk.size ||
          version !== chunk.version ||
          mime !== chunk.mime_type ||
          hash !== chunk.sha256)) ||
      chunk.data.some(
        (byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
      )
    )
      throw new Error("图片版本已改变或内容无效，请刷新");
    size = chunk.size;
    version = chunk.version;
    mime = chunk.mime_type;
    hash = chunk.sha256;
    chunks.push(new Uint8Array(chunk.data));
    offset = chunk.next;
    if (!chunk.has_more) {
      const bytes = new Uint8Array(offset);
      let cursor = 0;
      for (const part of chunks) {
        bytes.set(part, cursor);
        cursor += part.length;
      }
      if (hash) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const actual = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (actual !== hash) throw new Error("快照图片校验失败，无法预览");
      }
      if (!valid()) throw new Error("图片预览已取消");
      return { bytes, mime };
    }
  }
  throw new Error("图片预览已取消");
}
