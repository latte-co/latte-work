import type { Session } from "./protocol";

/** Background refresh must not navigate away from an unsaved conversation. */
export function sessionAfterRefresh(
  current: string,
  requested: string | null,
  sessions: Session[],
  draft: boolean,
): string {
  if (draft) return "";
  return requested ?? (current || sessions.find((s) => !s.archived)?.id || "");
}
