// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  droppedSkillFiles,
  selectedSkillFiles,
  uploadSkill,
  validateSkillFiles,
} from "./skillImport";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request }));
const skill = () =>
  new File(["---\nname: example\n---\nSafe body"], "SKILL.md");
afterEach(() => vi.resetAllMocks());
it("explains invalid UTF-8 without uploading selected content", async () => {
  await expect(
    selectedSkillFiles([new File([new Uint8Array([0xff])], "SKILL.md")]),
  ).rejects.toThrow("SKILL.md 必须使用 UTF-8 编码");
  expect(request).not.toHaveBeenCalled();
});
it("collects a selected directory with complete resource paths", async () => {
  const files = [skill(), new File(["resource"], "note.txt")];
  Object.defineProperty(files[0], "webkitRelativePath", {
    value: "demo/SKILL.md",
  });
  Object.defineProperty(files[1], "webkitRelativePath", {
    value: "demo/references/note.txt",
  });
  const upload = await selectedSkillFiles(files);
  expect(upload.name).toBe("demo");
  expect(upload.files.map((item) => item.path)).toEqual([
    "SKILL.md",
    "references/note.txt",
  ]);
});
it("reads every directory-entry batch after a drop", async () => {
  const file = skill();
  const resource = new File(["resource"], "resource.txt");
  const entry = (file: File) => ({
    isFile: true,
    name: file.name,
    file: (resolve: (file: File) => void) => resolve(file),
  });
  const readEntries = vi
    .fn()
    .mockImplementationOnce((resolve) => resolve([entry(file)]))
    .mockImplementationOnce((resolve) => resolve([entry(resource)]))
    .mockImplementation((resolve) => resolve([]));
  const transfer = {
    items: [
      {
        kind: "file",
        webkitGetAsEntry: () => ({
          isDirectory: true,
          name: "demo",
          createReader: () => ({ readEntries }),
        }),
      },
    ],
  } as unknown as DataTransfer;
  const upload = await droppedSkillFiles(transfer);
  expect(upload.files.map((item) => item.path)).toEqual([
    "SKILL.md",
    "resource.txt",
  ]);
  expect(readEntries).toHaveBeenCalledTimes(3);
});
it("rejects invalid and excessive packages before uploading", async () => {
  await expect(
    selectedSkillFiles([new File(["body"], "README.md")]),
  ).rejects.toThrow("SKILL.md");
  for (const path of [
    "../escape",
    "/escape",
    "a/../bad",
    "a\\bad",
    "a//bad",
    "SKILL.md",
  ]) {
    expect(() =>
      validateSkillFiles([
        { path: "SKILL.md", file: skill() },
        { path, file: new File(["x"], "x") },
      ]),
    ).toThrow();
  }
  const large = new File(["x"], "large");
  Object.defineProperty(large, "size", { value: 16 * 1024 * 1024 + 1 });
  expect(() =>
    validateSkillFiles([
      { path: "SKILL.md", file: skill() },
      { path: "large", file: large },
    ]),
  ).toThrow("16 MiB");
  const many = Array.from({ length: 256 }, (_, i) => ({
    path: `dir-${i}/item`,
    file: new File([], "item"),
  }));
  expect(() =>
    validateSkillFiles([{ path: "SKILL.md", file: skill() }, ...many]),
  ).toThrow("512");
  expect(request).not.toHaveBeenCalled();
});
it("transfers bytes only to the selected host, then imports once", async () => {
  const upload = await selectedSkillFiles([skill()]);
  request.mockImplementation(async (_host, action) =>
    action.method === "begin_attachment"
      ? { kind: "attachment_upload", id: "id" }
      : action.method === "finish_attachment"
        ? { kind: "file_reference", entry: { path: "/remote/paste-tmp/file" } }
        : action.method === "import_skill_files"
          ? { kind: "skills", skills: [] }
          : { kind: "ok" },
  );
  await uploadSkill("devbox", upload, () => true);
  expect(request.mock.calls.every(([host]) => host === "devbox")).toBe(true);
  expect(request).toHaveBeenLastCalledWith("devbox", {
    method: "import_skill_files",
    name: "example",
    files: [{ path: "SKILL.md", attachment: "/remote/paste-tmp/file" }],
  });
  const chunk = request.mock.calls.find(
    ([, action]) => action.method === "attachment_chunk",
  )![1];
  expect(new TextDecoder().decode(new Uint8Array(chunk.data))).toContain(
    "Safe body",
  );
});
it("aborts an incomplete upload when its host context becomes stale and never installs", async () => {
  const upload = await selectedSkillFiles([skill()]);
  let valid = true;
  request.mockImplementation(async (_host, action) => {
    if (action.method === "begin_attachment") {
      valid = false;
      return { kind: "attachment_upload", id: "old" };
    }
    return { kind: "ok" };
  });
  await expect(uploadSkill("local", upload, () => valid)).rejects.toThrow(
    "取消",
  );
  expect(request).toHaveBeenLastCalledWith("local", {
    method: "abort_attachment",
    id: "old",
  });
  expect(
    request.mock.calls.some(
      ([, action]) => action.method === "import_skill_files",
    ),
  ).toBe(false);
});
