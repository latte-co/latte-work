import { useEffect, useRef, useState } from "react";
import { message, request } from "./api";
import type { RecentCursor, RecentSession } from "./protocol";

class UnsupportedRecentHistory extends Error {}

export interface RecentHost {
  sessions: RecentSession[];
  next: RecentCursor | null;
  loaded: boolean;
  loading: boolean;
  error: string;
  errorKind: "initial" | "refresh" | "more" | "unsupported" | null;
}
export function useRecentSessions(
  readyHostIds: string[],
  active: boolean,
  connectionVersions: Record<string, number> = {},
) {
  const [hosts, setHosts] = useState<Record<string, RecentHost>>({});
  const readers = useRef(new Map<string, (more?: boolean) => Promise<void>>());
  const depths = useRef(new Map<string, number>());
  const scope = JSON.stringify(
    readyHostIds.map((id) => [id, connectionVersions[id] ?? 0]),
  );
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const targets = (JSON.parse(scope) as [string, number][]).map(([id]) => id);
    for (const hostId of targets) {
      let pending = false;
      let reloadQueued = false;
      const read = async (more = false) => {
        if (disposed) return;
        if (pending) {
          if (!more) reloadQueued = true;
          return;
        }
        pending = true;
        clearTimeout(timers.get(hostId));
        const depth = (depths.current.get(hostId) ?? 1) + (more ? 1 : 0);
        depths.current.set(hostId, depth);
        setHosts((previous) => ({
          ...previous,
          [hostId]: {
            ...(previous[hostId] ?? {
              sessions: [],
              next: null,
              loaded: false,
              error: "",
              errorKind: null,
            }),
            loading: true,
          },
        }));
        let retryAutomatically = true;
        try {
          const sessions: RecentSession[] = [];
          let next: RecentCursor | null = null;
          for (let page = 0; page < depth; page++) {
            const result = await request(hostId, {
              method: "recent_sessions",
              before: next,
            });
            if (disposed) return;
            if (result.kind !== "recent_sessions")
              throw new UnsupportedRecentHistory();
            if (
              result.next &&
              JSON.stringify(result.next) === JSON.stringify(next)
            )
              throw new Error("最近记录分页未前进，请重试");
            sessions.push(...result.sessions);
            next = result.next;
            if (!next) break;
          }
          depths.current.set(hostId, depth);
          setHosts((previous) => ({
            ...previous,
            [hostId]: {
              sessions,
              next,
              loaded: true,
              loading: false,
              error: "",
              errorKind: null,
            },
          }));
        } catch (cause) {
          const detail = message(cause);
          const unsupported =
            cause instanceof UnsupportedRecentHistory ||
            detail.includes("unknown variant `recent_sessions`");
          retryAutomatically = !unsupported;
          if (!disposed)
            setHosts((previous) => ({
              ...previous,
              [hostId]: {
                ...(previous[hostId] ?? {
                  sessions: [],
                  next: null,
                  loaded: false,
                }),
                loading: false,
                error: unsupported
                  ? "此主机的 Server 不支持最近记录，请更新 Server 后重试"
                  : detail,
                errorKind: unsupported
                  ? "unsupported"
                  : more
                    ? "more"
                    : previous[hostId]?.loaded
                      ? "refresh"
                      : "initial",
              },
            }));
        } finally {
          pending = false;
          if (!disposed) {
            if (reloadQueued) {
              reloadQueued = false;
              void read();
            } else if (retryAutomatically)
              timers.set(
                hostId,
                setTimeout(() => void read(), 5000),
              );
          }
        }
      };
      readers.current.set(hostId, read);
      void read();
    }
    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      targets.forEach((hostId) => readers.current.delete(hostId));
    };
  }, [scope, active]);
  return {
    hosts,
    reload: (hostId: string) => void readers.current.get(hostId)?.(),
    more: (hostId: string) => void readers.current.get(hostId)?.(true),
  };
}
