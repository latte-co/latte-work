import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ReplyActions } from "./ReplyActions";
import type { Event } from "./protocol";
import { activityTranscript, type ActivityItem } from "./activity";
import { queuedInputReceipts } from "./transcript";

const isSkillLoadNotice = (item: ActivityItem) =>
  item.type === "event" &&
  item.value.kind === "notice" &&
  /^已加载 Skill：\S+$/.test(item.value.text);

/** Fold confirmed outcomes only; stopped turns retain their prose and approvals. */
export function turnTranscript(events: Event[]) {
  const receipts = queuedInputReceipts(events);
  const groups: Event[][] = [];
  for (const event of events) {
    if (event.event.kind === "user" || !groups.length) groups.push([]);
    groups.at(-1)!.push(event);
  }
  return groups.map((events) => {
    let items = activityTranscript(events, receipts).filter(
      (item) =>
        !(
          item.type === "event" &&
          item.value.kind === "notice" &&
          (/^模型：/.test(item.value.text) ||
            /^Provider：.* · 模型：/.test(item.value.text))
        ),
    );
    const first = items[0];
    const user = first?.type === "user" && !first.handoff ? first : undefined;
    if (user) items.shift();
    const end = [...events].reverse().find((e) => e.event.kind === "state");
    const completed =
      end?.event.kind === "state" && end.event.status === "completed";
    const stopped =
      end?.event.kind === "state" && end.event.status === "stopped";
    if (stopped)
      items = items.filter(
        (item) =>
          !(
            item.type === "event" &&
            item.value.kind === "state" &&
            item.value.status === "stopped"
          ),
      );
    const isTool = (item: ActivityItem) =>
      item.type === "tool" || item.type === "tools";
    const duration = end && user ? end.at - events[0].at : null;
    const elapsed = stopped
      ? `已停止${duration != null && duration >= 1000 ? ` · ${formatElapsed(duration)}` : ""}`
      : duration != null
        ? formatElapsed(duration)
        : "执行过程";
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
            item.type === "user" ||
            item.type === "tool" ||
            item.type === "tools" ||
            (item.type === "event" && !!item.approvalTool),
        ) &&
      !items.some(
        (item) =>
          item.type === "event" &&
          (item.value.kind === "approval" || item.value.kind === "question") &&
          !item.resolved,
      );
    // Split at visible handoffs rather than disabling folding for the whole turn.
    // Pair tools before splitting so results stay with their original invocation.
    const segments: { process: boolean; items: ActivityItem[] }[] = [];
    function append(item: ActivityItem, process: boolean) {
      const last = segments.at(-1);
      if (last?.process === process) last.items.push(item);
      else segments.push({ process, items: [item] });
    }
    if (stopped) {
      for (const item of items.filter(isTool)) append(item, true);
      for (const item of items.filter((item) => !isTool(item)))
        append(item, false);
    } else {
      items.forEach((item, index) =>
        append(
          item,
          hasFinal &&
            index < finalIndex &&
            item.type !== "user" &&
            item.type !== "tool_images" &&
            !isSkillLoadNotice(item),
        ),
      );
    }
    return {
      key: `${events[0].session_id}:${events[0].seq}`,
      outcomeKey: end?.seq,
      user,
      status: end?.event.kind === "state" ? end.event.status : undefined,
      finalKey: hasFinal ? lastAssistant?.key : undefined,
      finalAt: hasFinal ? end?.at : undefined,
      stopped,
      elapsed,
      segments,
      processCount: segments.filter((part) => part.process).length,
      process: segments
        .filter((part) => part.process)
        .flatMap((part) => part.items),
      visible: segments
        .filter((part) => !part.process)
        .flatMap((part) => part.items),
    };
  });
}

export type TranscriptTurn = ReturnType<typeof turnTranscript>[number];

export function TurnTranscript({
  events,
  turns: suppliedTurns,
  children,
}: {
  events: Event[];
  turns?: TranscriptTurn[];
  children: (item: ActivityItem) => ReactNode;
}) {
  const turns = useMemo(
    () => suppliedTurns ?? turnTranscript(events),
    [events, suppliedTurns],
  );
  return turns.map((turn) => (
    <div
      className="conversation-turn"
      key={turn.key}
      data-turn-key={turn.user ? turn.key : undefined}
    >
      {turn.user && !turn.user.hidden && children(turn.user)}
      {turn.stopped && turn.process.length === 0 && (
        <div className="turn-stop-summary" title="已执行的文件改动不会撤销。">
          {turn.elapsed}
        </div>
      )}
      {turn.segments.map((segment) =>
        segment.process ? (
          <ProcessDisclosure key={`${turn.outcomeKey}:${segment.items[0].key}`}>
            <summary
              title={turn.stopped ? "已执行的文件改动不会撤销。" : undefined}
            >
              <span>{turn.processCount > 1 ? "执行过程" : turn.elapsed}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </summary>
            {() => (
              <div className="turn-process-content">
                {segment.items.map((item) => (
                  <Fragment key={item.key}>{children(item)}</Fragment>
                ))}
              </div>
            )}
          </ProcessDisclosure>
        ) : (
          <Fragment key={segment.items[0].key}>
            {segment.items.map((item) => (
              <Fragment key={item.key}>
                {children(item)}
                {item.key === turn.finalKey && item.type === "assistant" && (
                  <ReplyActions text={item.text} at={turn.finalAt} />
                )}
              </Fragment>
            ))}
          </Fragment>
        ),
      )}
    </div>
  ));
}

export function ProcessDisclosure({
  children,
}: {
  children: [ReactNode, () => ReactNode];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="turn-process"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {children[0]}
      {open && children[1]()}
    </details>
  );
}

export function formatElapsed(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "执行过程";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `用时 ${hours ? `${hours}小时 ` : ""}${minutes ? `${minutes}分 ` : ""}${seconds % 60}秒`;
}
