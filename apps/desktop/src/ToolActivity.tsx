import { useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  CirclePause,
  FileText,
  LoaderCircle,
  Terminal,
  Wrench,
} from "lucide-react";
import { toolGroupLabel, toolLabel, type ToolActivity } from "./activity";
import { reassembleFullContent, streamEventContent } from "./eventContent";
import type { ContentEncoding, JsonValue } from "./protocol";

/** Identity a previewed tool output needs to stream its full payload. */
export interface ToolLoadContext {
  hostId: string;
  sessionId: string;
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

interface ToolStream {
  encoding: ContentEncoding;
  text: string;
  received: number;
  total: number;
  done: boolean;
}

function outputText(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
function ToolIcon({ tool }: { tool: ToolActivity }) {
  if (["waiting", "denied", "expired"].includes(tool.status))
    return <CirclePause size={16} />;
  if (tool.status === "failed") return <CircleAlert size={16} />;
  if (tool.status === "pending")
    return <LoaderCircle size={16} className="spin" />;
  if (tool.name.toLowerCase() === "bash") return <Terminal size={16} />;
  if (["read", "edit", "write", "multiedit"].includes(tool.name.toLowerCase()))
    return <FileText size={16} />;
  return <Wrench size={16} />;
}
function Status({ status }: { status: ToolActivity["status"] }) {
  return status === "completed" ? null : (
    <span className={`activity-status ${status === "failed" ? "failure" : ""}`}>
      {status === "waiting"
        ? "等待确认"
        : status === "denied"
          ? "已拒绝"
          : status === "expired"
            ? "审批已过期"
            : status === "pending"
              ? "执行中"
              : status === "failed"
                ? "失败"
                : "结果待确认"}
    </span>
  );
}
export function ToolRow({
  tool,
  loadContext,
}: {
  tool: ToolActivity;
  loadContext?: ToolLoadContext;
}) {
  const label = toolLabel(tool).replace(/\s+/g, " ");
  const [stream, setStream] = useState<ToolStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function loadFull() {
    if (!loadContext || !tool.load || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await streamEventContent(
        { ...loadContext, seq: tool.load.seq },
        ({ encoding, accumulated, received, total }) =>
          setStream({
            encoding,
            text: accumulated,
            received,
            total,
            done: false,
          }),
      );
      setStream({
        encoding: outcome.encoding,
        text: outcome.content,
        received: tool.load!.size,
        total: tool.load!.size,
        done: true,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className={`activity-row ${tool.status === "failed" ? "failure" : ""}`}
    >
      <summary title={label}>
        <ToolIcon tool={tool} />
        <span className="activity-label">
          {toolLabel(tool, true).replace(/\s+/g, " ")}
        </span>
        <Status status={tool.status} />
        <ChevronRight size={14} className="activity-chevron" />
      </summary>
      <div
        className="activity-output"
        tabIndex={0}
        role="region"
        aria-label={`${label}的详情`}
      >
        {tool.input !== undefined && (
          <>
            <div className="activity-output-label">输入</div>
            <pre>{outputText(tool.input)}</pre>
          </>
        )}
        <div className="activity-output-label">
          {tool.status === "failed" ? "错误输出" : "输出"}
        </div>
        {stream ? (
          <>
            {!stream.done && (
              <div className="activity-load-progress">
                正在流式加载{" "}
                {Math.min(
                  100,
                  Math.round((stream.received / stream.total) * 100),
                )}
                %（{formatBytes(stream.received)} / {formatBytes(stream.total)}
                ）
              </div>
            )}
            {stream.encoding === "text" || stream.done ? (
              <pre>
                {stream.done
                  ? stream.encoding === "text"
                    ? stream.text
                    : reassembleFullContent("json", stream.text)
                  : stream.text}
              </pre>
            ) : (
              <p>结构化内容接收中…</p>
            )}
          </>
        ) : tool.output !== undefined ? (
          <pre>{outputText(tool.output)}</pre>
        ) : (
          <p>
            {tool.status === "pending"
              ? "等待工具返回结果…"
              : "未收到工具结果。"}
          </p>
        )}
        {tool.load && loadContext && !stream && (
          <button
            type="button"
            className="activity-load"
            disabled={busy}
            onClick={loadFull}
          >
            {busy
              ? "加载中…"
              : `加载完整内容（已省略至预览，共 ${formatBytes(tool.load.size)}）`}
          </button>
        )}
        {error && <p className="activity-load-error">加载失败：{error}</p>}
      </div>
    </details>
  );
}
export function ToolGroup({
  tools,
  loadContext,
}: {
  tools: ToolActivity[];
  loadContext?: ToolLoadContext;
}) {
  const status = tools.some((t) => t.status === "pending")
    ? "pending"
    : tools.some((t) => t.status === "unconfirmed")
      ? "unconfirmed"
      : "completed";
  return (
    <details className="activity-group">
      <summary>
        {status === "pending" ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Wrench size={16} />
        )}
        <span className="activity-label">{toolGroupLabel(tools)}</span>
        <Status status={status} />
        <ChevronRight size={14} className="activity-chevron" />
      </summary>
      <div className="activity-children">
        {tools.map((tool) => (
          <ToolRow key={tool.key} tool={tool} loadContext={loadContext} />
        ))}
      </div>
    </details>
  );
}
