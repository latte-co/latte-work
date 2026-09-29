import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { CopyButton } from "./MessageContent";
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
    const items = activityTranscript(events).filter(
      (item) =>
        !(
          item.type === "event" &&
          item.value.kind === "notice" &&
          (/^模型：/.test(item.value.text) ||
            /^Provider：.* · 模型：/.test(item.value.text))
        ),
    );
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
    const hasFinal =
      !!user &&
      completed &&
      finalIndex >= 0 &&
      !items
        .slice(finalIndex + 1)
        .some(
          (item) =>
            item.type === "tool" ||
            item.type === "tools" ||
            (item.type === "event" && !!item.approvalTool),
        ) &&
      !items.some(
        (item) =>
          item.type === "event" &&
          item.value.kind === "approval" &&
          !item.resolved,
      );
    return {
      key: events[0].seq,
      user,
      finalKey: hasFinal ? lastAssistant?.key : undefined,
      elapsed: end && user ? formatElapsed(end.at - events[0].at) : "执行过程",
      process: hasFinal ? items.slice(0, finalIndex) : [],
      visible: hasFinal ? items.slice(finalIndex) : items,
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
          <summary>
            <span>{turn.elapsed}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </summary>
          <div className="turn-process-content">
            {turn.process.map(children)}
          </div>
        </details>
      )}
      {turn.visible.map((item) => (
        <Fragment key={item.key}>
          {children(item)}
          {item.key === turn.finalKey && item.type === "assistant" && (
            <div className="final-reply-actions">
              <CopyButton text={item.text} label="复制回复" iconOnly />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  ));
}

export function formatElapsed(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "执行过程";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `用时 ${hours ? `${hours}小时 ` : ""}${minutes ? `${minutes}分 ` : ""}${seconds % 60}秒`;
}
