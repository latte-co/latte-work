import { describe, expect, it } from "vitest";
import {
  pinnedSessions,
  sessionKey,
  loadConversation,
  conversationMarkdown,
} from "./sessionNavigation";
import type { Session, Event } from "./protocol";
const session = (id: string, pin: number | null = 1): Session => ({
  id,
  project_id: "p",
  title: id,
  agent: "claude",
  native_id: null,
  model: null,
  effort: null,
  status: "ready",
  created_at: 1,
  pinned_at: pin,
  custom_title: false,
  archived: false,
  unread: false,
});
const projects = ["local", "remote"].map((hostId) => ({
  hostId,
  id: "p",
  path: "/repo",
  name: "project",
}));
describe("global pinned conversations", () => {
  it("retains host identity for matching session ids and sorts by pin time", () => {
    const result = pinnedSessions(
      { local: [session("same", 2)], remote: [session("same", 3)] },
      projects,
      "local",
      [],
    );
    expect(result.map((s) => s.hostId)).toEqual(["remote", "local"]);
    expect(sessionKey("local", "same")).not.toBe(sessionKey("remote", "same"));
  });
  it("current rename/unpin/archive state overrides stale cached shortcuts without changing project rows", () => {
    const original = session("one");
    expect(
      pinnedSessions({ local: [original] }, projects, "local", [
        { ...original, title: "renamed", unread: true },
      ])[0],
    ).toMatchObject({ title: "renamed", unread: true, project_id: "p" });
    for (const current of [
      { ...original, pinned_at: null },
      { ...original, archived: true },
    ])
      expect(
        pinnedSessions({ local: [original] }, projects, "local", [current]),
      ).toEqual([]);
    expect(original.pinned_at).toBe(1);
    expect(pinnedSessions({ local: [original] }, [], "local", [])).toEqual([]);
  });
});
const event = (seq: number, text: string): Event => ({
  seq,
  session_id: "s",
  at: 1,
  event: { kind: "text", text },
});
describe("conversation copy", () => {
  it("reads through pagination before constructing Markdown", async () => {
    const cursors: number[] = [];
    const result = await loadConversation(async (after) => {
      cursors.push(after);
      return {
        kind: "events",
        session: session("s"),
        events: [event(after + 1, after === 0 ? "first " : "last")],
        has_more: after === 0,
      };
    });
    expect(cursors).toEqual([0, 1]);
    expect(conversationMarkdown("title", result)).toContain("first last");
  });
  it("fails instead of returning partial history for nonadvancing pages", async () => {
    await expect(
      loadConversation(async () => ({
        kind: "events",
        session: session("s"),
        events: [],
        has_more: true,
      })),
    ).rejects.toThrow("分页未前进");
  });
  it("excludes raw tool output while retaining both speakers", () => {
    const result = conversationMarkdown("title", [
      {
        ...event(1, ""),
        event: { kind: "user", text: "hello", request_id: "r" },
      },
      event(2, "answer"),
      {
        ...event(3, ""),
        event: {
          kind: "tool_result",
          id: "tool",
          content: "raw secret",
          is_error: false,
        },
      },
    ]);
    expect(result).toContain("## 用户\n\nhello");
    expect(result).toContain("## 助手\n\nanswer");
    expect(result).not.toContain("raw secret");
  });
});
