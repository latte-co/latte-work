import { useEffect, useState } from "react";
import { message, request } from "./api";
import type { Event } from "./protocol";

export function useSubagentTranscript(
  hostId: string,
  sessionId: string | undefined,
  taskId: string | undefined,
  active: boolean,
  running: boolean,
  revision?: number,
  connectionVersion = 0,
) {
  const scope = JSON.stringify([hostId, sessionId, taskId, connectionVersion]);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [state, setState] = useState({
    scope,
    events: [] as Event[],
    truncated: false,
    loading: false,
    error: "",
  });
  useEffect(() => {
    if (!active || !sessionId || !taskId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((old) =>
      old.scope === scope
        ? { ...old, loading: true }
        : { scope, events: [], truncated: false, loading: true, error: "" },
    );
    const read = async () => {
      try {
        const response = await request(hostId, {
          method: "subagent_transcript",
          session_id: sessionId,
          task_id: taskId,
        });
        if (response.kind !== "subagent_transcript")
          throw new Error("此 Server 不支持子智能体过程，请更新 Server");
        if (!disposed)
          setState({
            scope,
            events: response.events,
            truncated: response.truncated,
            loading: false,
            error: "",
          });
      } catch (cause) {
        const detail = message(cause);
        if (!disposed)
          setState((old) => ({
            ...old,
            scope,
            loading: false,
            error: detail.includes("unknown variant `subagent_transcript`")
              ? "此 Server 不支持子智能体过程，请更新 Server"
              : detail,
          }));
      } finally {
        if (!disposed && running) timer = setTimeout(() => void read(), 2000);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    scope,
    hostId,
    sessionId,
    taskId,
    active,
    running,
    revision,
    reloadVersion,
  ]);
  return {
    ...(state.scope === scope
      ? state
      : { scope, events: [], truncated: false, loading: active, error: "" }),
    reload: () => setReloadVersion((value) => value + 1),
  };
}
