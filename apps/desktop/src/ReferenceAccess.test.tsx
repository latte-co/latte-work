// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithStatus as render } from "./test/renderWithStatus";
import { ReferenceAccess } from "./ReferenceAccess";
import { openArtifact, readWorkspace } from "./workspaceState";
import type { Request } from "./protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
const props = { hostId: "ssh", projectId: "p", active: true, connected: true };
const directory = {
  name: "review",
  path: "/canonical/skills/review",
  directory: true,
};
let entries = [directory];
beforeEach(() => {
  entries = [directory];
  mocks.request
    .mockReset()
    .mockImplementation(async (_host: string, req: Request) => {
      if (req.method === "reference_access")
        return {
          kind: "reference_access",
          entries: [...entries],
          truncated: false,
        };
      if (req.method === "revoke_reference_access") {
        entries = entries.filter((entry) => entry.path !== req.path);
        return { kind: "ok" };
      }
      throw new Error("unexpected request");
    });
});
afterEach(cleanup);
async function expand() {
  const summary = screen.getByText("项目外预览权限");
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByText("review");
}

it("loads canonical retained scopes only on demand and revokes across loaded conversations", async () => {
  const project = { id: "p", name: "Project", path: "/project" };
  const same = crypto.randomUUID(),
    another = crypto.randomUUID(),
    otherHost = crypto.randomUUID(),
    otherProject = crypto.randomUUID(),
    sibling = crypto.randomUUID();
  openArtifact(
    same,
    directory,
    { hostId: "ssh", project },
    `${directory.path}/SKILL.md`,
  );
  openArtifact(
    another,
    { name: "note.md", path: `${directory.path}/note.md`, directory: false },
    { hostId: "ssh", project },
  );
  openArtifact(otherHost, directory, { hostId: "local", project });
  openArtifact(otherProject, directory, {
    hostId: "ssh",
    project: { ...project, id: "q" },
  });
  openArtifact(
    sibling,
    { ...directory, path: `${directory.path}-sibling` },
    { hostId: "ssh", project },
  );
  render(<ReferenceAccess {...props} />);
  expect(mocks.request).not.toHaveBeenCalled();
  await expand();
  expect(screen.getByText(`目录及其子文件 · ${directory.path}`)).toBeTruthy();
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("ssh", {
    method: "reference_access",
    project_id: "p",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "撤销 review 的预览权限" }),
  );
  await screen.findByText("暂无保留的预览权限");
  expect(mocks.request).toHaveBeenCalledWith("ssh", {
    method: "revoke_reference_access",
    project_id: "p",
    path: directory.path,
  });
  expect(readWorkspace(same).tabs).toEqual([]);
  expect(readWorkspace(another).tabs).toEqual([]);
  for (const key of [otherHost, otherProject, sibling])
    expect(readWorkspace(key).tabs).toHaveLength(1);
});

it("keeps previews and a retryable error if the Server rejects revocation", async () => {
  const key = crypto.randomUUID();
  openArtifact(key, directory, {
    hostId: "ssh",
    project: { id: "p", name: "Project", path: "/project" },
  });
  render(<ReferenceAccess {...props} />);
  await expand();
  mocks.request.mockRejectedValueOnce(new Error("fixture unavailable"));
  fireEvent.click(
    screen.getByRole("button", { name: "撤销 review 的预览权限" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "撤销 review 的预览权限" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(readWorkspace(key).tabs).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /状态提示/ }));
  expect(await screen.findByText("Error: fixture unavailable")).toBeTruthy();
});

it("discards a late list from the previous project and disables disconnected revocation", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<ReferenceAccess {...props} />);
  const details = screen.getByText("项目外预览权限").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
  view.rerender(<ReferenceAccess {...props} projectId="q" />);
  await screen.findByText("review");
  await act(async () =>
    resolve({
      kind: "reference_access",
      entries: [{ name: "old-project", path: "/old", directory: false }],
      truncated: false,
    }),
  );
  expect(screen.queryByText("old-project")).toBeNull();
  view.rerender(<ReferenceAccess {...props} projectId="q" connected={false} />);
  expect(screen.getByText("连接后可更新权限")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "撤销 review 的预览权限" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
