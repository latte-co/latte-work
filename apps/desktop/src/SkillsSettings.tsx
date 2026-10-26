import { useEffect, useState } from "react";
import { Globe2, Monitor, RefreshCw, Search } from "lucide-react";
import { Select } from "./Select";
import { SkillAddMenu } from "./SkillAddMenu";
import { SkillDetailDialog } from "./SkillDetailDialog";
import { SkillChangeDialog, SkillImportDialog } from "./SkillOperationDialogs";
import {
  SkillGrid,
  skillScopes as scopes,
  type GlobalSkillScope,
} from "./SkillGrid";
import { useSkills } from "./useSkills";
import type { Workbench } from "./useWorkbench";
import "./skills.css";
export function SkillsSettings({
  state,
  active,
  onBusy,
  onCreate,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
  onCreate?: (hostId: string) => void;
}) {
  const [scope, setScope] = useState<GlobalSkillScope>("platform");
  const [query, setQuery] = useState("");
  const [installedExpanded, setInstalledExpanded] = useState(false);
  const [categoryExpanded, setCategoryExpanded] = useState(false);
  const {
    hostId,
    setHostId,
    host,
    connected,
    catalog,
    loading,
    busy,
    notice,
    pageError,
    detailError,
    operationError,
    setDetailError,
    clearErrors,
    detail,
    selected,
    setSelected,
    setDetail,
    confirm,
    setConfirm,
    add,
    setAdd,
    refresh,
    operation,
    context,
    reload,
    mutate,
    change,
    selectSkill,
  } = useSkills(state, active, onBusy);
  useEffect(() => {
    setInstalledExpanded(false);
    setCategoryExpanded(false);
  }, [context]);
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
            onClick={() => reload()}
          >
            <RefreshCw size={17} className={loading ? "skills-spinning" : ""} />
          </button>
          <SkillAddMenu
            key={context}
            disabled={busy || !active}
            importDisabled={locked || !catalog}
            onCreate={onCreate ? () => onCreate(hostId) : undefined}
            onImport={() => {
              clearErrors();
              setAdd(true);
            }}
          />
        </div>
      </header>
      {!connected && (
        <p role="status">
          {host?.name ?? "主机"} 未连接。请在「连接与 Agent」中连接后查看技能。
        </p>
      )}
      {pageError && !selected && !add && (
        <p role="alert">
          {pageError}
          <button
            disabled={busy || loading || !connected}
            onClick={() => reload()}
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
          error={detailError}
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
          onError={setDetailError}
          onRefresh={() => {
            setSelected(undefined);
            reload();
          }}
        />
      )}
      {active && confirm && (
        <SkillChangeDialog
          confirm={confirm}
          hostName={host?.name}
          busy={busy}
          connected={connected}
          error={operationError}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => void mutate(confirm)}
        />
      )}
      {active && add && (
        <SkillImportDialog
          hostName={host?.name}
          busy={busy}
          connected={connected}
          supported={state.hostSupportsSkillFiles(hostId)}
          error={operationError}
          onClose={() => setAdd(false)}
          onImport={(upload) => void mutate(upload)}
        />
      )}
    </div>
  );
}
