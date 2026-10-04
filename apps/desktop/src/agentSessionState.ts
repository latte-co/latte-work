import type { Session } from "./protocol";
export type AgentSessionState =
  "closed" | "open" | "opening" | "restoring" | "unknown" | "error";
export type AgentSessionTransition = {
  phase: "opening" | "restoring" | "error";
  error?: string;
};
export const agentSessionKey = (host: string, id: string) =>
  JSON.stringify([host, id]);
export function agentSessionState(
  session: Session,
  connected: boolean,
  transition?: AgentSessionTransition,
  selected = false,
): AgentSessionState {
  if (!connected)
    return session.agent_session_open === true || transition || selected
      ? "unknown"
      : "closed";
  if (transition?.phase === "opening" || transition?.phase === "restoring")
    return transition.phase;
  if (session.agent_session_open === true) return "open";
  if (transition) return transition.phase;
  return session.agent_session_open === undefined && selected
    ? "unknown"
    : "closed";
}
export const agentSessionLabels: Record<AgentSessionState, string> = {
  closed: "Agent 会话已关闭",
  open: "Agent 会话已打开",
  opening: "正在打开",
  restoring: "正在恢复",
  unknown: "会话状态待确认",
  error: "会话打开失败",
};
