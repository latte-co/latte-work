import { useEffect, useState } from "react";
import { message, request } from "./api";
import type { Event, Subagent } from "./protocol";

export interface SubagentsState {
  tasks: Subagent[];
  loading: boolean;
  error: string;
  truncated: boolean;
}
export function useSubagents(
  hostId: string,
  sessionId: string | undefined,
  connected: boolean,
  events: Event[],
): SubagentsState {
  const scope = JSON.stringify([hostId, sessionId]);
  const revision = events
    .filter((e) => e.session_id === sessionId && e.event.kind === "subagent")
    .at(-1)?.seq;
  const [state, setState] = useState<SubagentsState & { scope: string }>({
    scope,
    tasks: [],
    loading: false,
    error: "",
    truncated: false,
  });
  useEffect(() => {
    if (!sessionId || !connected) return;
    let disposed = false;
    setState((old) =>
      old.scope === scope
        ? { ...old, loading: !old.tasks.length, error: "" }
        : { scope, tasks: [], loading: true, error: "", truncated: false },
    );
    void request(hostId, { method: "subagents", session_id: sessionId })
      .then((response) => {
        if (response.kind !== "subagents")
          throw new Error("此 Server 不支持子智能体列表，请更新 Server");
        if (!disposed)
          setState({
            scope,
            tasks: response.tasks,
            truncated: response.truncated,
            loading: false,
            error: "",
          });
      })
      .catch((cause) => {
        if (!disposed)
          setState((old) => ({
            ...old,
            scope,
            loading: false,
            error: message(cause),
          }));
      });
    return () => {
      disposed = true;
    };
  }, [scope, hostId, sessionId, connected, revision]);
  if (!sessionId || state.scope !== scope)
    return {
      tasks: [],
      loading: !!sessionId && connected,
      error: "",
      truncated: false,
    };
  return {
    ...state,
    tasks: connected
      ? state.tasks
      : state.tasks.map((task) =>
          ["running", "paused"].includes(task.status)
            ? { ...task, status: "unknown" as const }
            : task,
        ),
  };
}
