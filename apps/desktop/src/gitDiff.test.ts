import { expect, it } from "vitest";
import { parseDiff, splitDiff } from "./gitDiff";
it("tracks real old/new hunk positions across replacements and unmatched insertions", () => {
  const result = parseDiff(
    "--- a/file\n+++ b/file\n@@ -10,3 +20,4 @@\n same\n-old\n+new\n+extra\n tail\n@@ -90 +100 @@\n-next old\n+next new\n\\ No newline at end of file\n",
  );
  expect(
    result.lines
      .filter((line) => line.kind === "removed")
      .map((line) => line.old),
  ).toEqual([11, 90]);
  expect(
    result.lines
      .filter((line) => line.kind === "added")
      .map((line) => line.next),
  ).toEqual([21, 22, 100]);
  const rows = splitDiff(result.lines);
  expect(rows.find((row) => row.left?.text === "old")).toMatchObject({
    left: { old: 11 },
    right: { next: 21 },
  });
  expect(rows.find((row) => row.right?.text === "extra")?.left).toBeUndefined();
  expect(rows.find((row) => row.right?.text === "tail")?.right?.next).toBe(23);
});
it("treats patch headers, binary changes and missing newline markers as metadata and bounds rendering", () => {
  expect(parseDiff("Binary files a/x and b/x differ\n").lines[0].kind).toBe(
    "meta",
  );
  const result = parseDiff("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n", 2);
  expect(result.truncated).toBe(true);
  expect(result.lines).toHaveLength(2);
});
