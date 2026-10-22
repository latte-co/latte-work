import { useEffect, useRef, useState } from "react";
import { Globe2, Monitor, Plus, RefreshCw, Search } from "lucide-react";
import { message, request } from "./api";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { SkillDetailDialog } from "./SkillDetailDialog";
import {
  SkillGrid,
  skillScopes as scopes,
  type GlobalSkillScope,
} from "./SkillGrid";
import type { ManagedSkill, Response, SkillState } from "./protocol";
import type { Workbench } from "./useWorkbench";
import "./skills.css";

type Catalog = Extract<Response, { kind: "skills" }>;
type Detail = Extract<Response, { kind: "skill_detail" }>;
function upgradeMessage(hostName: string, remote: boolean) {
  return `${hostName} 的 Server 版本较旧，尚不支持技能管理。请${remote ? "在该远程主机上更新并重启同版本 Server，再重新连接" : "更新本机 Server 后重新连接"}；重启前请先完成任务并关闭终端。`;
}

export function SkillsSettings({
  state,
  active,
  onBusy,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [hostId, setHostId] = useState(state.host.id);
  const [scope, setScope] = useState<GlobalSkillScope>("platform");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<Catalog>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<Detail>();
  const [selected, setSelected] = useState<string>();
  const [confirm, setConfirm] = useState<{
    skill: ManagedSkill;
    next: SkillState;
  }>();
  const [add, setAdd] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [installedExpanded, setInstalledExpanded] = useState(false);
  const [categoryExpanded, setCategoryExpanded] = useState(false);
  const refresh = useRef<HTMLButtonElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const generation = useRef(0);
  const operation = useRef(false);
  const host = state.hosts.find((h) => h.id === hostId);
  const connected = !!host && state.isHostConnected(hostId);
  const supported = state.hostSupportsSkills(hostId);
  const upgrade = upgradeMessage(host?.name ?? "所选主机", hostId !== "local");
  const context = `${supported}:${hostId}:${state.hostConnectionVersions[hostId] ?? 0}:${active}:${connected}`;
  const describeError = (cause: unknown) => message(cause);
  const contextRef = useRef(context);
  // Invalidate during render as well as effect cleanup: stale async results cannot mutate a new scope.
  if (contextRef.current !== context) {
    contextRef.current = context;
    generation.current++;
  }

  useEffect(() => {
    setDetail(undefined);
    setSelected(undefined);
    setConfirm(undefined);
    setAdd(false);
    setCatalog(undefined);
    setError("");
    setNotice("");
    setInstalledExpanded(false);
    setCategoryExpanded(false);
    if (!active || !connected) {
      setLoading(false);
      return;
    }
    if (!supported) {
      setLoading(false);
      setError(upgrade);
      return;
    }
    const version = ++generation.current;
    setLoading(true);
    void request(hostId, { method: "skills", project_id: null })
      .then((response) => {
        if (version !== generation.current) return;
        if (response.kind !== "skills") throw new Error(upgrade);
        setCatalog(response);
      })
      .catch((cause) => {
        if (version === generation.current) setError(describeError(cause));
      })
      .finally(() => {
        if (version === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [context, revision]);
  useEffect(() => {
    if (!active || !selected) return;
    const version = generation.current;
    let disposed = false;
    setDetail(undefined);
    void request(hostId, {
      method: "skill_detail",
      project_id: null,
      id: selected,
    })
      .then((response) => {
        if (disposed || version !== generation.current) return;
        if (response.kind !== "skill_detail")
          throw new Error("技能详情暂不可用，请更新 Server");
        setDetail(response);
      })
      .catch((cause) => {
        if (!disposed && version === generation.current)
          setError(describeError(cause));
      });
    return () => {
      disposed = true;
    };
  }, [selected, context]);

  async function mutate(
    action: { skill: ManagedSkill; next: SkillState } | { path: string },
  ) {
    if (operation.current || !connected) return;
    operation.current = true;
    const version = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await request(
        hostId,
        "skill" in action
          ? {
              method: "set_skill_state",
              project_id: null,
              id: action.skill.id,
              state: action.next,
              expected_state: action.skill.state,
            }
          : {
              method: "install_skill",
              project_id: null,
              scope: "system",
              path: action.path.trim(),
            },
      );
      if (version !== generation.current) return;
      if (response.kind !== "skills")
        throw new Error("操作结果待核对，请刷新列表确认状态");
      restoreFocus.current = true;
      setCatalog(response);
      setConfirm(undefined);
      setAdd(false);
      setSelected(undefined);
      setDetail(undefined);
      setNotice("已保存。对后续新建的 Agent 会话生效。");
    } catch (cause) {
      if (version === generation.current)
        setError(
          `${describeError(cause)}。可刷新列表核对状态；不会自动重试操作。`,
        );
    } finally {
      operation.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  function change(skill: ManagedSkill, next: SkillState) {
    if (skill.scope !== "platform" || next === "uninstalled")
      setConfirm({ skill, next });
    else void mutate({ skill, next });
  }
  const filtered = (catalog?.skills ?? []).filter(
    (s) =>
      s.scope !== "project" &&
      `${s.name} ${s.description} ${s.origin}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const installed = filtered.filter((s) => s.state !== "uninstalled");
  const category = filtered.filter((s) => s.scope === scope);
  const locked = busy || loading || !connected;
  function selectSkill(skill: ManagedSkill, trigger: HTMLButtonElement) {
    selectionTrigger.current = trigger;
    setError("");
    setSelected(skill.id);
  }
  useEffect(() => {
    if (!restoreFocus.current || selected) return;
    restoreFocus.current = false;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const trigger = selectionTrigger.current;
      if (
        trigger?.isConnected &&
        !trigger.disabled &&
        !trigger.closest("[hidden], [inert]")
      )
        trigger.focus();
      else refresh.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, active]);
  const skill = detail?.skill;
  return (
    <div
      className="settings-panel-content skills-settings"
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.key !== "Escape" ||
          (!selected && !add)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (operation.current) return;
        if (confirm) setConfirm(undefined);
        else if (add) setAdd(false);
        else {
          setSelected(undefined);
          setDetail(undefined);
        }
      }}
    >
      <header className="skills-header">
        <div>
          <h2>技能</h2>
          <p>管理当前主机的全局技能</p>
        </div>
        <div className="skills-toolbar">
          <div className="skills-search">
            <Search size={16} />
            <input
              aria-label="搜索技能"
              placeholder="搜索技能"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="skills-host">
            {hostId === "local" ? <Monitor size={16} /> : <Globe2 size={16} />}
            <Select
              label="技能所在主机"
              menuTitle="主机"
              minMenuWidth={240}
              align="end"
              compact
              value={hostId}
              disabled={busy}
              options={state.hosts.map((h) => ({ value: h.id, label: h.name }))}
              onChange={setHostId}
            />
          </span>
          <button
            className="icon-button"
            ref={refresh}
            aria-label="刷新技能"
            title="刷新技能"
            disabled={locked}
            onClick={() => setRevision((v) => v + 1)}
          >
            <RefreshCw size={17} className={loading ? "skills-spinning" : ""} />
          </button>
          <button
            className="primary skills-add"
            disabled={locked || !catalog}
            onClick={() => {
              setError("");
              setAdd(true);
            }}
          >
            <Plus size={16} />
            添加
          </button>
        </div>
      </header>
      {!connected && (
        <p role="status">
          {host?.name ?? "主机"} 未连接。请在「连接与 Agent」中连接后查看技能。
        </p>
      )}
      {error && !selected && !add && (
        <p role="alert">
          {error}
          <button
            disabled={busy || loading || !connected}
            onClick={() => setRevision((v) => v + 1)}
          >
            刷新核对
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">正在读取技能…</p>}
      {catalog && (
        <>
          {(catalog.warnings.length > 0 || catalog.truncated) && (
            <details className="skills-warnings">
              <summary>部分目录未能完整读取</summary>
              {catalog.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
              {catalog.truncated && (
                <p>
                  扫描达到数量、大小或时间上限，部分技能可能未显示；请整理目录后刷新。
                </p>
              )}
            </details>
          )}
          <section className="skills-installed">
            <h3>
              已安装 <small>{installed.length}</small>
            </h3>
            <SkillGrid
              skills={installed}
              expanded={installedExpanded}
              onExpand={setInstalledExpanded}
              query={query}
              loading={loading}
              disabled={busy || !connected}
              label="已安装技能"
              emptyMessage="暂无技能"
              onSelect={selectSkill}
            />
          </section>
          <section className="skills-categories">
            <div className="skills-category-toolbar">
              <div className="skills-tabs" role="tablist" aria-label="技能分类">
                {scopes.map((s, i) => (
                  <button
                    role="tab"
                    id={`skill-tab-${s.value}`}
                    aria-controls="skill-category-panel"
                    aria-selected={scope === s.value}
                    tabIndex={scope === s.value ? 0 : -1}
                    key={s.value}
                    onClick={() => {
                      setScope(s.value);
                      setCategoryExpanded(false);
                    }}
                    onKeyDown={(e) => {
                      if (
                        !["ArrowRight", "ArrowLeft", "Home", "End"].includes(
                          e.key,
                        )
                      )
                        return;
                      e.preventDefault();
                      const next =
                        e.key === "Home"
                          ? 0
                          : e.key === "End"
                            ? scopes.length - 1
                            : (i +
                                (e.key === "ArrowRight" ? 1 : -1) +
                                scopes.length) %
                              scopes.length;
                      setScope(scopes[next].value);
                      setCategoryExpanded(false);
                      document
                        .getElementById(`skill-tab-${scopes[next].value}`)
                        ?.focus();
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="skills-scope-note">
              {scope === "platform"
                ? "随 Latte Work 提供，仅注入 Work 启动的 Agent。"
                : "当前主机的全局技能；文件操作会影响该主机上的其他 Agent。"}
            </p>
            <div
              role="tabpanel"
              id="skill-category-panel"
              aria-labelledby={`skill-tab-${scope}`}
            >
              <SkillGrid
                skills={category}
                expanded={categoryExpanded}
                onExpand={setCategoryExpanded}
                query={query}
                loading={loading}
                disabled={busy || !connected}
                label="分类技能"
                emptyMessage="暂无技能"
                onSelect={selectSkill}
              />
            </div>
          </section>
        </>
      )}
      {active && selected && (
        <SkillDetailDialog
          key={selected}
          detail={detail}
          skill={skill}
          error={error}
          busy={busy}
          connected={connected}
          hostName={host?.name}
          onClose={() => {
            if (!busy && !confirm) {
              setSelected(undefined);
              setDetail(undefined);
            }
          }}
          onChange={change}
          onError={setError}
          onRefresh={() => {
            setSelected(undefined);
            setRevision((v) => v + 1);
          }}
        />
      )}
      {active && confirm && (
        <div className="modal-backdrop skill-confirm-backdrop">
          <Modal
            className="modal"
            aria-labelledby="skill-confirm-title"
            aria-describedby="skill-confirm-description"
          >
            <h2 id="skill-confirm-title">
              {confirm.next === "uninstalled"
                ? "卸载"
                : confirm.next === "disabled"
                  ? "禁用"
                  : confirm.skill.state === "uninstalled"
                    ? "安装"
                    : "启用"}{" "}
              {confirm.skill.name}？
            </h2>
            <div id="skill-confirm-description">
              <p>主机：{host?.name}</p>
              <p className="skill-detail-path">
                {confirm.skill.directory ?? "Latte Work 平台内置技能"}
              </p>
              <p>
                {confirm.skill.scope === "platform"
                  ? "仅影响此主机上由 Latte Work 启动的 Agent。"
                  : confirm.skill.state === "uninstalled"
                    ? "会恢复到此主机的全局技能目录，影响使用该目录的其他 Agent。"
                    : "会移动当前安装目录，影响这台主机上使用此目录的其他 Agent。"}
                {confirm.next === "uninstalled"
                  ? "卸载后保留恢复副本，可在分类中重新安装。"
                  : "可以随时在此恢复。"}{" "}
                已运行的会话及历史上下文保持原样，对后续新建的 Agent 会话生效。
              </p>
            </div>
            {error && <p role="alert">{error}</p>}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setConfirm(undefined)}>
                取消
              </button>
              <button
                className={
                  confirm.next === "uninstalled" ? "danger" : "primary"
                }
                disabled={busy || !connected}
                onClick={() => void mutate(confirm)}
              >
                {busy ? "正在保存…" : "确认"}
              </button>
            </div>
          </Modal>
        </div>
      )}
      {active && add && (
        <div className="modal-backdrop">
          <Modal
            className="modal"
            aria-labelledby="skill-add-title"
            aria-describedby="skill-add-description skill-add-limits"
          >
            <h2 id="skill-add-title">添加技能</h2>
            <p id="skill-add-description">
              从 {host?.name} 上的现有目录导入完整技能。目录需包含
              SKILL.md，不会执行其中的命令。
            </p>
            <label>
              技能目录的绝对路径
              <input
                aria-label="技能目录的绝对路径"
                disabled={busy}
                value={importPath}
                placeholder="/path/to/my-skill"
                onChange={(e) => setImportPath(e.target.value)}
              />
            </label>
            <p id="skill-add-limits">
              安装到当前主机的 ~/.agents/skills；原目录保留。最多 512 项、16
              MiB，不支持包内符号链接。
            </p>
            {error && <p role="alert">{error}</p>}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setAdd(false)}>
                取消
              </button>
              <button
                className="primary"
                disabled={
                  busy || !connected || !importPath.trim().startsWith("/")
                }
                onClick={() => void mutate({ path: importPath })}
              >
                {busy ? "正在导入…" : "添加"}
              </button>
            </div>
          </Modal>
        </div>
      )}
    </div>
  );
}
