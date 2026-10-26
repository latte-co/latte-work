import { request } from "./api";
import type { SkillImportFile } from "./protocol";

export type SkillFile = { path: string; file: File };
export type SkillUpload = { name: string; files: SkillFile[] };
export const SKILL_MAX_BYTES = 16 * 1024 * 1024;
export function readSkillBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("无法读取所选技能文件"));
    reader.readAsArrayBuffer(blob);
  });
}
export function validateSkillFiles(files: SkillFile[]) {
  if (!files.length || files.length > 512)
    throw new Error("请选择一个技能，最多 512 项");
  let bytes = 0;
  const paths = new Set<string>();
  const directories = new Set<string>();
  for (const { path, file } of files) {
    const parts = path.split("/");
    if (
      new TextEncoder().encode(path).length > 1024 ||
      parts.length > 9 ||
      parts.some(
        (p) =>
          !p ||
          new TextEncoder().encode(p).length > 255 ||
          p === "." ||
          p === ".." ||
          /[\\\x00-\x1f\x7f]/.test(p),
      ) ||
      paths.has(path)
    )
      throw new Error("技能文件路径无效、重复或超过 8 层");
    paths.add(path);
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join("/"));
    bytes += file.size;
    if (bytes > SKILL_MAX_BYTES || (path === "SKILL.md" && file.size > 65536))
      throw new Error("技能最多 16 MiB，SKILL.md 最多 64 KiB");
  }
  if (!paths.has("SKILL.md"))
    throw new Error("请选择 SKILL.md 或包含它的技能文件夹");
  if (
    paths.size + directories.size > 512 ||
    [...directories].some((p) => paths.has(p))
  )
    throw new Error("技能最多 512 项，文件和目录不能重名");
}
export async function selectedSkillFiles(files: File[]): Promise<SkillUpload> {
  const root = files[0]?.webkitRelativePath?.split("/")[0];
  const selected = files.map((file) => {
    const relative = file.webkitRelativePath;
    if (root && (!relative || relative.split("/")[0] !== root))
      throw new Error("一次只能导入一个技能文件夹");
    return { path: root ? relative.slice(root.length + 1) : file.name, file };
  });
  return prepareSkill(selected, root);
}
async function prepareSkill(
  files: SkillFile[],
  root?: string,
): Promise<SkillUpload> {
  validateSkillFiles(files);
  const bytes = await readSkillBytes(
    files.find((f) => f.path === "SKILL.md")!.file,
  );
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("SKILL.md 必须使用 UTF-8 编码，请转换编码后重新选择");
  }
  const declared = /^---\r?\n[\s\S]*?^name:\s*["']?([^\r\n"']+)/m
    .exec(body)?.[1]
    ?.trim();
  const name =
    (root || declared || "my-skill")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 128) || "my-skill";
  return { name, files };
}
// Read entries synchronously from the drop event; WebKit may clear DataTransfer later.
export async function droppedSkillFiles(
  transfer: DataTransfer,
): Promise<SkillUpload> {
  const roots = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.());
  if (!roots.some((entry) => entry?.isDirectory))
    return selectedSkillFiles(Array.from(transfer.files));
  if (roots.length !== 1 || !roots[0]?.isDirectory)
    throw new Error("一次只能导入一个技能文件夹");
  const files: SkillFile[] = [];
  let entries = 0;
  async function walk(
    entry: FileSystemEntry,
    path: string,
    depth: number,
  ): Promise<void> {
    if (++entries > 513 || depth > 9)
      throw new Error("技能最多 512 项、8 层目录");
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push({ path, file });
      // Bound collection before reading content or continuing a large directory.
      if (
        files.reduce((total, item) => total + item.file.size, 0) >
        SKILL_MAX_BYTES
      )
        throw new Error("技能最多 16 MiB");
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch)
          await walk(
            child,
            path ? `${path}/${child.name}` : child.name,
            depth + 1,
          );
      }
    } else throw new Error("技能包含不支持的文件类型");
  }
  await walk(roots[0], "", 0);
  return prepareSkill(files, roots[0].name);
}
export async function uploadSkill(
  hostId: string,
  upload: SkillUpload,
  valid: () => boolean,
) {
  validateSkillFiles(upload.files);
  const files: SkillImportFile[] = [];
  const check = () => {
    if (!valid()) throw new Error("技能导入已取消");
  };
  for (const item of upload.files) {
    check();
    const start = await request(hostId, {
      method: "begin_attachment",
      name: "skill-file",
      size: item.file.size,
    });
    if (start.kind !== "attachment_upload")
      throw new Error("主机不支持文件上传，请更新 Server");
    try {
      for (let offset = 0; offset < item.file.size; offset += 65536) {
        check();
        const data = Array.from(
          await readSkillBytes(item.file.slice(offset, offset + 65536)),
        );
        check();
        await request(hostId, {
          method: "attachment_chunk",
          id: start.id,
          offset,
          data,
        });
      }
      check();
      const result = await request(hostId, {
        method: "finish_attachment",
        id: start.id,
      });
      if (result.kind !== "file_reference")
        throw new Error("技能文件上传结果待核对，请重新选择");
      files.push({ path: item.path, attachment: result.entry.path });
    } catch (cause) {
      await request(hostId, { method: "abort_attachment", id: start.id }).catch(
        () => {},
      );
      throw cause;
    }
  }
  check();
  return request(hostId, {
    method: "import_skill_files",
    name: upload.name,
    files,
  });
}
