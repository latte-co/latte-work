import type { Event } from "./protocol";
export type Item =
  | { key: number; type: "user"; text: string }
  | { key: number; type: "assistant"; text: string }
  | {
      key: number;
      type: "event";
      value: Event["event"];
      resolved?: boolean;
      decision?: "allowed" | "denied" | "expired";
    };
export function appendEvents(existing: Event[], incoming: Event[]): Event[] {
  const seen = new Set(existing.map((e) => e.seq));
  return [...existing, ...incoming.filter((e) => !seen.has(e.seq))].sort(
    (a, b) => a.seq - b.seq,
  );
}
export function transcript(events: Event[]): Item[] {
  const items: Item[] = [];
  const resolved = new Map(
    events.flatMap((e) =>
      e.event.kind === "approval_resolved"
        ? [[e.event.request_id, e.event.allow] as const]
        : [],
    ),
  );
  const terminal = events
    .filter(
      (e) =>
        e.event.kind === "state" &&
        !["running", "waiting"].includes(e.event.status),
    )
    .map((e) => e.seq);
  for (const { seq, event } of events) {
    if (event.kind === "user")
      items.push({ key: seq, type: "user", text: event.text });
    else if (event.kind === "text") {
      const last = items.at(-1);
      if (last?.type === "assistant") last.text += event.text;
      else items.push({ key: seq, type: "assistant", text: event.text });
    } else if (event.kind === "approval") {
      const inactive = terminal.some((end) => end > seq);
      items.push({
        key: seq,
        type: "event",
        value: event,
        resolved: inactive || resolved.has(event.request_id),
        decision: resolved.has(event.request_id)
          ? resolved.get(event.request_id)
            ? "allowed"
            : "denied"
          : inactive
            ? "expired"
            : undefined,
      });
    } else if (
      event.kind === "state"
        ? !!event.message
        : event.kind !== "approval_resolved"
    )
      items.push({ key: seq, type: "event", value: event });
  }
  return items;
}
