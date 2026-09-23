import { describe, expect, it } from "vitest";
import type { Session } from "./protocol";
import { sessionAfterRefresh } from "./sessionSelection";

const sessions = [
  { id: "archived", archived: true },
  { id: "recent", archived: false },
] as Session[];

describe("unsaved conversation selection", () => {
  it("keeps a new draft empty when polling returns saved sessions or an old pending selection", () => {
    expect(sessionAfterRefresh("", null, sessions, true)).toBe("");
    expect(sessionAfterRefresh("recent", "archived", sessions, true)).toBe("");
  });
  it("preserves a newly submitted session even before it appears in a refresh", () => {
    expect(sessionAfterRefresh("just-created", null, sessions, false)).toBe(
      "just-created",
    );
  });
  it("still opens explicit selections and chooses an unarchived session on initial load", () => {
    expect(sessionAfterRefresh("recent", "archived", sessions, false)).toBe(
      "archived",
    );
    expect(sessionAfterRefresh("", null, sessions, false)).toBe("recent");
    expect(sessionAfterRefresh("", null, [], false)).toBe("");
  });
});
