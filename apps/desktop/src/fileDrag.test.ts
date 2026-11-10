import { describe, expect, it, vi } from "vitest";
import { dragHasFiles, preventFileNavigation } from "./fileDrag";

describe("dragHasFiles", () => {
  it("detects file drags advertised through types", () => {
    expect(dragHasFiles({ types: ["Files"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/plain", "Files"] })).toBe(true);
  });
  it("detects file drags carrying file objects or file items", () => {
    const files = { length: 1 } as ArrayLike<File>;
    expect(dragHasFiles({ types: [], files })).toBe(true);
    expect(dragHasFiles({ types: [], items: [{ kind: "file" }] })).toBe(true);
  });
  it("ignores text-only drags and absent payloads", () => {
    expect(
      dragHasFiles({ types: ["text/plain"], items: [{ kind: "string" }] }),
    ).toBe(false);
    expect(dragHasFiles({ types: [], files: [], items: [] })).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

describe("preventFileNavigation", () => {
  const event = (transfer: unknown) =>
    ({
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    }) as unknown as DragEvent;
  it("prevents default only for file drags", () => {
    const file = event({ types: ["Files"] });
    preventFileNavigation(file);
    expect(file.preventDefault).toHaveBeenCalledOnce();
    const text = event({ types: ["text/plain"] });
    preventFileNavigation(text);
    expect(text.preventDefault).not.toHaveBeenCalled();
  });
  it("tolerates a missing data transfer", () => {
    const empty = event(null);
    preventFileNavigation(empty);
    expect(empty.preventDefault).not.toHaveBeenCalled();
  });
});
