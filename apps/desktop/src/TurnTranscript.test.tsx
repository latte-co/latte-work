// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Event, EventKind, Status } from "./protocol";
import { TurnTranscript, turnTranscript } from "./TurnTranscript";
import { MessageContent } from "./MessageContent";
afterEach(cleanup);
const user = (text: string): EventKind => ({
  kind: "user",
  text,
  request_id: text,
});
const text = (text: string): EventKind => ({ kind: "text", text });
const state = (status: Status): EventKind => ({
  kind: "state",
  status,
  message: null,
});
const tool: EventKind = { kind: "tool", id: "t", name: "Read", input: {} };
const result: EventKind = {
  kind: "tool_result",
  id: "t",
  content: "ok",
  is_error: false,
};
const events = (...values: EventKind[]): Event[] =>
  values.map((event, seq) => ({ seq, session_id: "s", at: seq, event }));
it("folds only the process of each completed turn and keeps its final answer outside", () => {
  const rows = events(
    user("first"),
    text("progress"),
    tool,
    result,
    text("final"),
    state("completed"),
    user("second"),
    text("still working"),
    state("running"),
  );
  const turns = turnTranscript(rows);
  expect(turns).toHaveLength(2);
  expect(turns[0].process.map((i) => i.type)).toEqual(["assistant", "tool"]);
  expect(turns[0].visible).toEqual([
    expect.objectContaining({ text: "final" }),
  ]);
  expect(turns[1].process).toEqual([]);
  render(
    <TurnTranscript events={rows}>
      {(item) => (
        <p key={item.key}>
          {item.type === "assistant" || item.type === "user"
            ? item.text
            : "tool"}
        </p>
      )}
    </TurnTranscript>,
  );
  const details = screen.getByText("查看执行过程").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.contains(screen.getByText("progress"))).toBe(true);
  expect(details.contains(screen.getByText("final"))).toBe(false);
  details.open = true;
  expect(details.open).toBe(true);
});
it.each(["running", "waiting", "failed", "stopped", "unknown"] as Status[])(
  "does not collapse %s turns",
  (status) => {
    expect(
      turnTranscript(
        events(user("q"), text("progress"), tool, text("reply"), state(status)),
      )[0].process,
    ).toEqual([]);
  },
);
it("does not turn pre-tool commentary or incomplete history into a final answer", () => {
  expect(
    turnTranscript(
      events(user("q"), text("progress"), tool, result, state("completed")),
    )[0].process,
  ).toEqual([]);
  expect(
    turnTranscript(
      events(text("partial"), tool, text("reply"), state("completed")),
    )[0].process,
  ).toEqual([]);
  expect(
    turnTranscript(
      events(user("q"), text("only answer"), state("completed")),
    )[0].process,
  ).toEqual([]);
});
it("removes reply copying while retaining code copying", () => {
  render(<MessageContent text={"Answer\n\n```ts\nconst a = 1;\n```"} />);
  expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
  expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy();
});
