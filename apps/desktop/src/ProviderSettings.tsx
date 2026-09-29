import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Select } from "./Select";
import { message, providerRequest, type ProviderRequest } from "./api";
import type {
  Provider,
  ProviderDraft,
  ProviderProtocol,
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
  const baseline = useRef<string>("");
  const [notice, setNotice] = useState("");
  const dirty = !!draft && JSON.stringify(draft) !== baseline.current;
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
    void providerRequest({ method: "providers" })
      .then((result) => {
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
  async function mutate(value: ProviderRequest) {
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const result = await providerRequest(value);
      if (result.kind !== "providers") throw new Error("Provider 响应不匹配");
      if (current === generation.current) {
        setCatalog(result);
        setDraft(null);
        setRemove(null);
        setNotice(
          value.method === "save_provider"
            ? "Provider 已保存；下次发送时生效。"
            : "Provider 已移除。",
        );
      }
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      if (current === generation.current) setBusy(false);
    }
  }
  function edit(p: Provider) {
    const next: ProviderDraft = {
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      base_url: p.base_url,
      model: p.model,
      models: p.models,
      auth: p.auth,
      credential: null,
    };
    baseline.current = JSON.stringify(next);
    setDraft(next);
    setNotice("");
    setRemove(null);
    setError("");
  }
  return (
    <div className="settings-panel-content provider-settings">
      <h2>模型服务</h2>
      <p>配置模型服务，并在连接与 Agent 中关联使用。</p>
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
                    className="secondary"
                    disabled={busy || !!draft}
                    onClick={() => edit(p)}
                  >
                    编辑
                  </button>
                  {!catalog.bindings.some((b) => b.provider_id === p.id) && (
                    <button
                      className="text-button danger"
                      disabled={busy || !!draft}
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
                const next = empty();
                baseline.current = JSON.stringify(next);
                setDraft(next);
                setNotice("");
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
                if (dirty && !busy)
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
                      { value: "bearer", label: "Authorization: Bearer" },
                      { value: "api_key", label: "x-api-key" },
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
                <section
                  className="provider-models-field"
                  aria-label="模型目录"
                >
                  <h4>模型目录</h4>
                  <table className="provider-model-table">
                    <thead>
                      <tr>
                        <th>模型 ID</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.models.map((model, index) => (
                        <tr key={index}>
                          <td>
                            <input
                              aria-label={`模型 ID ${index + 1}`}
                              maxLength={256}
                              placeholder="服务端提供的完整模型 ID"
                              value={model}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  models: draft.models.map((value, i) =>
                                    i === index ? e.target.value : value,
                                  ),
                                })
                              }
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`删除模型 ${index + 1}`}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  models: draft.models.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setDraft({ ...draft, models: [...draft.models, ""] })
                    }
                  >
                    <Plus size={16} />
                    添加模型
                  </button>
                  <small>默认模型自动包含在选择列表中。</small>
                </section>
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
                  更改地址或认证方式时，请重新填写凭据。修改后的配置会在下一次发送消息时生效。
                </p>
                <div className="modal-actions">
                  <span className="form-note" role="status">
                    {busy
                      ? "正在保存…"
                      : dirty
                        ? "有未保存的修改 · 离开设置后保留"
                        : draft.id
                          ? "已保存"
                          : "填写服务信息"}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setDraft(null)}
                  >
                    取消
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    disabled={!dirty || busy}
                  >
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
