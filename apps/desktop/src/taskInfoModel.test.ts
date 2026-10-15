import { expect, it } from "vitest";
import type { Event, EventKind } from "./protocol";
import { artifactPath, taskInfo } from "./taskInfoModel";
const events = (...items: EventKind[]): Event[] =>
  items.map((event, i) => ({ seq: i + 1, session_id: "s", at: i, event }));
it("uses successful todo results, replaces snapshots, and ignores rejected or duplicated calls", () => {
  const history = events(
    {
      kind: "tool",
      id: "a",
      name: "TodoWrite",
      input: { todos: [{ content: "Implement", status: "pending" }] },
    },
    { kind: "tool_result", id: "a", content: "ok", is_error: false },
    {
      kind: "tool",
      id: "b",
      name: "TodoWrite",
      input: { todos: [{ content: "Wrong", status: "completed" }] },
    },
    { kind: "tool_result", id: "b", content: "denied", is_error: true },
    {
      kind: "tool",
      id: "c",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Implement", status: "completed" },
          { content: "Verify", status: "in_progress" },
        ],
      },
    },
  );
  expect(taskInfo(history, "s").todos.map((item) => item.title)).toEqual([
    "Implement",
  ]);
  history.push(
    ...events({
      kind: "tool_result",
      id: "c",
      content: "ok",
      is_error: false,
    }).map((e) => ({ ...e, seq: 6 })),
  );
  expect(taskInfo([...history, history[0]], "s")).toMatchObject({
    todos: [
      { title: "Implement", status: "completed" },
      { title: "Verify", status: "in_progress" },
    ],
    tools: [["TodoWrite", 3]],
  });
});
it("links task creation IDs to confirmed updates and deletion", () => {
  const history = events(
    { kind: "tool", id: "1", name: "TaskCreate", input: { subject: "Review" } },
    {
      kind: "tool_result",
      id: "1",
      content: [{ type: "text", text: "Task #7 created successfully: Review" }],
      is_error: false,
    },
    {
      kind: "tool",
      id: "2",
      name: "TaskUpdate",
      input: { taskId: "7", status: "completed" },
    },
    { kind: "tool_result", id: "2", content: "ok", is_error: false },
  );
  expect(taskInfo(history, "s").todos).toEqual([
    { id: "7", title: "Review", status: "completed" },
  ]);
  history.push(
    ...events(
      {
        kind: "tool",
        id: "3",
        name: "TaskUpdate",
        input: { taskId: "7", status: "deleted" },
      },
      { kind: "tool_result", id: "3", content: "ok", is_error: false },
    ).map((e) => ({ ...e, seq: e.seq + 4 })),
  );
  expect(taskInfo(history, "s").todos).toEqual([]);
});
it("assembles streaming links, collects explicit outputs, and excludes code examples and unsafe URLs", () => {
  const history = events(
    {
      kind: "user",
      request_id: "r",
      text: "See https://example.com/docs. [Input](/project/input.txt)",
    },
    { kind: "text", text: "[Guide](https://example.com/" },
    {
      kind: "text",
      text: "guide) [Report](</project/My Report.md:12>)\n```sh\nhttps://example.com/example\n```\nhttps://user:secret@example.com/private",
    },
    {
      kind: "tool",
      id: "w",
      name: "Write",
      input: { file_path: "/project/output.md" },
    },
    { kind: "tool_result", id: "w", content: "ok", is_error: false },
    {
      kind: "tool",
      id: "bad",
      name: "Write",
      input: { file_path: "/project/failed.md" },
    },
    { kind: "tool_result", id: "bad", content: "no", is_error: true },
    {
      kind: "tool",
      id: "sk",
      name: "Skill",
      input: { skill: "review-code-changes" },
    },
  );
  const data = taskInfo(
    [
      ...history,
      {
        ...history[0],
        seq: 99,
        session_id: "other",
        event: { kind: "text", text: "https://wrong.example" },
      },
    ],
    "s",
  );
  expect(data.links).toEqual([
    { url: "https://example.com/docs", title: "https://example.com/docs" },
    { url: "https://example.com/guide", title: "Guide" },
  ]);
  expect(data.files.map((file) => file.path)).toEqual([
    "/project/input.txt",
    "/project/My Report.md",
    "/project/output.md",
  ]);
  expect(data.skills).toEqual([["review-code-changes", 1]]);
  expect(taskInfo(history, "other").files).toEqual([]);
});
it("normalizes line references and bounds inventories", () => {
  expect(artifactPath("/project/main.ts:12:3")).toBe("/project/main.ts");
  expect(artifactPath("javascript:alert(1)")).toBeNull();
  expect(artifactPath("//example.com/path")).toBeNull();
  const data = taskInfo(
    events({
      kind: "text",
      text: Array.from(
        { length: 130 },
        (_, i) => `https://example.com/${i}`,
      ).join(" "),
    }),
    "s",
  );
  expect(data.links).toHaveLength(128);
  expect(data.truncated).toBe(true);
});

it("groups generated files as products and inputs, read files and web links as resources", () => {
  const marker = "\n\n引用（相对项目；绝对路径在当前主机，按现有权限读取）：\n";
  const data = taskInfo(
    events(
      {
        kind: "user",
        request_id: "r",
        text: `See https://example.com${marker}${JSON.stringify([
          { path: "/project/input.pdf", type: "file" },
          { path: "/project/output.md", type: "file" },
        ])}`,
      },
      {
        kind: "tool",
        id: "read",
        name: "Read",
        input: { file_path: "/project/source.ts" },
      },
      { kind: "tool_result", id: "read", content: "ok", is_error: false },
      {
        kind: "tool",
        id: "write",
        name: "Write",
        input: { file_path: "/project/output.md" },
      },
      { kind: "tool_result", id: "write", content: "ok", is_error: false },
      {
        kind: "text",
        text: "[Report](/project/output.md) [Reference](https://example.com/docs)",
      },
    ),
    "s",
    "/project",
  );
  expect(data.products).toEqual([
    { kind: "file", path: "output.md", name: "Report", directory: false },
  ]);
  expect(
    data.resources.map((item) => (item.kind === "file" ? item.path : item.url)),
  ).toEqual([
    "input.pdf",
    "https://example.com/",
    "source.ts",
    "https://example.com/docs",
  ]);
});
