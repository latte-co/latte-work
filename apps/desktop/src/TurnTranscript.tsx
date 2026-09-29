import type { ReactNode } from "react";
import type { Event } from "./protocol";
import { activityTranscript, type ActivityItem } from "./activity";

/** User events delimit turns; only an explicit successful end permits folding. */
export function turnTranscript(events: Event[]) {
  const groups: Event[][] = [];
  for (const event of events) {
    if (event.event.kind === "user" || !groups.length) groups.push([]);
    groups.at(-1)!.push(event);
  }
  return groups.map((events) => {
    const items = activityTranscript(events);
    const user = items[0]?.type === "user" ? items.shift() : undefined;
    const end = [...events].reverse().find((e) => e.event.kind === "state");
    const completed =
      end?.event.kind === "state" && end.event.status === "completed";
    const lastAssistant = [...items]
      .reverse()
      .find((item) => item.type === "assistant");
    const finalIndex = lastAssistant ? items.indexOf(lastAssistant) : -1;
    // Text before a later tool is progress, not a final answer. Incomplete histories
    // and failed/interrupted turns keep all evidence visible.
    const canFold =
      !!user &&
      completed &&
      finalIndex > 0 &&
      !items
        .slice(finalIndex + 1)
        .some((item) => item.type === "tool" || item.type === "tools") &&
      !items.some(
        (item) =>
          item.type === "event" &&
          item.value.kind === "approval" &&
          !item.resolved,
      );
    return {
      key: events[0].seq,
      user,
      process: canFold ? items.slice(0, finalIndex) : [],
      visible: canFold ? items.slice(finalIndex) : items,
    };
  });
}

export function TurnTranscript({
  events,
  children,
}: {
  events: Event[];
  children: (item: ActivityItem) => ReactNode;
}) {
  return turnTranscript(events).map((turn) => (
    <div className="conversation-turn" key={turn.key}>
      {turn.user && children(turn.user)}
      {turn.process.length > 0 && (
        <details className="turn-process">
          <summary>查看执行过程</summary>
          <div className="turn-process-content">
            {turn.process.map(children)}
          </div>
        </details>
      )}
      {turn.visible.map(children)}
    </div>
  ));
}
