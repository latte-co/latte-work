import { invoke } from "@tauri-apps/api/core";
import { request } from "./api";
import type { FileEntry } from "./protocol";
export interface SourceData {
  bytes: Uint8Array;
  mime: string;
  size: number;
  truncated: boolean;
  directory?: FileEntry[];
}
export async function loadSource(
  hostId: string,
  projectId: string,
  sessionId: string | undefined,
  path: string,
  valid: () => boolean,
  full = false,
): Promise<SourceData> {
  const chunks: Uint8Array[] = [];
  let offset = 0,
    mime = "",
    size = 0;
  const deadline = Date.now() + 30000;
  while (valid()) {
    if (Date.now() > deadline) throw new Error("来源预览读取超时");
    const response = await request(hostId, {
      method: "preview_source",
      project_id: projectId,
      session_id: sessionId ?? null,
      path,
      offset,
    });
    if (!valid()) throw new Error("来源预览已取消");
    if (response.kind === "source_directory")
      return {
        bytes: new Uint8Array(),
        mime: "inode/directory",
        size: 0,
        truncated: response.truncated,
        directory: response.entries,
      };
    if (response.kind !== "source_preview")
      throw new Error("Server 不支持来源预览，请更新后重试");
    if (
      response.data.length > 65536 ||
      !Number.isSafeInteger(response.size) ||
      response.size < 0 ||
      response.next > response.size ||
      response.next !== offset + response.data.length ||
      (response.has_more && !response.data.length) ||
      (offset && (response.mime_type !== mime || response.size !== size))
    )
      throw new Error("来源文件在读取期间发生变化，请刷新");
    mime = response.mime_type;
    size = response.size;
    const media = /^(image\/|video\/|application\/pdf$)/.test(mime);
    const limit = full
      ? 32 * 1024 * 1024
      : media
        ? 16 * 1024 * 1024
        : mime === "text/plain"
          ? 512 * 1024
          : 65536;
    if ((full || media) && size > limit)
      throw new Error(`来源超过 ${limit / 1024 / 1024} MiB 预览上限`);
    if (response.next > limit) throw new Error("来源预览超出读取上限");
    chunks.push(new Uint8Array(response.data));
    offset = response.next;
    if (!response.has_more || offset >= limit) {
      const bytes = new Uint8Array(offset);
      let cursor = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, cursor);
        cursor += chunk.length;
      }
      return { bytes, mime, size, truncated: response.has_more };
    }
  }
  throw new Error("来源预览已取消");
}
export function systemPreview(name: string, bytes: Uint8Array) {
  return invoke("system_preview", { name, data: Array.from(bytes) });
}

export function previewPdf(name: string, bytes: Uint8Array) {
  return invoke<number[]>("preview_pdf", { name, data: Array.from(bytes) });
}
