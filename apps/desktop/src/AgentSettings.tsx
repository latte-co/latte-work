import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Monitor } from "lucide-react";
import { connect, localHost, message, request } from "./api";
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
  const [local, setLocal] = useState<Catalog>();
  const [remote, setRemote] = useState<Catalog>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [serverId, setServerId] = useState("");
  const generation = useRef(0);
  const host = state.hosts.find((h) => h.id === hostId)!;
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
    setLocal(undefined);
    setRemote(undefined);
    setAgents([]);
    void (async () => {
      const [hello, home] = await Promise.all([
        connect(host),
        connect(localHost),
      ]);
      if (hello.kind !== "hello" || home.kind !== "hello")
        throw new Error("无法读取 Agent，请检查主机连接和 Server 版本");
      if (current !== generation.current) return;
      setServerId(hello.server_id);
      const [catalog, target] = await Promise.all([
        request("local", { method: "providers" }),
        request(host.id, { method: "providers" }),
      ]);
      if (catalog.kind !== "providers" || target.kind !== "providers")
        throw new Error("Provider 响应不匹配");
      if (current !== generation.current) return;
      setAgents(hello.agents);
      setLocal(catalog);
      setRemote(target);
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
      const result = await request("local", {
        method: "bind_agent_provider",
        agent,
        provider_id: choices[agent] || null,
        target: host.ssh
          ? { ssh: host.ssh, server_path: host.server_path! }
          : null,
      });
      if (result.kind !== "providers") throw new Error("关联响应不匹配");
      if (current === generation.current) {
        setRemote(result);
        setNotice(
          host.ssh
            ? "已同步并关联；下次执行生效。"
            : "关联已保存；下次执行生效。",
        );
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
          value={hostId}
          options={state.hosts.map((h) => ({ value: h.id, label: h.name }))}
          disabled={busy}
          onChange={setHostId}
        />
      </label>
      <div className="settings-connection">
        <Monitor size={18} />
        <div>
          <strong>{host.name}</strong>
          <small>
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
      {busy && !local && <p>正在加载…</p>}
      {local &&
        remote &&
        agents.map((agent) => {
          const binding = remote.bindings.find((b) => b.agent === agent.id);
          const original = local.providers.find(
            (p) => p.id === binding?.provider_id,
          );
          const currentCopy = remote.providers.find(
            (p) => p.id === binding?.provider_id,
          );
          const compatible = local.providers.filter((p) =>
            agent.provider_protocols.includes(p.protocol),
          );
          const stale =
            !!host.ssh &&
            !!binding &&
            original?.revision !== binding.provider_revision;
          const missing =
            !!binding && !compatible.some((p) => p.id === binding.provider_id);
          const options = [
            { value: "", label: "沿用 Agent CLI 配置" },
            ...compatible.map((p) => ({
              value: p.id,
              label: p.name,
              description: p.model,
            })),
          ];
          if (missing)
            options.push({
              value: binding.provider_id,
              label: `${currentCopy?.name ?? "旧 Provider"}（需重新关联）`,
            });
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
                {host.ssh
                  ? "关联时将地址、模型和凭据通过 SSH 同步到此主机。"
                  : "使用本机统一管理的 Provider。"}
              </p>
              {stale && (
                <p className="agent-sync-note">
                  {original
                    ? "本机配置已更新，远端待同步。"
                    : "此 Provider 已从本机删除，远端仍保留旧副本；请重新关联或恢复 CLI 配置。"}
                </p>
              )}
              <button
                className="primary wide"
                disabled={
                  busy ||
                  (!!choices[agent.id] &&
                    !compatible.some((p) => p.id === choices[agent.id]))
                }
                onClick={() => void bind(agent.id)}
              >
                {busy ? "正在保存…" : host.ssh ? "同步并关联" : "保存关联"}
              </button>
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
