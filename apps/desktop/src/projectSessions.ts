import { request, message } from "./api";
import type { Session } from "./protocol";
export type CloseProjectResult = {
  closed: string[];
  failed: { session: Session; error: string }[];
};
export async function openProjectSessions(
  host: string,
  project: string,
): Promise<Session[]> {
  const result = await request(host, {
    method: "sessions",
    project_id: project,
  });
  if (result.kind !== "sessions") throw new Error("无法读取项目会话状态");
  if (result.sessions.some((s) => s.agent_session_open === undefined))
    throw new Error("当前 Server 未提供会话状态，请更新 Server 后重试");
  return result.sessions.filter((s) => s.agent_session_open === true);
}
export function needsCloseConfirmation(sessions: Session[]): boolean {
  return sessions.some(
    (s) =>
      s.agent_session_busy !== false ||
      ["running", "waiting", "unknown"].includes(s.status),
  );
}
export async function closeProjectSessions(
  host: string,
  project: string,
  sessions: Session[],
  close: (host: string, id: string) => Promise<unknown>,
): Promise<CloseProjectResult> {
  const result: CloseProjectResult = { closed: [], failed: [] };
  for (const session of sessions) {
    if (session.project_id !== project) throw new Error("会话不属于此项目");
    if (
      result.closed.includes(session.id) ||
      result.failed.some((item) => item.session.id === session.id)
    )
      continue;
    try {
      await close(host, session.id);
      result.closed.push(session.id);
    } catch (error) {
      result.failed.push({ session, error: message(error) });
    }
  }
  return result;
}
