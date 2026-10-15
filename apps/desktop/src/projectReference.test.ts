import { expect, it } from "vitest";
import { projectReference } from "./projectReference";
it("labels normalized outside paths without confusing sibling prefixes with project membership", () => {
  expect(projectReference("/work/project", "../secret.md")).toEqual({
    path: "/work/secret.md",
    outside: true,
  });
  expect(
    projectReference("/work/project", "/work/project-other/a.md").outside,
  ).toBe(true);
  expect(projectReference("/work/project", "docs/../report.md").outside).toBe(
    false,
  );
  expect(projectReference("/", "/report.md").outside).toBe(false);
});
