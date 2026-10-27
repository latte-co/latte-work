import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ReplyActions } from "./ReplyActions";
import type { Event } from "./protocol";
import {
  activityTranscript,
  activitySegments,
  isProcessActivity,
  finalReplyItems,
  type ActivityItem,
} from "./activity";
import { queuedInputReceipts } from "./transcript";

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
    const reply = finalReplyItems(items);
    const lastAssistant = reply.at(-1);
    const finalIndex = reply.length ? items.indexOf(reply[0]) : -1;
    // Plain text has no semantic phase. Keep the whole terminal reply, and
    // retain earlier prose in the explicitly labelled, expandable process.
    const hasFinal =
      !!user &&
      completed &&
      finalIndex >= 0 &&
      !items.some(
        (item) =>
          item.type === "event" &&
          (item.value.kind === "approval" || item.value.kind === "question") &&
          !item.resolved,
      );
    const segments = activitySegments(items, (item, index) =>
      stopped
        ? isTool(item)
        : hasFinal && index < finalIndex && isProcessActivity(item),
    );
    return {
      key: `${events[0].session_id}:${events[0].seq}`,
      user,
      status: end?.event.kind === "state" ? end.event.status : undefined,
      finalKey: hasFinal ? lastAssistant?.key : undefined,
      finalText: hasFinal
        ? reply.map((item) => item.text).join("\n\n")
        : undefined,
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
  const processMemory = useRef(new Map<string, boolean>());
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
      {turn.stopped && turn.processCount !== 1 && (
        <div className="turn-stop-summary" title="已执行的文件改动不会撤销。">
          {turn.elapsed}
        </div>
      )}
      {turn.segments.map((segment) =>
        segment.process ? (
          <ProcessDisclosure
            key={`process:${segment.items[0].key}`}
            identity={`${turn.key}:${segment.items[0].key}`}
            memory={processMemory.current}
          >
            <ProcessSummary
              items={segment.items}
              label={turn.processCount > 1 ? "执行过程" : turn.elapsed}
              title={turn.stopped ? "已执行的文件改动不会撤销。" : undefined}
            />
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
                  <ReplyActions text={turn.finalText!} at={turn.finalAt} />
                )}
              </Fragment>
            ))}
          </Fragment>
        ),
      )}
    </div>
  ));
}

export function ProcessSummary({
  label,
  items,
  title,
}: {
  label: string;
  items: ActivityItem[];
  title?: string;
}) {
  const replies = items.filter((item) => item.type === "assistant").length;
  return (
    <summary title={title ?? "展开查看完整过程和较早回复。"}>
      <span>{label}</span>
      {replies > 0 && <span> · {replies} 段较早回复</span>}
      <ChevronRight size={14} aria-hidden="true" />
    </summary>
  );
}

export function ProcessDisclosure({
  children,
  identity,
  memory,
}: {
  children: [ReactNode, () => ReactNode];
  identity: string;
  memory: Map<string, boolean>;
}) {
  const [open, setOpen] = useState(() => memory.get(identity) ?? false);
  return (
    <details
      className="turn-process"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        // The owner survives live/complete transitions; its host/session key
        // isolates this bounded, in-memory history from other conversations.
        memory.delete(identity);
        memory.set(identity, next);
        if (memory.size > 256) memory.delete(memory.keys().next().value!);
      }}
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
