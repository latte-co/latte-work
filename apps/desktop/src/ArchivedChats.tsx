import { useEffect, useState } from "react";
import { Archive, Folder, Search } from "lucide-react";
import { message, request } from "./api";
import type { Session } from "./protocol";
import type { Workbench } from "./useWorkbench";
import { Select } from "./Select";

export function ArchivedChats({
  state,
  active,
  onBusy,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [records, setRecords] = useState<Record<string, Session[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const targets = JSON.stringify(
    state.projects.map((p) => ({ hostId: p.hostId, id: p.id })),
  );
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setRecords({});
    setErrors({});
    void (async () => {
      for (const p of JSON.parse(targets) as { hostId: string; id: string }[]) {
        if (disposed) return;
        const key = `${p.hostId}:${p.id}`;
        try {
          const result = await request(p.hostId, {
            method: "sessions",
            project_id: p.id,
          });
          if (result.kind !== "sessions") throw new Error("无法加载聊天");
          if (!disposed)
            setRecords((old) => ({
              ...old,
              [key]: result.sessions.filter((s) => s.archived),
            }));
        } catch (e) {
          if (!disposed) setErrors((old) => ({ ...old, [key]: message(e) }));
        }
      }
      if (!disposed) setLoading(false);
    })();
    return () => {
      disposed = true;
    };
  }, [active, targets, revision]);
  async function restore(hostId: string, session: Session) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await state.sessionAction(hostId, {
        method: "archive_session",
        session_id: session.id,
        archived: false,
      });
      const key = `${hostId}:${session.project_id}`;
      setRecords((old) => ({
        ...old,
        [key]: (old[key] ?? []).filter((s) => s.id !== session.id),
      }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  const groups = state.projects
    .filter((p) => !filter || `${p.hostId}:${p.id}` === filter)
    .map((p) => ({
      ...p,
      key: `${p.hostId}:${p.id}`,
      chats: (records[`${p.hostId}:${p.id}`] ?? []).filter((s) =>
        s.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    }));
  return (
    <div className="settings-panel-content archived-chats">
      <h2>已归档的聊天</h2>
      <div className="archive-filters">
        <div className="archive-search">
          <Search size={17} />
          <input
            aria-label="搜索已归档的聊天"
            placeholder="搜索已归档的聊天"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select
          label="筛选项目"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "", label: "所有项目" },
            ...state.projects.map((p) => ({
              value: `${p.hostId}:${p.id}`,
              label: `${p.name} · ${state.hosts.find((h) => h.id === p.hostId)?.name ?? p.hostId}`,
            })),
          ]}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在加载…</p>}
      {groups.map((p) => (
        <section key={p.key} className="archive-group">
          {(p.chats.length > 0 || errors[p.key]) && (
            <h3>
              <Folder size={17} />
              <span>{p.name}</span>
              <small>{state.hosts.find((h) => h.id === p.hostId)?.name}</small>
              <span className="archive-count">
                {errors[p.key] ? "" : `${p.chats.length} 个聊天`}
              </span>
            </h3>
          )}
          {errors[p.key] && (
            <div role="alert" className="archive-load-error">
              <span>{errors[p.key]}</span>
              <button
                disabled={busy || loading}
                onClick={() => setRevision((v) => v + 1)}
              >
                重试
              </button>
            </div>
          )}
          {p.chats.map((s) => (
            <div className="archive-chat" key={s.id}>
              <span className="archive-chat-info">{s.title}</span>
              <button
                disabled={busy || loading}
                aria-label={`取消归档 ${s.title}`}
                onClick={() => void restore(p.hostId, s)}
              >
                取消归档
              </button>
            </div>
          ))}
        </section>
      ))}
      {!loading && !groups.some((p) => p.chats.length || errors[p.key]) && (
        <div className="archive-empty">
          <Archive size={24} />
          <p>
            {query || filter ? "没有匹配的已归档聊天" : "还没有已归档的聊天"}
          </p>
        </div>
      )}
    </div>
  );
}
