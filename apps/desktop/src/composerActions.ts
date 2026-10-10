import type { AgentSlashCommand } from "./protocol";

import type { ComposerReference } from "./pasteAttachments";

export interface ComposerTrigger {
  kind: "files" | "commands";
  start: number;
  end: number;
  query: string;
}
export function composerTrigger(
  text: string,
  cursor: number,
): ComposerTrigger | null {
  const prefix = text.slice(0, cursor);
  if (/^\/[^\s/]*$/.test(prefix))
    return { kind: "commands", start: 0, end: cursor, query: prefix.slice(1) };
  const match = /(?:^|\s)@([^\n@]*)$/.exec(prefix);
  if (!match) return null;
  return {
    kind: "files",
    start: cursor - match[1].length - 1,
    end: cursor,
    query: match[1],
  };
}
export function referencePrompt(text: string, references: ComposerReference[]) {
  if (!references.length) return text.trim();
  return `${text.trim() || "请查看这些文件引用。"}\n\n文件引用（相对路径基于当前项目根目录；绝对路径位于当前执行主机。仅引用路径，按当前权限读取）：\n${JSON.stringify(
    references.map(({ path, name, directory, attachmentKind, mimeType }) => ({
      name,
      path,
      type: directory ? "directory" : "file",
      ...(attachmentKind ? { kind: attachmentKind } : {}),
      ...(mimeType ? { mime_type: mimeType } : {}),
    })),
    null,
    2,
  )}`;
}

export function isSubagentPanelCommand(text: string, agent: string) {
  return (
    agent === "claude" && /^\/(?:agents|list-agents|tasks)$/.test(text.trim())
  );
}

const claudeCommandTitles: Record<string, string> = {
  compact: "压缩上下文",
  context: "上下文用量",
  usage: "使用情况",
  cost: "使用费用",
  clear: "清空上下文",
  init: "初始化项目",
  model: "选择模型",
  effort: "思考强度",
  mcp: "MCP 服务",
  config: "配置",
  fast: "快速模式",
  rename: "重命名会话",
  "output-style": "输出风格",
  "security-review": "安全审查",
  "code-review": "代码审查",
  "reload-plugins": "重新加载插件",
  "reload-skills": "重新加载技能",
  insights: "使用洞察",
  recap: "会话回顾",
  goal: "设置目标",
  agents: "管理智能体",
  "list-agents": "智能体列表",
};
export function commandTitle(
  command: AgentSlashCommand,
  agent: string,
): string {
  const label = command.display_name?.trim();
  if (label && label !== command.name) return label;
  if (agent === "claude" && claudeCommandTitles[command.name])
    return claudeCommandTitles[command.name];
  // Some skills expose their human title at the beginning of the description.
  // Use only a short explicit title; do not turn arbitrary prose into a label.
  const title = /^([^：:\n]{2,28})[：:]/u
    .exec(command.description)?.[1]
    ?.trim();
  if (title) return title;
  return command.name
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
