import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Monitor, LoaderCircle } from "lucide-react";
import {
  agentProviders,
  bindAgentProvider,
  connect,
  localHost,
  message,
} from "./api";
import { Select } from "./Select";
import { protocols } from "./ProviderSettings";
import type { AgentInfo, Response } from "./protocol";
import type { Workbench } from "./useWorkbench";
type Catalog = Extract<Response, { kind: "providers" }>;
export function AgentSettings({
  state,
  active,
  onBusy,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [hostId, setHostId] = useState(state.host.id);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [serverId, setServerId] = useState("");
  const generation = useRef(0);
  const host = state.hosts.find((h) => h.id === hostId) ?? localHost;
  useEffect(() => {
    if (!active) {
      setBusy(false);
      return;
    }
    setServerId("");
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setCatalog(undefined);
    setAgents([]);
    void (async () => {
      const [hello, target] = await Promise.all([
        connect(host),
        agentProviders(host.id),
      ]);
      if (hello.kind !== "hello")
        throw new Error("无法读取 Agent，请检查主机连接和 Server 版本");
      if (current !== generation.current) return;
      setServerId(hello.server_id);
      if (target.kind !== "providers") throw new Error("Provider 响应不匹配");
      if (current !== generation.current) return;
      setAgents(hello.agents);
      setCatalog(target);
      setChoices(
        Object.fromEntries(
          target.bindings.map((b) => [b.agent, b.provider_id]),
        ),
      );
    })()
      .catch((e) => {
        if (current === generation.current) setError(message(e));
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [host, active, retry]);
  async function bind(agent: string) {
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bindAgentProvider(
        host.id,
        agent,
        choices[agent] || null,
      );
      if (result.kind !== "providers") throw new Error("关联响应不匹配");
      if (current === generation.current) {
        setCatalog(result);
        setNotice("关联已保存；下次发送消息时使用最新配置。");
      }
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <div className="settings-panel-content">
      <h2>连接与 Agent</h2>
      <p>选择运行主机，查看连接状态并为 Code Agent 关联 Provider。</p>
      <label>
        运行主机
        <Select
          label="运行主机"
          value={host.id}
          options={state.hosts.map((h) => ({ value: h.id, label: h.name }))}
          disabled={busy}
          onChange={setHostId}
        />
      </label>
      <div className="settings-connection">
        {busy && !serverId ? (
          <LoaderCircle size={18} className="spin" />
        ) : (
          <Monitor size={18} />
        )}
        <div>
          <strong>{host.name}</strong>
          <small
            data-state={
              busy && !serverId ? "pending" : serverId ? "connected" : "error"
            }
          >
            {busy && !serverId
              ? "正在连接…"
              : serverId
                ? "Server 已连接"
                : "连接中断"}
          </small>
        </div>
        {serverId && <Check size={16} />}
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setRetry((v) => v + 1)}
        >
          <RefreshCw size={14} />
          重新连接
        </button>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="agent-notice" role="status">
          {notice}
        </p>
      )}
      {busy && !catalog && <p>正在加载…</p>}
      {catalog &&
        agents.map((agent) => {
          const compatible = catalog.providers.filter((p) =>
            agent.provider_protocols.includes(p.protocol),
          );
          const options = [
            { value: "", label: "沿用 Agent CLI 配置" },
            ...compatible.map((p) => ({
              value: p.id,
              label: p.name,
              description: p.model,
            })),
          ];
          const saved =
            catalog.bindings.find((b) => b.agent === agent.id)?.provider_id ||
            "";
          const dirty = (choices[agent.id] || "") !== saved;
          const provider = catalog.providers.find((p) => p.id === saved);
          return (
            <div className="agent-card" key={agent.id}>
              <h3>{agent.name}</h3>
              <p className="form-note">{agent.detail}</p>
              <label>
                关联 Provider
                <Select
                  label={`${agent.name} 关联 Provider`}
                  value={choices[agent.id] || ""}
                  options={options}
                  disabled={busy}
                  onChange={(id) => setChoices({ ...choices, [agent.id]: id })}
                />
              </label>
              <p className="form-note">
                支持{" "}
                {agent.provider_protocols.map((p) => protocols[p]).join("、")}。
                {provider
                  ? `当前使用 App 中的 ${provider.name}，每轮发送时读取最新配置。`
                  : `当前使用 ${host.name} 上的 Agent CLI 配置。`}
                {dirty && " 新选择尚未保存。"}
              </p>
              <div className="modal-actions">
                <span className="form-note" role="status">
                  {dirty ? "有未保存的修改" : "已保存"}
                </span>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !dirty ||
                    (!!choices[agent.id] &&
                      !compatible.some((p) => p.id === choices[agent.id]))
                  }
                  onClick={() => void bind(agent.id)}
                >
                  {busy ? "正在保存…" : "保存关联"}
                </button>
              </div>
            </div>
          );
        })}
      <p className="form-note">
        未关联 Provider 时，沿用此主机的 Agent CLI
        配置。关闭设置或桌面窗口不会停止正在执行的任务。
      </p>
      {serverId && (
        <details className="settings-details">
          <summary>连接详情</summary>
          <div className="server-identity">
            Server 实例<span>{serverId}</span>
          </div>
        </details>
      )}
    </div>
  );
}
