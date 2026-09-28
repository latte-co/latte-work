import { useEffect, useRef, useState } from "react";
import type { Effort, Session } from "./protocol";

type Selection = {
  model: string | null;
  effort: Effort | null;
  permissionMode: string | null;
};
const empty: Selection = { model: null, effort: null, permissionMode: null };
const levels = new Set(["low", "medium", "high", "xhigh", "max"]);
const key = (host: string, agent: string) =>
  `latte-work.agent-selection.v1:${JSON.stringify([host, agent])}`;

function read(host: string, agent: string): Selection {
  try {
    const raw = localStorage.getItem(key(host, agent));
    if (!raw || raw.length > 4096) return empty;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return empty;
    const { model, effort, permissionMode } = value as Partial<Selection>;
    return {
      model:
        typeof model === "string" &&
        model.trim() &&
        model.length <= 256 &&
        !/[\u0000-\u001f]/.test(model)
          ? model
          : null,
      effort: effort && levels.has(effort) ? effort : null,
      permissionMode:
        typeof permissionMode === "string" &&
        /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(permissionMode)
          ? permissionMode
          : null,
    };
  } catch {
    return empty;
  }
}

/** Remember explicit choices per host/agent, never infer an override from CLI defaults. */
export function useAgentPreferences(
  host: string,
  agent: string,
  projectId: string | undefined,
  session: Session | undefined,
  sending: boolean,
) {
  const initial = () =>
    session
      ? {
          model: session.model,
          effort: session.effort,
          permissionMode: session.permission_mode ?? null,
        }
      : read(host, agent);
  const [selection, setSelection] = useState<Selection>(initial);
  const [error, setError] = useState("");
  const source = JSON.stringify([
    host,
    agent,
    projectId,
    session?.id,
    session?.model,
    session?.effort,
    session?.permission_mode,
  ]);
  const previous = useRef(source);
  useEffect(() => {
    // Persisting the first prompt creates a Session before its send is accepted.
    // Keep the in-flight draft's choices until that transition is complete.
    if (previous.current === source) return;
    previous.current = source;
    if (!sending) {
      setSelection(initial());
      setError("");
    }
  }, [source, sending]);

  function choose(patch: Partial<Selection>) {
    setSelection((current) => ({ ...current, ...patch }));
    try {
      // Write only the field the user changed, preserving the other remembered choice.
      localStorage.setItem(
        key(host, agent),
        JSON.stringify({ ...read(host, agent), ...patch }),
      );
      setError("");
    } catch {
      setError("本次选择已生效，但无法保存；重启后可能丢失。");
    }
  }
  return {
    ...selection,
    error,
    chooseModel: (model: string | null) => choose({ model }),
    choosePermissionMode: (permissionMode: string | null) =>
      choose({ permissionMode }),
    chooseEffort: (effort: Effort | null) => choose({ effort }),
    // Capability refreshes are not user choices and must not erase remembered effort.
    clearUnsupportedEffort: () =>
      setSelection((current) => ({ ...current, effort: null })),
  };
}
