import { describe, expect, it } from "vitest";
import { sessionAfterRefresh } from "./sessionSelection";

describe("unsaved conversation selection", () => {
  it("keeps a new draft empty when polling returns saved sessions or an old pending selection", () => {
    expect(sessionAfterRefresh("", null, true)).toBe("");
    expect(sessionAfterRefresh("recent", "archived", true)).toBe("");
  });
  it("preserves a newly submitted session even before it appears in a refresh", () => {
    expect(sessionAfterRefresh("just-created", null, false)).toBe(
      "just-created",
    );
  });
  it("opens explicit selections and keeps an unselected view empty", () => {
    expect(sessionAfterRefresh("recent", "archived", false)).toBe("archived");
    expect(sessionAfterRefresh("", null, false)).toBe("");
  });
});
