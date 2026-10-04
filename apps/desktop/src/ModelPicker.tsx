import { useEffect, useState } from "react";
import { request, message } from "./api";
import { modelOptions } from "./modelOptions";
import { modelSelectionScope } from "./modelSelectionScope";
import { ModelSelector } from "./ModelSelector";
import type { Effort, Response } from "./protocol";

type Catalog = Extract<Response, { kind: "models" }>;
export function ModelPicker({
  hostId,
  projectId,
  agent,
  connected,
  settingsOpen,
  value,
  onChange,
  effort,
  onEffortChange,
  onEffortInvalid,
  disabled,
  onReadyChange,
}: {
  hostId: string;
  projectId?: string;
  agent: string;
  connected: boolean;
  settingsOpen: boolean;
  value: string | null;
  onChange: (model: string | null) => void;
  effort: Effort | null;
  onEffortChange: (effort: Effort | null) => void;
  onEffortInvalid?: () => void;
  disabled: boolean;
  onReadyChange?: (state: { scope: string; ready: boolean }) => void;
}) {
  const scope = JSON.stringify([hostId, projectId, agent, value]);
  const [loaded, setCatalog] = useState<{ scope: string; catalog: Catalog }>();
  const catalog = loaded?.scope === scope ? loaded.catalog : undefined;
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!connected || settingsOpen) return;
    let disposed = false;
    setCatalog(undefined);
    setError("");
    void request(hostId, {
      method: "models",
      agent,
      model: value,
      project_id: projectId ?? null,
    })
      .then((result) => {
        if (result.kind !== "models") throw new Error("无法加载模型列表");
        if (!disposed) setCatalog({ scope, catalog: result });
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      });
    return () => {
      disposed = true;
    };
  }, [hostId, projectId, agent, connected, settingsOpen, retry, value]);
  useEffect(() => {
    if (catalog && effort && !catalog.effort_levels.includes(effort))
      onEffortInvalid?.();
  }, [catalog, effort, onEffortInvalid]);
  const providerFallback =
    catalog?.provider != null && (!value || !catalog.models.includes(value))
      ? catalog.models.includes(catalog.default_model ?? "")
        ? catalog.default_model
        : (catalog.models[0] ?? null)
      : undefined;
  useEffect(() => {
    if (providerFallback !== undefined && providerFallback !== value)
      onChange(providerFallback);
  }, [providerFallback, value, onChange]);
  const readyScope = modelSelectionScope(
    hostId,
    projectId,
    agent,
    value,
    effort,
  );
  const ready =
    !!catalog &&
    providerFallback === undefined &&
    (!value || catalog.models.includes(value)) &&
    (!effort || catalog.effort_levels.includes(effort)) &&
    connected &&
    !settingsOpen;
  useEffect(() => {
    onReadyChange?.({ scope: readyScope, ready });
  }, [readyScope, ready, onReadyChange]);
  const options = modelOptions(
    catalog?.models ?? [],
    catalog?.model_labels,
  ).filter((option) => catalog?.provider == null || option.value !== "");
  if (
    value &&
    catalog &&
    catalog.provider == null &&
    !catalog.models.includes(value)
  )
    options.push({
      value,
      label: `${value} (unavailable)`,
    });
  return (
    <div className="model-picker">
      {error ? (
        <button
          className="model-picker-error"
          title={error}
          onClick={() => setRetry((v) => v + 1)}
        >
          重新加载模型
        </button>
      ) : (
        <ModelSelector
          value={providerFallback ?? value ?? ""}
          options={options}
          onChange={(id) => onChange(id || null)}
          effort={effort}
          levels={catalog?.effort_levels ?? []}
          onEffortChange={onEffortChange}
          disabled={disabled || settingsOpen || !connected || !catalog}
        />
      )}
    </div>
  );
}
