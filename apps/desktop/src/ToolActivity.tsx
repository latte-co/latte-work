import {
  ChevronRight,
  CircleAlert,
  FileText,
  LoaderCircle,
  Terminal,
  Wrench,
} from "lucide-react";
import { toolGroupLabel, toolLabel, type ToolActivity } from "./activity";
import type { JsonValue } from "./protocol";

function outputText(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
function ToolIcon({ tool }: { tool: ToolActivity }) {
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
      {status === "pending"
        ? "执行中"
        : status === "failed"
          ? "失败"
          : "结果待确认"}
    </span>
  );
}
export function ToolRow({ tool }: { tool: ToolActivity }) {
  const label = toolLabel(tool).replace(/\s+/g, " ");
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
        {tool.output !== undefined ? (
          <pre>{outputText(tool.output)}</pre>
        ) : (
          <p>
            {tool.status === "pending"
              ? "等待工具返回结果…"
              : "未收到工具结果。"}
          </p>
        )}
      </div>
    </details>
  );
}
export function ToolGroup({ tools }: { tools: ToolActivity[] }) {
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
          <ToolRow key={tool.key} tool={tool} />
        ))}
      </div>
    </details>
  );
}
