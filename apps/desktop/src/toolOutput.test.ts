// @vitest-environment jsdom
import { expect, it } from "vitest";
import { imageBytes, toolOutput } from "./toolOutput";
import { turnTranscript } from "./TurnTranscript";
import type { Event } from "./protocol";
const image = {
  type: "image" as const,
  mime_type: "image/png",
  data_base64: "iVBORw0KGgo=",
};
it("projects normalized image blocks independently of collapsed tools and completed process", () => {
  const events: Event[] = [
    { kind: "user", text: "make image", request_id: "r" },
    {
      kind: "tool",
      id: "read",
      name: "Read",
      input: { file_path: "image.png" },
    },
    {
      kind: "tool_result",
      id: "read",
      content: [{ type: "text", text: "caption" }, image],
      is_error: false,
    },
    { kind: "text", text: "image above" },
    { kind: "state", status: "completed", message: null },
  ].map((event, i) => ({
    session_id: "s",
    seq: i + 1,
    at: i * 1000,
    event,
  })) as Event[];
  const turn = turnTranscript(events)[0];
  expect(turn.visible.some((item) => item.type === "tool_images")).toBe(true);
  expect(turn.process.some((item) => item.type === "tool_images")).toBe(false);
  expect(JSON.stringify(turn.process)).not.toContain("iVBOR");
});
it("keeps text and unfamiliar blocks while excluding image payloads from raw output", () => {
  const parsed = toolOutput([
    { type: "text", text: "keep" },
    image,
    { type: "custom", value: 42 },
  ]);
  expect(parsed.images).toEqual([image]);
  expect(JSON.stringify(parsed.content)).not.toContain("iVBOR");
  expect(JSON.stringify(parsed.content)).toContain("custom");
  expect(imageBytes(image)).toHaveLength(8);
  for (const invalid of [
    { ...image, mime_type: "image/svg+xml" },
    { ...image, data_base64: btoa("not an image") },
    { ...image, data_base64: "!bad" },
  ])
    expect(() => imageBytes(invalid)).toThrow();
});
