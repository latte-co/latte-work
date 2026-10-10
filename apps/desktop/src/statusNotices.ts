import { useEffect, useRef, useSyncExternalStore } from "react";

export interface StatusNotice {
  id: string;
  level: "error" | "warning" | "info" | "success";
  title: string;
  detail: string;
  pending?: boolean;
  action?: { label: string; run: () => void | Promise<unknown> };
}

export interface StatusIssue {
  id: string;
  title: string;
  error: string;
  level?: StatusNotice["level"];
  pending?: boolean;
  action?: StatusNotice["action"];
}
/** A retry retains the previous failure until it actually succeeds. */
export function useStatusIssues(issues: StatusIssue[]) {
  const previous = useRef(new Map<string, StatusNotice>());
  const next = new Map<string, StatusNotice>();
  for (const issue of issues) {
    const old = previous.current.get(issue.id);
    if (issue.error)
      next.set(issue.id, {
        id: issue.id,
        title: issue.title,
        detail: issue.error,
        level: issue.level ?? "error",
        pending: issue.pending,
        action: issue.action,
      });
    else if (issue.pending && old)
      next.set(issue.id, { ...old, pending: true, action: issue.action });
  }
  useEffect(() => {
    previous.current = next;
  });
  useStatusNotices([...next.values()]);
}

const sources = new Map<symbol, StatusNotice[]>();
const listeners = new Set<() => void>();
const priority = { error: 0, warning: 1, info: 2, success: 3 };
let snapshot: { notices: StatusNotice[]; total: number } = {
  notices: [],
  total: 0,
};
function publish() {
  const unique = new Map<string, StatusNotice>();
  for (const notices of sources.values())
    for (const notice of notices) unique.set(notice.id, notice);
  snapshot = {
    notices: [...unique.values()]
      .sort((a, b) => priority[a.level] - priority[b.level])
      .slice(0, 100),
    total: unique.size,
  };
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useStatusSnapshot() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Active states only: no persisted notification history and no automatic actions. */
export function useStatusNotices(notices: StatusNotice[]) {
  const owner = useRef(Symbol("status-source")).current;
  const latest = useRef(notices);
  latest.current = notices;
  const signature = JSON.stringify(
    notices.map(({ action, ...notice }) => ({
      ...notice,
      action: action?.label,
    })),
  );
  useEffect(() => {
    sources.set(
      owner,
      latest.current.slice(0, 100).map((notice) => ({
        ...notice,
        title: notice.title.slice(0, 200),
        detail: notice.detail.slice(0, 4000),
        action: notice.action
          ? {
              label: notice.action.label,
              run: () =>
                latest.current
                  .find((value) => value.id === notice.id)
                  ?.action?.run(),
            }
          : undefined,
      })),
    );
    publish();
  }, [owner, signature]);
  useEffect(
    () => () => {
      sources.delete(owner);
      publish();
    },
    [owner],
  );
}
