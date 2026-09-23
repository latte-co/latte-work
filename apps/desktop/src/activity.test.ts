import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "./protocol";
import { activityTranscript, toolLabel } from "./activity";
const e = (seq: number, event: EventKind): Event => ({
  seq,
  event,
  at: seq,
  session_id: "s",
});
const call = (seq: number, id: string, name = "Read") =>
  e(seq, { kind: "tool", id, name, input: { file_path: `/repo/${id}.ts` } });
const result = (seq: number, id: string, is_error = false) =>
  e(seq, { kind: "tool_result", id, content: `${id} output`, is_error });
describe("readable activity projection", () => {
  it("pairs parallel results by ID and compacts consecutive operations", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        call(2, "b"),
        result(3, "b"),
        result(4, "a"),
      ]),
    ).toMatchObject([
      {
        type: "tools",
        tools: [
          { key: 1, output: "a output", status: "completed" },
          { key: 2, output: "b output", status: "completed" },
        ],
      },
    ]);
  });
  it("retains commentary between operations even when a result arrives later", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "text", text: "正在检查" }),
        result(3, "a"),
        call(4, "b"),
      ]).map((i) => i.type),
    ).toEqual(["tool", "assistant", "tool"]);
  });
  it("leaves failures and pending approvals outside collapsed groups", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        call(2, "b"),
        result(3, "a"),
        result(4, "b", true),
        e(5, { kind: "approval", request_id: "r", tool: "Bash", input: {} }),
        call(6, "c"),
      ]),
    ).toMatchObject([
      { type: "tool", status: "completed" },
      { type: "tool", status: "failed" },
      { type: "event", value: { kind: "approval" } },
      { type: "tool", status: "pending" },
    ]);
  });
  it("keeps unmatched results rather than attaching them to an unrelated call", () => {
    expect(
      activityTranscript([call(1, "a"), result(2, "other")]),
    ).toMatchObject([
      {
        type: "tools",
        tools: [
          { status: "pending" },
          { name: "工具输出", output: "other output" },
        ],
      },
    ]);
  });
  it("does not pair reused IDs across turns", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "user", text: "next", request_id: "next" }),
        result(3, "a"),
      ]),
    ).toMatchObject([
      { type: "tool", status: "unconfirmed" },
      { type: "user" },
      { type: "tool", name: "工具输出" },
    ]);
  });
  it("marks missing results unconfirmed on terminal states, including states without text", () => {
    for (const status of [
      "completed",
      "failed",
      "unknown",
      "stopped",
    ] as const) {
      expect(
        activityTranscript([
          call(1, "a"),
          e(2, { kind: "state", status, message: null }),
        ]),
      ).toMatchObject([{ type: "tool", status: "unconfirmed" }]);
    }
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "state", status: "waiting", message: null }),
      ]),
    ).toMatchObject([{ status: "pending" }]);
  });
  it("does not leave a prior interrupted operation running when the next turn starts", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "state", status: "unknown", message: null }),
        e(3, { kind: "user", text: "next", request_id: "r" }),
        call(4, "b"),
      ]),
    ).toMatchObject([
      { status: "unconfirmed" },
      { type: "user" },
      { status: "pending" },
    ]);
  });
  it("labels actions from structured inputs with a safe fallback for unknown tools", () => {
    expect(
      toolLabel({
        key: 1,
        type: "tool",
        name: "Read",
        input: { file_path: "/repo/main.ts" },
        status: "completed",
      }),
    ).toBe("读取 /repo/main.ts");
    expect(
      toolLabel({
        key: 1,
        type: "tool",
        name: "Bash",
        input: { description: "检查构建结果", command: "npm test" },
        status: "completed",
      }),
    ).toBe("检查构建结果");
    expect(
      toolLabel({
        key: 1,
        type: "tool",
        name: "future_agent_tool",
        input: null,
        status: "completed",
      }),
    ).toBe("future_agent_tool");
  });
});
