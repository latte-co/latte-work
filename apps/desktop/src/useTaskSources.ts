import { useEffect, useState } from "react";
import { message, request } from "./api";
import type { Event, TaskSource } from "./protocol";
import { attachmentKind, type ComposerReference } from "./pasteAttachments";
export interface SourceItem extends ComposerReference {
  sourceKind?: "tool" | "connector";
  tools?: string[];
  uses?: number;
}
export function sourceItem(source: TaskSource): SourceItem {
  return {
    name: source.name,
    path: source.path ?? source.id,
    directory: source.kind === "directory",
    mimeType: source.mime_type ?? undefined,
    ...(source.kind === "tool" || source.kind === "connector"
      ? { sourceKind: source.kind, tools: source.tools, uses: source.uses }
      : {
          attachmentKind: attachmentKind(source.name, source.mime_type ?? ""),
        }),
  };
}
export function useTaskSources(
  hostId: string,
  sessionId: string | undefined,
  connected: boolean,
  events: Event[],
) {
  const scope = `${hostId}:${sessionId}`;
  const [state, setState] = useState<{
    scope: string;
    entries: SourceItem[];
    error: string;
    truncated: boolean;
  }>({ scope, entries: [], error: "", truncated: false });
  const revision = events
    .filter((e) => ["user", "tool", "subagent"].includes(e.event.kind))
    .at(-1)?.seq;
  useEffect(() => {
    let disposed = false;
    if (!sessionId || !connected) return;
    const timer = setTimeout(
      () =>
        void request(hostId, { method: "sources", session_id: sessionId })
          .then((response) => {
            if (response.kind !== "sources")
              throw new Error("Server 不支持来源列表，请更新后重试");
            if (!disposed)
              setState({
                scope,
                entries: response.entries.map(sourceItem),
                error: "",
                truncated: response.truncated,
              });
          })
          .catch((cause) => {
            if (!disposed)
              setState((previous) => ({
                scope,
                entries: previous.scope === scope ? previous.entries : [],
                truncated: previous.scope === scope && previous.truncated,
                error: message(cause),
              }));
          }),
      80,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [scope, hostId, sessionId, connected, revision]);
  return state.scope === scope
    ? state
    : { scope, entries: [], error: "", truncated: false };
}
