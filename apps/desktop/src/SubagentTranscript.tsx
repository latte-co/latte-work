import { Fragment, useRef } from "react";
import { ChevronRight } from "lucide-react";
import {
  activityTranscript,
  activitySegments,
  isProcessActivity,
  finalReplyItems,
  type ActivityItem,
} from "./activity";
import { MessageContent } from "./MessageContent";
import { WorkingStatus } from "./WorkingStatus";
import { ReplyActions } from "./ReplyActions";
import { ToolRow, ToolGroup } from "./ToolActivity";
import { ToolImages } from "./ToolImages";
import { ProcessDisclosure, ProcessSummary } from "./TurnTranscript";
import type { Event, Subagent } from "./protocol";

function renderItem(item: ActivityItem) {
  if (item.type === "tool_images") return <ToolImages images={item.images} />;
  if (item.type === "assistant")
    return (
      <article className="markdown">
        <MessageContent text={item.text} />
      </article>
    );
  if (item.type === "tool") return <ToolRow tool={item} />;
  if (item.type === "tools") return <ToolGroup tools={item.tools} />;
  if (item.type === "event" && item.value.kind === "notice")
    return <p className="subagent-empty">{item.value.text}</p>;
  return null;
}

export function SubagentTranscript({
  task,
  events,
  elapsed,
  incomplete = false,
  readingMore = false,
  prompt,
}: {
  task: Subagent;
  events: Event[];
  elapsed: string;
  incomplete?: boolean;
  readingMore?: boolean;
  prompt?: string | null;
}) {
  const processMemory = useRef(new Map<string, boolean>());
  const allItems = activityTranscript(events);
  const instruction =
    prompt || allItems.find((item) => item.type === "user")?.text;
  const items = allItems.filter((item) => item.type !== "user");
  if (!["running", "paused"].includes(task.status)) {
    for (const item of items) {
      const tools =
        item.type === "tool" ? [item] : item.type === "tools" ? item.tools : [];
      for (const tool of tools)
        if (tool.status === "pending") tool.status = "unconfirmed";
    }
  }
  const completed = task.status === "completed" && !readingMore;
  // A native delivered summary that matches recorded prose is authoritative,
  // even if the child subsequently writes state and emits a short receipt.
  const summaryItem =
    completed && task.summary
      ? [...items]
          .reverse()
          .filter((item) => item.type === "assistant")
          .find((item) => item.text === task.summary)
      : undefined;
  const reply = completed
    ? summaryItem
      ? [summaryItem]
      : finalReplyItems(items)
    : [];
  const final = completed
    ? reply.map((item) => item.text).join("\n\n") || task.summary
    : null;
  const replyKeys = new Set(reply.map((item) => item.key));
  const body = items.filter((item) => !replyKeys.has(item.key));
  const segments = activitySegments(
    body,
    (item) => completed && isProcessActivity(item),
  );
  const processCount = segments.filter((segment) => segment.process).length;
  return (
    <div className="subagent-transcript">
      {instruction && (
        <details className="turn-process subagent-instruction">
          <summary>
            任务指令
            <ChevronRight size={14} aria-hidden="true" />
          </summary>
          <div className="markdown">
            <MessageContent text={instruction} />
          </div>
        </details>
      )}
      {segments.map((segment) =>
        segment.process ? (
          <ProcessDisclosure
            key={`${task.id}:process:${segment.items[0].key}`}
            identity={`${task.id}:${segment.items[0].key}`}
            memory={processMemory.current}
          >
            <ProcessSummary
              items={segment.items}
              label={
                processCount === 1 && elapsed ? `用时 ${elapsed}` : "执行过程"
              }
            />
            {() => (
              <div className="turn-process-content">
                {segment.items.map((item) => (
                  <Fragment key={item.key}>{renderItem(item)}</Fragment>
                ))}
              </div>
            )}
          </ProcessDisclosure>
        ) : (
          <Fragment key={`${task.id}:visible:${segment.items[0].key}`}>
            {segment.items.map((item) => (
              <Fragment key={item.key}>{renderItem(item)}</Fragment>
            ))}
          </Fragment>
        ),
      )}
      {final ? (
        <>
          <article className="markdown subagent-result">
            <MessageContent text={final} />
          </article>
          <ReplyActions text={final} at={task.updated_at} />
        </>
      ) : !readingMore && task.summary ? (
        <article className="markdown subagent-result">
          <MessageContent text={task.summary} />
        </article>
      ) : completed ? (
        <p className="subagent-empty">未收到最终输出</p>
      ) : null}
      {readingMore && <WorkingStatus label="正在读取完整记录…" animated />}
      {incomplete && (
        <p className="subagent-empty">
          部分原始记录暂不可读取，当前保留已保存的内容。
        </p>
      )}
    </div>
  );
}
