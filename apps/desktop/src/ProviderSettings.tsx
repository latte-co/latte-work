import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Select } from "./Select";
import {
  message,
  providerRequest,
  fetchProviderModels,
  type ProviderRequest,
} from "./api";
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
  model_labels: {},
  auth: "none",
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
  async function fetchModels() {
    if (!draft || busy) return;
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const models = await fetchProviderModels(draft);
      if (current !== generation.current) return;
      const ids = Array.from(
        new Set([
          ...draft.models.filter((id) => id.trim()),
          ...models.map((m) => m.id),
        ]),
      );
      if (ids.length > 256) throw new Error("模型目录最多支持 256 个模型");
      const labels = { ...draft.model_labels };
      for (const model of models)
        if (!labels[model.id]?.trim()) labels[model.id] = model.name;
      setDraft({ ...draft, models: ids, model_labels: labels });
      setNotice(
        models.length
          ? `已获取 ${models.length} 个模型，保存后生效。`
          : "后端未返回可用模型。",
      );
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
      models: Array.from(new Set([p.model, ...p.models])),
      model_labels: p.model_labels ?? {},
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
                  void mutate({
                    method: "save_provider",
                    provider: {
                      ...draft,
                      model_labels: Object.fromEntries(
                        Object.entries(draft.model_labels ?? {}).filter(
                          ([id, label]) =>
                            (id === draft.model || draft.models.includes(id)) &&
                            label?.trim(),
                        ),
                      ),
                    },
                  });
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
                        auth:
                          draft.auth === "none"
                            ? "none"
                            : value === "anthropic_messages"
                              ? "api_key"
                              : "bearer",
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
                <section
                  className="provider-models-field"
                  aria-label="模型目录"
                >
                  <div className="provider-model-heading">
                    <h4>模型目录</h4>
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy || !draft.base_url.trim()}
                      onClick={() => void fetchModels()}
                    >
                      {busy ? "正在获取…" : "获取可用模型"}
                    </button>
                  </div>
                  <table className="provider-model-table">
                    <thead>
                      <tr>
                        <th>模型 ID</th>
                        <th>显示名称</th>
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
                                  model_labels: {
                                    ...draft.model_labels,
                                    [e.target.value]:
                                      draft.model_labels?.[model] ?? "",
                                  },
                                  models: draft.models.map((value, i) =>
                                    i === index ? e.target.value : value,
                                  ),
                                })
                              }
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`显示名称 ${index + 1}`}
                              maxLength={80}
                              placeholder="可选，默认显示模型 ID"
                              value={draft.model_labels?.[model] ?? ""}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  model_labels: {
                                    ...draft.model_labels,
                                    [model]: e.target.value,
                                  },
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
                  API Key
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      draft.id && draft.auth !== "none"
                        ? "已保存，留空保持不变"
                        : "留空则无需认证"
                    }
                    value={draft.credential ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        credential: e.target.value || null,
                        auth: e.target.value
                          ? draft.id && draft.auth !== "none"
                            ? draft.auth
                            : draft.protocol === "anthropic_messages"
                              ? "api_key"
                              : "bearer"
                          : draft.id &&
                              JSON.parse(baseline.current).auth !== "none"
                            ? draft.auth
                            : "none",
                      })
                    }
                  />
                </label>
                {draft.id && draft.auth !== "none" && (
                  <button
                    type="button"
                    className="secondary provider-clear-key"
                    onClick={() =>
                      setDraft({ ...draft, auth: "none", credential: null })
                    }
                  >
                    清除 API Key，改为无需认证
                  </button>
                )}

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
