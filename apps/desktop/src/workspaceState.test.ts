// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  copyWorkspace,
  readWorkspace,
  updateWorkspace,
  workspaceKey,
} from "./workspaceState";
beforeEach(() => localStorage.clear());
it("persists layout, selection and file navigation across a fresh module load", async () => {
  const key = workspaceKey(crypto.randomUUID());
  updateWorkspace(key, {
    tabs: [{ id: "files", kind: "files", path: "src", file: "src/main.ts" }],
    current: "files",
    visible: false,
    expanded: true,
    width: 480,
  });
  vi.resetModules();
  const reloaded = await import("./workspaceState");
  expect(reloaded.readWorkspace(key)).toEqual(readWorkspace(key));
  expect(
    reloaded.readWorkspace(workspaceKey("different-conversation")).tabs,
  ).toEqual([]);
});
it("migrates draft state on first send while new drafts start empty", () => {
  const draft = workspaceKey(crypto.randomUUID());
  const session = workspaceKey(crypto.randomUUID());
  updateWorkspace(draft, {
    tabs: [{ id: "diff", kind: "diff" }],
    current: "diff",
    visible: false,
    width: 520,
  });
  copyWorkspace(draft, session);
  expect(readWorkspace(session)).toEqual(readWorkspace(draft));
  updateWorkspace(session, { tabs: [] });
  expect(readWorkspace(draft).tabs).toHaveLength(1);
  expect(readWorkspace(workspaceKey(crypto.randomUUID())).tabs).toEqual([]);
});
it("keeps each conversation's visibility and width independent", () => {
  const a = workspaceKey(crypto.randomUUID()),
    b = workspaceKey(crypto.randomUUID());
  updateWorkspace(a, { visible: false, width: 550, expanded: true });
  updateWorkspace(b, { visible: true, width: 300 });
  expect(readWorkspace(a)).toMatchObject({
    visible: false,
    width: 550,
    expanded: true,
  });
  expect(readWorkspace(b)).toMatchObject({
    visible: true,
    width: 300,
    expanded: false,
  });
});

it("preserves a conversation saved by the earlier preview without making host/project part of its new key", () => {
  const id = crypto.randomUUID();
  localStorage.setItem(
    "latte-work.conversation-workspace.v1:" +
      JSON.stringify(["host", "project", id]),
    JSON.stringify({
      tabs: [{ id: "files", kind: "files" }],
      current: "files",
      visible: false,
      width: 420,
    }),
  );
  expect(readWorkspace(id)).toMatchObject({
    current: "files",
    visible: false,
    width: 420,
  });
  expect(
    localStorage.getItem("latte-work.conversation-workspace.v1:" + id),
  ).not.toBeNull();
});
