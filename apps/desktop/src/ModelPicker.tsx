import { useEffect, useState } from "react";
import { request, message } from "./api";
import { modelOptions } from "./modelOptions";
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
  disabled,
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
  disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog>();
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
        if (!disposed) setCatalog(result);
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
      onEffortChange(null);
  }, [catalog, effort, onEffortChange]);
  const options = modelOptions(catalog?.models ?? [], catalog?.model_labels);
  if (value && catalog && !catalog.models.includes(value))
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
          value={value ?? ""}
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
