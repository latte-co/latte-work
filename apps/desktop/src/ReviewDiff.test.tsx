// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ReviewDiff } from "./ReviewDiff";
afterEach(cleanup);
it("shows the code hunk and EOF marker without repeating raw file headers", () => {
  render(
    <ReviewDiff
      split={false}
      content={
        "diff --git a/x b/x\nindex abc..def\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n"
      }
    />,
  );
  expect(screen.queryByText(/diff --git/)).toBeNull();
  expect(screen.getByText(/No newline/)).toBeTruthy();
  expect(screen.getByText("+new")).toBeTruthy();
});
it("keeps metadata visible for binary or permission-only diffs", () => {
  render(
    <ReviewDiff
      split
      content={
        "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n@@ -1 +1 @@\n-old\n+new\n"
      }
    />,
  );
  expect(screen.getByText("new mode 100755")).toBeTruthy();
});
