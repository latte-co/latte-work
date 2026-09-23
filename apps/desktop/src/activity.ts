import type { Event, JsonValue } from "./protocol";
import { transcript, type Item } from "./transcript";

export interface ToolActivity {
  key: number;
  type: "tool";
  name: string;
  input?: JsonValue;
  output?: JsonValue;
  status: "pending" | "completed" | "failed" | "unconfirmed";
}
export type ActivityItem =
  | Item
  | ToolActivity
  | {
      key: number;
      type: "tools";
      tools: ToolActivity[];
    };

/** Pair by tool ID within a user turn, never by result arrival order. */
export function activityTranscript(events: Event[]): ActivityItem[] {
  const rows: (Item | ToolActivity)[] = [];
  const pending = new Map<string, ToolActivity>();
  const unfinished = new Set<ToolActivity>();
  function finish() {
    for (const tool of unfinished) {
      if (tool.status === "pending") tool.status = "unconfirmed";
    }
    unfinished.clear();
    pending.clear();
  }
  // State events without a message are still needed to end pending operations.
  const terminal = events
    .filter(
      ({ event }) =>
        event.kind === "state" &&
        !["running", "waiting"].includes(event.status),
    )
    .map(({ seq }) => seq);
  let terminalIndex = 0;
  const projected = transcript(events);
  for (const item of projected) {
    while (
      terminalIndex < terminal.length &&
      terminal[terminalIndex] <= item.key
    ) {
      finish();
      terminalIndex++;
    }
    if (item.type === "user") finish();
    if (item.type !== "event") {
      rows.push(item);
      continue;
    }
    const value = item.value;
    if (value.kind === "tool") {
      const tool: ToolActivity = {
        key: item.key,
        type: "tool",
        name: value.name,
        input: value.input,
        status: "pending",
      };
      rows.push(tool);
      unfinished.add(tool);
      if (value.id) pending.set(value.id, tool);
    } else if (value.kind === "tool_result") {
      const tool = value.id ? pending.get(value.id) : undefined;
      if (tool) {
        tool.output = value.content;
        tool.status = value.is_error ? "failed" : "completed";
        pending.delete(value.id);
        unfinished.delete(tool);
      } else {
        // Partial histories must not lose unmatched results.
        rows.push({
          key: item.key,
          type: "tool",
          name: "工具输出",
          output: value.content,
          status: value.is_error ? "failed" : "completed",
        });
      }
    } else rows.push(item);
  }
  if (terminalIndex < terminal.length) finish();
  const grouped: ActivityItem[] = [];
  for (const row of rows) {
    const last = grouped.at(-1);
    // Failures and approval controls remain visible outside collapsed groups.
    if (row.type === "tool" && row.status !== "failed") {
      if (last?.type === "tools") last.tools.push(row);
      else if (last?.type === "tool" && last.status !== "failed")
        grouped.splice(-1, 1, {
          key: last.key,
          type: "tools",
          tools: [last, row],
        });
      else grouped.push(row);
    } else grouped.push(row);
  }
  return grouped;
}

function field(input: JsonValue | undefined, key: string): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  return typeof input[key] === "string" ? input[key] : "";
}
export function toolLabel(tool: ToolActivity, compact = false): string {
  const fullPath = field(tool.input, "file_path") || field(tool.input, "path");
  const parts = fullPath.split("/").filter(Boolean);
  const path =
    compact && parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : fullPath;
  const description = field(tool.input, "description");
  const command = field(tool.input, "command");
  const pattern = field(tool.input, "pattern");
  switch (tool.name.toLowerCase()) {
    case "read":
      return path ? `读取 ${path}` : "读取文件";
    case "edit":
    case "multiedit":
      return path ? `编辑 ${path}` : "编辑文件";
    case "write":
      return path ? `写入 ${path}` : "写入文件";
    case "bash":
      return description || (command ? `运行 ${command}` : "运行命令");
    case "glob":
      return pattern ? `查找文件 ${pattern}` : "查找文件";
    case "grep":
      return pattern ? `搜索 ${pattern}` : "搜索内容";
    case "skill":
      return `使用 ${field(tool.input, "skill") || "Skill"}`;
    default:
      return description || tool.name;
  }
}
export function toolGroupLabel(tools: ToolActivity[]): string {
  const categories = new Map<string, number>();
  for (const tool of tools) {
    const category =
      (
        {
          read: "读取文件",
          bash: "运行命令",
          glob: "查找文件",
          grep: "搜索内容",
          edit: "编辑文件",
          multiedit: "编辑文件",
          write: "写入文件",
        } as Record<string, string>
      )[tool.name.toLowerCase()] || "工具操作";
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  return [...categories]
    .map(([name, count]) => `${name} ${count} 次`)
    .join(" · ");
}
