import { useEffect, useState } from "react";
import { HostConnectionError } from "./connectionErrors";
import { Shield, ShieldAlert } from "lucide-react";
import { request, message } from "./api";
import { Select, type SelectOption } from "./Select";
import type { AgentPermissionMode } from "./protocol";
import { useStatusIssues } from "./statusNotices";

export function PermissionPicker({
  hostId,
  agent,
  connected,
  hidden,
  value,
  onChange,
  disabled,
}: {
  hostId: string;
  agent: string;
  connected: boolean;
  hidden: boolean;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const scope = JSON.stringify([hostId, agent]);
  const [loaded, setLoaded] = useState<{
    scope: string;
    modes: AgentPermissionMode[];
  }>();
  const [failure, setFailure] = useState<{ scope: string; message: string }>();
  const error = failure?.scope === scope ? failure.message : "";
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  useStatusIssues([
    {
      id: `permissions:${hostId}:${agent}`,
      title: "权限选项暂不可用",
      error: connected && !hidden ? error : "",
      pending: connected && !hidden && loading,
      action: {
        label: "重新加载权限选项",
        run: () => setRetry((value) => value + 1),
      },
    },
  ]);
  const modes = loaded?.scope === scope ? loaded.modes : undefined;
  useEffect(() => {
    if (!connected || hidden) return;
    let disposed = false;
    setLoaded(undefined);
    setFailure(undefined);
    setLoading(true);
    void request(hostId, { method: "agent_permissions", agent })
      .then((result) => {
        if (result.kind !== "agent_permissions")
          throw new Error("此 Server 不支持权限设置，请更新后重试");
        if (!disposed) setLoaded({ scope, modes: result.modes });
      })
      .catch((e) => {
        if (!disposed && !(e instanceof HostConnectionError))
          setFailure({ scope, message: message(e) });
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [hostId, agent, connected, hidden, retry]);
  const current = modes?.find((mode) => mode.id === value);
  const Icon = current?.elevated ? ShieldAlert : Shield;
  const options: SelectOption[] = [
    {
      value: "",
      label: "跟随 Agent",
      description: "沿用 Agent 自己的权限配置。",
    },
    ...(modes ?? []).map((mode) => ({
      value: mode.id,
      label: mode.label,
      description: mode.description,
      tone: mode.elevated ? ("warning" as const) : undefined,
    })),
  ];
  if (value && !current)
    options.push({
      value,
      label: modes ? "权限模式不可用" : value,
      description: "此选择尚未验证；可切换为跟随 Agent。",
    });
  return (
    <div
      className={"permission-picker" + (current?.elevated ? " elevated" : "")}
    >
      <Icon size={15} aria-hidden="true" />
      <Select
        label="Agent 权限"
        value={value ?? ""}
        options={options}
        onChange={(id) => onChange(id || null)}
        disabled={disabled || !connected || hidden || (!modes && !error)}
        minMenuWidth={340}
        menuTitle="如何批准 Agent 的操作？"
      />
    </div>
  );
}
