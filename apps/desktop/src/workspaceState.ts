import { useSyncExternalStore } from "react";
import type { Project, TerminalInfo } from "./protocol";

export type WorkspaceTab = {
  hostId?: string;
  hostName?: string;
  project?: Project;
} & (
  | { id: string; kind: "files" | "diff"; path?: string; file?: string }
  | { id: string; kind: "terminal"; terminal: TerminalInfo }
);
export interface WorkspaceState {
  tabs: WorkspaceTab[];
  current: string;
  visible: boolean;
  expanded: boolean;
  width: number;
}
const prefix = "latte-work.conversation-workspace.v1:";
const cache = new Map<string, WorkspaceState>();
const listeners = new Set<() => void>();
export function workspaceKey(conversation: string) {
  return conversation;
}
export function readWorkspace(key: string): WorkspaceState {
  const cached = cache.get(key);
  if (cached) return cached;
  let state: WorkspaceState = {
    tabs: [],
    current: "",
    visible: true,
    expanded: false,
    width: 350,
  };
  try {
    let serialized = localStorage.getItem(prefix + key);
    // Preserve preview state written by the earlier host/project-scoped build.
    if (serialized === null) {
      for (let i = 0; i < localStorage.length; i++) {
        const oldKey = localStorage.key(i);
        if (!oldKey?.startsWith(prefix + "[")) continue;
        try {
          const scope = JSON.parse(oldKey.slice(prefix.length));
          if (Array.isArray(scope) && scope.length === 3 && scope[2] === key) {
            serialized = localStorage.getItem(oldKey);
            if (serialized !== null)
              localStorage.setItem(prefix + key, serialized);
            break;
          }
        } catch {
          /* Ignore unrelated or invalid legacy entries. */
        }
      }
    }
    const saved = JSON.parse(serialized ?? "null");
    if (saved && Array.isArray(saved.tabs)) {
      const ids = new Set<string>();
      const tabs: WorkspaceTab[] = saved.tabs.filter((tab: WorkspaceTab) => {
        if (!tab || typeof tab.id !== "string" || ids.has(tab.id)) return false;
        const valid =
          tab.kind === "files" || tab.kind === "diff"
            ? (tab.path === undefined || typeof tab.path === "string") &&
              (tab.file === undefined || typeof tab.file === "string")
            : tab.kind === "terminal" &&
              tab.terminal?.id === tab.id &&
              typeof tab.terminal.project_id === "string" &&
              typeof tab.terminal.title === "string";
        if (valid) ids.add(tab.id);
        return valid;
      });
      state = {
        tabs,
        current: tabs.some((t) => t.id === saved.current)
          ? saved.current
          : (tabs.at(-1)?.id ?? ""),
        visible: saved.visible !== false,
        expanded: saved.expanded === true,
        width:
          typeof saved.width === "number" && Number.isFinite(saved.width)
            ? Math.max(280, Math.min(600, saved.width))
            : 350,
      };
    }
  } catch {
    /* Invalid or unavailable storage falls back to a new empty sidebar. */
  }
  cache.set(key, state);
  return state;
}
export function updateWorkspace(
  key: string,
  update:
    | Partial<WorkspaceState>
    | ((state: WorkspaceState) => Partial<WorkspaceState>),
) {
  const previous = readWorkspace(key);
  const next = {
    ...previous,
    ...(typeof update === "function" ? update(previous) : update),
  };
  if (!next.tabs.some((tab) => tab.id === next.current))
    next.current = next.tabs.at(-1)?.id ?? "";
  cache.set(key, next);
  try {
    localStorage.setItem(prefix + key, JSON.stringify(next));
  } catch {
    /* Keep in-memory state if storage is unavailable. */
  }
  listeners.forEach((listener) => listener());
}
export function copyWorkspace(from: string, to: string) {
  // The first submitted message turns a draft into a persisted conversation.
  updateWorkspace(to, readWorkspace(from));
}
export function useWorkspaceState(key: string) {
  const state = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => readWorkspace(key),
  );
  return [
    state,
    (update: Parameters<typeof updateWorkspace>[1]) =>
      updateWorkspace(key, update),
  ] as const;
}
