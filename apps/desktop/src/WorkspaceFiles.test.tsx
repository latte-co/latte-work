// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
function Harness({ tab }: { tab: "files" | "diff" }) {
  const [location, setLocation] = useState({ path: "", file: "" });
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
it("groups changes and preserves the file list after a failed preview", async () => {
  mocks.request.mockImplementation(async (_host, r) => {
    if (r.method === "change_diff") throw new Error("文件已移走");
    return {
      kind: "changes",
      entries: [
        {
          path: "file.txt",
          previous_path: null,
          status: "M",
          section: "staged",
        },
        {
          path: "new.txt",
          previous_path: null,
          status: "?",
          section: "untracked",
        },
      ],
      truncated: false,
    };
  });
  render(<Harness tab="diff" />);
  fireEvent.click(await screen.findByRole("button", { name: /file.txt/ }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("文件已移走"),
  );
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "change_diff",
    project_id: "p",
    path: "file.txt",
    section: "staged",
  });
  fireEvent.click(screen.getByRole("button", { name: "返回改动列表" }));
  expect(await screen.findByRole("button", { name: /new.txt/ })).toBeTruthy();
});
it("does not report a clean worktree when the server cannot enumerate changes", async () => {
  mocks.request.mockRejectedValue(new Error("不支持 changes"));
  render(<Harness tab="diff" />);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("不支持"),
  );
  expect(screen.queryByText(/工作区干净/)).toBeNull();
});
