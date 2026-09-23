import { describe, expect, it } from "vitest";
import { appendEvents, transcript } from "./transcript";
import type { Event, EventKind } from "./protocol";
const e = (seq: number, event: EventKind): Event => ({
  seq,
  event,
  at: 0,
  session_id: "s",
});
describe("durable transcript projection", () => {
  it("deduplicates replay while preserving token order", () => {
    const a = e(1, { kind: "text", text: "你" });
    const b = e(2, { kind: "text", text: "好" });
    expect(transcript(appendEvents([a], [a, b]))).toEqual([
      { key: 1, type: "assistant", text: "你好" },
    ]);
  });
  it("does not merge across user turns", () => {
    expect(
      transcript([
        e(1, { kind: "text", text: "a" }),
        e(2, { kind: "user", text: "b", request_id: "r" }),
        e(3, { kind: "text", text: "c" }),
      ]),
    ).toHaveLength(3);
  });
  it("expires approval controls after interruption or resolution", () => {
    const approval = e(1, {
      kind: "approval",
      request_id: "r",
      tool: "Bash",
      input: {},
    });
    expect(
      transcript([
        approval,
        e(2, { kind: "state", status: "unknown", message: "interrupted" }),
      ])[0],
    ).toMatchObject({ resolved: true });
    expect(
      transcript([
        approval,
        e(2, { kind: "approval_resolved", request_id: "r", allow: false }),
      ])[0],
    ).toMatchObject({ resolved: true });
  });
});
