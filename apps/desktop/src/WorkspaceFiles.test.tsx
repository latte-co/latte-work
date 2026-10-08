// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { WorkspaceFiles } from "./WorkspaceFiles";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function Harness({ tab, file = "" }: { tab: "files" | "diff"; file?: string }) {
  const [location, setLocation] = useState({ path: "", file });
  return (
    <WorkspaceFiles
      hostId="local"
      project={{ id: "p", name: "Project", path: "/project" }}
      active
      tab={tab}
      {...location}
      navigate={(next) => setLocation({ ...location, ...next })}
    />
  );
}
it("keeps navigation usable while a binary preview fails", async () => {
  mocks.request.mockImplementation(async (_host, r) => {
    if (r.method === "read_file") throw new Error("仅预览文本文件");
    return {
      kind: "files",
      entries: [{ name: "binary", path: "binary", directory: false }],
    };
  });
  render(<Harness tab="files" />);
  fireEvent.click(await screen.findByRole("button", { name: "binary" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("仅预览文本"),
  );
  fireEvent.click(screen.getByRole("button", { name: "返回目录" }));
  expect(await screen.findByRole("button", { name: "binary" })).toBeTruthy();
});
it("switches files from the tree and keeps the preview when the tree is hidden", async () => {
  mocks.request.mockImplementation(async (_host, r) => {
    if (r.method === "read_file")
      return { kind: "content", text: `Content of ${r.path}`, truncated: true };
    return {
      kind: "files",
      entries: [
        { name: "README.md", path: "README.md", directory: false },
        { name: "notes.txt", path: "notes.txt", directory: false },
      ],
    };
  });
  render(<Harness tab="files" file="README.md" />);
  const tree = screen.getByRole("navigation", { name: "项目文件树" });
  const selected = await within(tree).findByRole("button", {
    name: "README.md",
  });
  expect(selected.getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText(/只读预览/)).toBeNull();
  expect(await screen.findByText("内容已截断")).toBeTruthy();
  fireEvent.click(within(tree).getByRole("button", { name: "notes.txt" }));
  expect(await screen.findByText("Content of notes.txt")).toBeTruthy();
  expect(
    within(tree)
      .getByRole("button", { name: "notes.txt" })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "隐藏文件树" }));
  expect(screen.queryByRole("navigation", { name: "项目文件树" })).toBeNull();
  expect(screen.getByText("Content of notes.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "显示文件树" }));
  expect(
    await within(tree).findByRole("button", { name: "notes.txt" }),
  ).toBeTruthy();
});
it("expands the selected file's ancestors and reads other folders only when opened", async () => {
  mocks.request.mockImplementation(async (_host, r) => {
    if (r.method === "read_file")
      return {
        kind: "content",
        text: `Content of ${r.path}`,
        truncated: false,
      };
    return {
      kind: "files",
      entries:
        r.path === ""
          ? [
              { name: "src", path: "src", directory: true },
              { name: "docs", path: "docs", directory: true },
            ]
          : [
              {
                name: "index.ts",
                path: `${r.path}/index.ts`,
                directory: false,
              },
            ],
    };
  });
  render(<Harness tab="files" file="src/index.ts" />);
  const tree = screen.getByRole("navigation", { name: "项目文件树" });
  expect(
    (
      await within(tree).findByRole("button", { name: "index.ts" })
    ).getAttribute("aria-current"),
  ).toBe("page");
  expect(mocks.request).not.toHaveBeenCalledWith("local", {
    method: "files",
    project_id: "p",
    path: "docs",
  });
  fireEvent.click(within(tree).getByRole("button", { name: "docs" }));
  await waitFor(() =>
    expect(
      within(tree).getAllByRole("button", { name: "index.ts" }),
    ).toHaveLength(2),
  );
  fireEvent.click(screen.getByRole("button", { name: "隐藏文件树" }));
  fireEvent.click(screen.getByRole("button", { name: "显示文件树" }));
  await waitFor(() =>
    expect(within(tree).queryAllByRole("status")).toHaveLength(0),
  );
  expect(
    within(tree)
      .getByRole("button", { name: "docs" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(within(tree).getAllByRole("button", { name: "index.ts" })[1]);
  expect(await screen.findByText("Content of docs/index.ts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回目录" }));
  expect(await screen.findByRole("button", { name: "index.ts" })).toBeTruthy();
  expect(mocks.request).toHaveBeenLastCalledWith("local", {
    method: "files",
    project_id: "p",
    path: "docs",
  });
});
it("retries a failed tree independently of the open file and refreshes both", async () => {
  let fail = true;
  mocks.request.mockImplementation(async (_host, r) => {
    if (r.method === "read_file")
      return { kind: "content", text: "Preview remains", truncated: false };
    if (fail) throw new Error("目录不可访问");
    return {
      kind: "files",
      entries: [{ name: "README.md", path: "README.md", directory: false }],
    };
  });
  render(<Harness tab="files" file="README.md" />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "目录不可访问",
  );
  expect(await screen.findByText("Preview remains")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await within(screen.getByRole("navigation")).findByRole("button", {
    name: "README.md",
  });
  mocks.request.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith("local", {
      method: "read_file",
      project_id: "p",
      path: "README.md",
    }),
  );
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "files",
    project_id: "p",
    path: "",
  });
});
it("keeps the Git file list available after a failed diff preview", async () => {
  mocks.request.mockImplementation(async (_host, r) => {
    if (r.method === "git_info")
      return {
        kind: "git_info",
        info: {
          branch: "main",
          head: "a".repeat(40),
          default_base: "HEAD",
          refs: [],
          truncated: false,
        },
      };
    if (r.method === "git_review_diff") throw new Error("文件已移走");
    return {
      kind: "git_review",
      review: {
        base: "a".repeat(40),
        head: "a".repeat(40),
        added: 2,
        removed: 1,
        truncated: false,
        entries: [
          {
            path: "file.txt",
            previous_path: null,
            status: "M",
            added: 1,
            removed: 1,
            binary: false,
            untracked: false,
          },
          {
            path: "new.txt",
            previous_path: null,
            status: "A",
            added: 1,
            removed: 0,
            binary: false,
            untracked: false,
          },
        ],
      },
    };
  });
  render(<Harness tab="diff" />);
  await screen.findByRole("button", { name: /file.txt/ });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "文件已移走",
  );
  expect(mocks.request).toHaveBeenCalledWith(
    "local",
    expect.objectContaining({
      method: "git_review_diff",
      project_id: "p",
      path: "file.txt",
      scope: "branch",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /new.txt/ }));
  expect(screen.getByRole("button", { name: /file.txt/ })).toBeTruthy();
  await waitFor(() =>
    expect(mocks.request).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({ path: "new.txt" }),
    ),
  );
});
it("does not report a clean worktree when the server cannot enumerate changes", async () => {
  mocks.request.mockRejectedValue(new Error("不支持 changes"));
  render(<Harness tab="diff" />);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("不支持"),
  );
  expect(screen.queryByText(/工作区干净/)).toBeNull();
});
