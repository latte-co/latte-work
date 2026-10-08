import { expect, it } from "vitest";
import type { Event } from "./protocol";
import { hasRepeatedOutput } from "./repeatedOutput";

const repeated = (count = 12) =>
  Array.from(
    { length: count },
    (_, i) => `[${890 + i}]: (remaining tool results)\n\n`,
  ).join("");
const events = (texts: string[], sessionId = "s"): Event[] =>
  texts.map((text, i) => ({
    seq: i + 1,
    at: i,
    session_id: sessionId,
    event: { kind: "text", text },
  }));
const boundary = (event: Event["event"]): Event => ({
  seq: 100,
  at: 100,
  session_id: "s",
  event,
});

it("recognizes the incident text across token boundaries and changing numbers", () => {
  expect(hasRepeatedOutput(events([...repeated(8)]), "s")).toBe(true);
  expect(hasRepeatedOutput(events([...repeated(7)]), "s")).toBe(false);
  expect(
    hasRepeatedOutput(
      events([repeated(7), "[898]: (remaining tool results)"]),
      "s",
    ),
  ).toBe(false);
});

it("tolerates occasional distinct lines but clears after fresh prose", () => {
  const text = repeated(4) + "Let me check the actual change.\n" + repeated(4);
  expect(hasRepeatedOutput(events([text]), "s")).toBe(true);
  const fresh = Array.from(
    { length: 5 },
    (_, i) => `New finding number ${i}.\n`,
  ).join("");
  expect(hasRepeatedOutput(events([text, fresh]), "s")).toBe(false);
});

it.each([
  { kind: "user", text: "next request", request_id: "next" },
  { kind: "tool", id: "t", name: "Read", input: {} },
  { kind: "tool_result", id: "t", content: repeated(), is_error: false },
  { kind: "state", status: "completed", message: null },
] satisfies Event["event"][])(
  "resets at $kind instead of inheriting old repetition",
  (event) => {
    expect(
      hasRepeatedOutput([...events([repeated()]), boundary(event)], "s"),
    ).toBe(false);
    expect(
      hasRepeatedOutput(
        [
          ...events([repeated()]),
          boundary(event),
          ...events(["A new response.\n"]),
        ],
        "s",
      ),
    ).toBe(false);
  },
);

it("ignores usage and progress updates, and isolates sessions", () => {
  const output = [
    ...events([repeated()]),
    boundary({ kind: "progress", phase: "replying" }),
  ];
  expect(hasRepeatedOutput(output, "s")).toBe(true);
  expect(hasRepeatedOutput(output, "other")).toBe(false);
  expect(hasRepeatedOutput(events([repeated()], "other"), "s")).toBe(false);
});

it("excludes fenced code, tables, quotes and short repeated markers", () => {
  for (const text of [
    "```text\n" + repeated(),
    "~~~\n" + repeated(),
    "| repeated table cell |\n".repeat(12),
    "> quoted repeated sentence\n".repeat(12),
    "OK\n".repeat(12),
  ]) {
    expect(hasRepeatedOutput(events([...text]), "s")).toBe(false);
  }
  expect(hasRepeatedOutput(events([..."```text\n", repeated(400)]), "s")).toBe(
    false,
  );
});

it("samples recent output so long histories cannot keep the warning alive", () => {
  expect(hasRepeatedOutput(events([repeated(1000)]), "s")).toBe(true);
  expect(
    hasRepeatedOutput(
      events([
        repeated(1000),
        "A distinct and meaningful paragraph. ".repeat(300) + "\n",
      ]),
      "s",
    ),
  ).toBe(false);
});
