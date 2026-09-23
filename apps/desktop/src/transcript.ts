import type { Event } from "./protocol";
export type Item =
  | { key: number; type: "user"; text: string }
  | { key: number; type: "assistant"; text: string }
  | { key: number; type: "event"; value: Event["event"]; resolved?: boolean };
export function appendEvents(existing: Event[], incoming: Event[]): Event[] {
  const seen = new Set(existing.map((e) => e.seq));
  return [...existing, ...incoming.filter((e) => !seen.has(e.seq))].sort(
    (a, b) => a.seq - b.seq,
  );
}
export function transcript(events: Event[]): Item[] {
  const items: Item[] = [];
  const resolved = new Set(
    events.flatMap((e) =>
      e.event.kind === "approval_resolved" ? [e.event.request_id] : [],
    ),
  );
  const lastState = [...events]
    .reverse()
    .find((e) => e.event.kind === "state")?.event;
  const inactive =
    lastState?.kind === "state" &&
    !["running", "waiting"].includes(lastState.status);
  for (const { seq, event } of events) {
    if (event.kind === "user")
      items.push({ key: seq, type: "user", text: event.text });
    else if (event.kind === "text") {
      const last = items.at(-1);
      if (last?.type === "assistant") last.text += event.text;
      else items.push({ key: seq, type: "assistant", text: event.text });
    } else if (event.kind === "approval")
      items.push({
        key: seq,
        type: "event",
        value: event,
        resolved: inactive || resolved.has(event.request_id),
      });
    else if (
      event.kind === "state"
        ? !!event.message
        : event.kind !== "approval_resolved"
    )
      items.push({ key: seq, type: "event", value: event });
  }
  return items;
}
