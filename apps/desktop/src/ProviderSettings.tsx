import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Select } from "./Select";
import { connect, localHost, message, request } from "./api";
import type {
  Provider,
  ProviderDraft,
  ProviderProtocol,
  Request,
  Response,
} from "./protocol";
type Catalog = Extract<Response, { kind: "providers" }>;
export const protocols: Record<ProviderProtocol, string> = {
  anthropic_messages: "Anthropic Messages",
  openai_chat: "OpenAI Chat Completions",
  openai_responses: "OpenAI Responses",
};
const empty = (): ProviderDraft => ({
  id: null,
  name: "",
  protocol: "anthropic_messages",
  base_url: "",
  model: "",
  models: [],
  auth: "bearer",
  credential: null,
});
export function ProviderSettings({
  active,
  onBusy,
}: {
  active: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!active) {
      setBusy(false);
      return;
    }
    setError("");
    const current = ++generation.current;
    setBusy(true);
    void connect(localHost)
      .then(async (hello) => {
        if (hello.kind !== "hello")
          throw new Error(
            hello.kind === "error" ? hello.message : "本机 Server 连接失败",
          );
        const result = await request("local", { method: "providers" });
        if (result.kind !== "providers") throw new Error("Provider 响应不匹配");
        if (current === generation.current) setCatalog(result);
      })
      .catch((e) => {
        if (current === generation.current) setError(message(e));
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [active]);
  async function mutate(value: Request) {
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const result = await request("local", value);
      if (result.kind !== "providers") throw new Error("Provider 响应不匹配");
      if (current === generation.current) {
        setCatalog(result);
        setDraft(null);
        setRemove(null);
      }
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      if (current === generation.current) setBusy(false);
    }
  }
  function edit(p: Provider) {
    setDraft({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      base_url: p.base_url,
      model: p.model,
      models: p.models,
      auth: p.auth,
      credential: null,
    });
    setRemove(null);
    setError("");
  }
  return (
    <div className="settings-panel-content">
      <h2>Provider</h2>
      <p>统一管理模型服务，在 Code Agent 设置中关联使用。</p>
      <p className="form-note">
        配置保存在本机。远程 Agent 关联时，通过 SSH 同步所需配置。
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {busy && !catalog && <p>正在加载…</p>}
      {catalog && (
        <>
          <div className="provider-list">
            {catalog.providers.length === 0 && !draft && (
              <p className="form-note">
                还没有 Provider，添加一个模型服务开始使用。
              </p>
            )}
            {catalog.providers.map((p) => (
              <div className="provider-entry" key={p.id}>
                <div className="provider-choice">
                  <span>
                    {p.name}
                    <small>
                      {protocols[p.protocol]} · {p.model}
                    </small>
                    <small>{p.base_url}</small>
                  </span>
                </div>
                <div className="provider-entry-actions">
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => edit(p)}
                  >
                    编辑
                  </button>
                  {!catalog.bindings.some((b) => b.provider_id === p.id) && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        remove === p.id
                          ? void mutate({
                              method: "delete_provider",
                              id: p.id,
                            })
                          : setRemove(p.id)
                      }
                    >
                      {remove === p.id ? "确认删除" : "删除"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {!draft ? (
            <button
              className="secondary wide"
              disabled={busy}
              onClick={() => {
                setDraft(empty());
                setError("");
              }}
            >
              <Plus size={16} />
              添加 Provider
            </button>
          ) : (
            <form
              className="provider-form"
              onSubmit={(e) => {
                e.preventDefault();
                void mutate({ method: "save_provider", provider: draft });
              }}
            >
              <h3>{draft.id ? "编辑 Provider" : "添加 Provider"}</h3>
              <fieldset disabled={busy}>
                <label>
                  名称
                  <input
                    autoFocus
                    required
                    maxLength={80}
                    placeholder="例如：团队模型服务"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  接口协议
                  <Select
                    label="接口协议"
                    value={draft.protocol}
                    options={Object.entries(protocols).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    disabled={busy}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        protocol: value as ProviderProtocol,
                      })
                    }
                  />
                </label>
                <label>
                  Base URL
                  <input
                    type="url"
                    required
                    placeholder={
                      draft.protocol === "anthropic_messages"
                        ? "https://api.example.com"
                        : "https://api.example.com/v1"
                    }
                    value={draft.base_url}
                    onChange={(e) =>
                      setDraft({ ...draft, base_url: e.target.value })
                    }
                  />
                </label>
                <label>
                  默认模型 ID
                  <input
                    required
                    maxLength={256}
                    placeholder="服务端提供的完整模型 ID"
                    value={draft.model}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value })
                    }
                  />
                </label>
                <label>
                  认证方式
                  <Select
                    label="认证方式"
                    value={draft.auth}
                    options={[
                      { value: "bearer", label: "Bearer Token" },
                      { value: "api_key", label: "API Key（x-api-key）" },
                    ]}
                    disabled={busy}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        auth: value as ProviderDraft["auth"],
                      })
                    }
                  />
                </label>
                <label className="provider-models-field">
                  可选模型 ID（每行一个）
                  <textarea
                    aria-label="可选模型 ID"
                    placeholder="例如：claude-sonnet-5\nclaude-opus-5"
                    value={draft.models.join("\n")}
                    onChange={(e) =>
                      setDraft({ ...draft, models: e.target.value.split("\n") })
                    }
                    rows={3}
                  />
                  <small>
                    默认模型自动包含在选择列表中。填写此服务实际支持的模型 ID。
                  </small>
                </label>
                <label>
                  凭据
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    required={!draft.id}
                    placeholder={
                      draft.id
                        ? "已保存，留空保持不变"
                        : "输入 API Key 或 Token"
                    }
                    value={draft.credential ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        credential: e.target.value || null,
                      })
                    }
                  />
                </label>
                <p className="form-note">
                  更改地址或认证方式时，请重新填写凭据。修改后可在 Code Agent
                  设置中重新同步到远端。
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setDraft(null)}
                  >
                    取消
                  </button>
                  <button className="primary" type="submit">
                    {busy ? "正在保存…" : "保存 Provider"}
                  </button>
                </div>
              </fieldset>
            </form>
          )}
        </>
      )}
    </div>
  );
}
