import { useCallback, useState } from "react";
import { message, request } from "./api";
import type { Event } from "./protocol";
import { LIVE_POLL_MS, usePollingSnapshot } from "./usePollingSnapshot";
const empty = { events: [] as Event[], truncated: false };

export function useSubagentTranscript(
  hostId: string,
  sessionId: string | undefined,
  taskId: string | undefined,
  active: boolean,
  running: boolean,
  revision?: number,
  connectionVersion = 0,
) {
  const scope = JSON.stringify([hostId, sessionId, taskId]);
  const [reloadVersion, setReloadVersion] = useState(0);
  const read = useCallback(async () => {
    try {
      const response = await request(hostId, {
        method: "subagent_transcript",
        session_id: sessionId!,
        task_id: taskId!,
      });
      if (response.kind !== "subagent_transcript")
        throw new Error("此 Server 不支持子智能体过程，请更新 Server");
      return { events: response.events, truncated: response.truncated };
    } catch (cause) {
      if (message(cause).includes("unknown variant `subagent_transcript`"))
        throw new Error("此 Server 不支持子智能体过程，请更新 Server");
      throw cause;
    }
  }, [hostId, sessionId, taskId]);
  const state = usePollingSnapshot(
    scope,
    active && !!sessionId && !!taskId,
    read,
    empty,
    JSON.stringify([revision, running, reloadVersion]),
    running ? LIVE_POLL_MS : 0,
    connectionVersion,
  );
  return {
    ...state.data,
    loading: state.loading,
    error: state.error,
    reload: () => setReloadVersion((v) => v + 1),
  };
}
