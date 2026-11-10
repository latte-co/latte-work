import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Monitor, LoaderCircle } from "lucide-react";
import {
  agentProviders,
  agentEnvironments,
  saveAgentEnvironment,
  bindAgentProvider,
  connect,
  localHost,
  message,
} from "./api";
import { Select } from "./Select";
import { protocols } from "./ProviderSettings";
import { formatEnvironment, parseEnvironment } from "./agentEnvironment";
import type { AgentEnvironment, AgentInfo, Response } from "./protocol";
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
  const [environments, setEnvironments] = useState<
    Record<string, AgentEnvironment>
  >({});
  const [environmentDrafts, setEnvironmentDrafts] = useState<
    Record<string, string>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [serverId, setServerId] = useState("");
  const [environmentSupported, setEnvironmentSupported] = useState(false);
  const generation = useRef(0);
  const host = state.hosts.find((h) => h.id === hostId) ?? localHost;
  useEffect(() => {
    if (!active) {
      setBusy(false);
      return;
    }
    setServerId("");
    setEnvironmentSupported(false);
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setCatalog(undefined);
    setAgents([]);
    void (async () => {
      const [hello, target, savedEnvironments] = await Promise.all([
        connect(host),
        agentProviders(host.id),
        agentEnvironments(host.id),
      ]);
      if (hello.kind !== "hello")
        throw new Error("无法读取 Agent，请检查主机连接和 Server 版本");
      if (current !== generation.current) return;
      setServerId(hello.server_id);
      setEnvironmentSupported(hello.custom_agent_environment === true);
      if (target.kind !== "providers") throw new Error("Provider 响应不匹配");
      if (current !== generation.current) return;
      setAgents(hello.agents);
      setCatalog(target);
      setEnvironments(savedEnvironments);
      setEnvironmentDrafts(
        Object.fromEntries(
          Object.entries(savedEnvironments).map(([agent, env]) => [
            agent,
            formatEnvironment(env),
          ]),
        ),
      );
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
  async function saveEnvironment(agent: string) {
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveAgentEnvironment(
        host.id,
        agent,
        parseEnvironment(environmentDrafts[agent] || ""),
      );
      if (current === generation.current) {
        setEnvironments((values) => ({ ...values, [agent]: saved }));
        setEnvironmentDrafts((values) => ({
          ...values,
          [agent]: formatEnvironment(saved),
        }));
        setNotice(
          "环境变量已保存；下次启动 Agent 实例时生效，正在执行的任务继续使用原配置。",
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
      <p>选择运行主机，为 Code Agent 配置 Provider 和环境变量。</p>
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
          const environmentText = environmentDrafts[agent.id] || "";
          const environmentDirty =
            environmentText !== formatEnvironment(environments[agent.id] || {});
          let environmentError = "";
          try {
            parseEnvironment(environmentText);
          } catch (e) {
            environmentError = message(e);
          }
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
                  disabled={busy || !agent.provider_protocols.length}
                  onChange={(id) => setChoices({ ...choices, [agent.id]: id })}
                />
              </label>
              <p className="form-note">
                {agent.provider_protocols.length
                  ? `支持 ${agent.provider_protocols.map((p) => protocols[p]).join("、")}。`
                  : "暂不支持 App Provider 关联。"}
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
              <div className="agent-environment">
                <label>
                  自定义环境变量（ENV）
                  <textarea
                    aria-label={`${agent.name} 环境变量`}
                    aria-describedby={`environment-note-${agent.id}`}
                    aria-invalid={!!environmentError}
                    rows={4}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    value={environmentText}
                    disabled={busy || !environmentSupported}
                    placeholder={
                      "HTTPS_PROXY=http://127.0.0.1:7890\nHTTP_PROXY=http://127.0.0.1:7890\nNO_PROXY=localhost,127.0.0.1"
                    }
                    onChange={(event) =>
                      setEnvironmentDrafts((values) => ({
                        ...values,
                        [agent.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <p className="form-note" id={`environment-note-${agent.id}`}>
                  每行 NAME=value，值按原文传入，无需 export 或引号。仅用于{" "}
                  {host.name} 上的 {agent.name}
                  ；留空可恢复继承环境。代理地址须能从该主机访问。
                </p>
                {!environmentSupported && (
                  <p className="form-note">
                    此主机需要更新 Server 并重新连接，才能配置自定义环境变量。
                  </p>
                )}
                {environmentError && (
                  <div className="form-error" role="alert">
                    {environmentError}
                  </div>
                )}
                <div className="modal-actions">
                  <span className="form-note" role="status">
                    {environmentDirty ? "有未保存的环境变量" : "环境变量已保存"}
                  </span>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !environmentSupported ||
                      !environmentDirty ||
                      !!environmentError
                    }
                    onClick={() => void saveEnvironment(agent.id)}
                  >
                    保存环境变量
                  </button>
                </div>
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
