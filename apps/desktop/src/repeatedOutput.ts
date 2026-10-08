import type { Event } from "./protocol";

/** A presentation hint only: never remove text or interrupt the Agent. */
export function hasRepeatedOutput(events: Event[], sessionId: string): boolean {
  const parts: string[] = [];
  let length = 0;
  let truncated = false;
  let right = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const { session_id, event } = events[i];
    if (session_id !== sessionId) continue;
    if (event.kind === "usage" || event.kind === "progress") continue;
    // A tool, new request or outcome ends the current prose span.
    if (event.kind !== "text") break;
    // Fences can be split across arbitrary streaming fragments. Replies with
    // fences are excluded conservatively, even if the opener is outside the sample.
    if (/`{3}|~{3}/.test(event.text + right)) return false;
    right = (event.text.slice(0, 2) + right).slice(0, 2);
    const remaining = 8192 - length;
    if (event.text.length > remaining) truncated = true;
    if (remaining > 0) {
      const part = event.text.slice(-remaining);
      parts.push(part);
      length += part.length;
    }
  }
  const text = parts.reverse().join("");
  const lines = text.split(/\r?\n/);
  if (truncated) lines.shift(); // Discard a potentially cut first line.
  lines.pop(); // A partial streaming line is not evidence of repetition.
  const recent = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
  const counts = new Map<string, number>();
  for (const line of recent) {
    // Changing enumeration numbers must not hide repeated prose.
    const normalized = line
      .replace(/^(?:\[\d+\]\s*:\s*|\d+[.)]\s+)/, "")
      .replace(/\s+/g, " ");
    if (
      normalized.length < 12 ||
      !/[\p{L}\p{N}]/u.test(normalized) ||
      /^[|>]/.test(normalized)
    )
      continue;
    const count = (counts.get(normalized) ?? 0) + 1;
    if (count >= 8) return true;
    counts.set(normalized, count);
  }
  return false;
}
