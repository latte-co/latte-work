import { useEffect, useRef, useState } from "react";
import {
  Box,
  Check,
  Copy,
  Folder,
  Globe2,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { message, request } from "./api";
import { copyText } from "./clipboard";
import { Modal } from "./Modal";
import { Select } from "./Select";
import type {
  ManagedSkill,
  Response,
  SkillScope,
  SkillState,
} from "./protocol";
import type { Workbench } from "./useWorkbench";
import "./skills.css";

type Catalog = Extract<Response, { kind: "skills" }>;
type Detail = Extract<Response, { kind: "skill_detail" }>;
const scopes: { value: SkillScope; label: string }[] = [
  { value: "platform", label: "平台内置" },
  { value: "system", label: "系统" },
  { value: "project", label: "项目" },
];
const states: Record<SkillState, string> = {
  enabled: "已启用",
  disabled: "已禁用",
  uninstalled: "已卸载",
};

export function SkillsSettings({
  state,
  active,
  onBusy,
  onTry,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
  onTry?: (
    hostId: string,
    projectId: string,
    skill: ManagedSkill,
  ) => Promise<void>;
}) {
  const [hostId, setHostId] = useState(state.host.id);
  const [projectId, setProjectId] = useState(state.projectId ?? "");
  const [trialProject, setTrialProject] = useState("");
  const [scope, setScope] = useState<SkillScope>("platform");
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
  const [importScope, setImportScope] = useState<"system" | "project">(
    "system",
  );
  const [installedExpanded, setInstalledExpanded] = useState(false);
  const [categoryExpanded, setCategoryExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const operation = useRef(false);
  const projects = state.projects.filter((p) => p.hostId === hostId);
  const project = projects.find((p) => p.id === projectId);
  const host = state.hosts.find((h) => h.id === hostId);
  const connected = !!host && state.isHostConnected(hostId);
  const context = `${hostId}:${project?.id ?? ""}:${active}:${connected}`;
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
    const version = ++generation.current;
    setLoading(true);
    void request(hostId, { method: "skills", project_id: project?.id ?? null })
      .then((response) => {
        if (version !== generation.current) return;
        if (response.kind !== "skills")
          throw new Error("此 Server 不支持技能管理，请更新所选主机的 Server");
        setCatalog(response);
      })
      .catch((cause) => {
        if (version === generation.current) setError(message(cause));
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
    setCopied(false);
    void request(hostId, {
      method: "skill_detail",
      project_id: project?.id ?? null,
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
          setError(message(cause));
      });
    return () => {
      disposed = true;
    };
  }, [selected, context]);

  async function mutate(
    action:
      | { skill: ManagedSkill; next: SkillState }
      | { path: string; scope: SkillScope },
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
              project_id: project?.id ?? null,
              id: action.skill.id,
              state: action.next,
              expected_state: action.skill.state,
            }
          : {
              method: "install_skill",
              project_id: project?.id ?? null,
              scope: action.scope,
              path: action.path.trim(),
            },
      );
      if (version !== generation.current) return;
      if (response.kind !== "skills")
        throw new Error("操作结果待核对，请刷新列表确认状态");
      setCatalog(response);
      setConfirm(undefined);
      setAdd(false);
      setSelected(undefined);
      setDetail(undefined);
      setNotice("已保存。对后续新建的 Agent 会话生效。");
    } catch (cause) {
      if (version === generation.current)
        setError(`${message(cause)}。可刷新列表核对状态；不会自动重试操作。`);
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
  const filtered = (catalog?.skills ?? []).filter((s) =>
    `${s.name} ${s.description} ${s.origin}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const installed = filtered.filter((s) => s.state !== "uninstalled");
  const category = filtered.filter((s) => s.scope === scope);
  const locked = busy || loading || !connected;
  function grid(
    skills: ManagedSkill[],
    expanded: boolean,
    setExpanded: (expanded: boolean) => void,
    label: string,
  ) {
    return (
      <>
        <div className="skills-grid" aria-label={label}>
          {(expanded || query ? skills : skills.slice(0, 6)).map((skill) => (
            <button
              key={skill.id}
              className="skills-row"
              disabled={busy || !connected}
              onClick={() => {
                setError("");
                setSelected(skill.id);
                setTrialProject(
                  project?.id ??
                    projects.find((p) => p.id === state.projectId)?.id ??
                    "",
                );
              }}
            >
              <span className="skills-icon">
                <Box size={22} />
              </span>
              <span className="skills-row-copy">
                <span>{skill.name}</span>
                <small title={skill.description || skill.origin}>
                  {skill.description || skill.origin}
                </small>
              </span>
              <span
                className={`skills-state ${skill.state}`}
                title={states[skill.state]}
                aria-label={states[skill.state]}
              >
                {skill.state === "enabled" ? (
                  <Check size={17} />
                ) : (
                  states[skill.state]
                )}
              </span>
            </button>
          ))}
        </div>
        {!skills.length && !loading && (
          <p className="skills-empty">
            {query
              ? "没有匹配的技能"
              : scope === "project" && !project && label !== "已安装技能"
                ? "选择项目后查看项目技能"
                : "暂无技能"}
          </p>
        )}
        {skills.length > 6 && !query && (
          <button
            className="skills-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起" : `查看全部，另有 ${skills.length - 6} 项`}
          </button>
        )}
      </>
    );
  }
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
          <p>通过技能扩展 Agent 的能力</p>
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
              compact
              value={hostId}
              disabled={busy}
              options={state.hosts.map((h) => ({ value: h.id, label: h.name }))}
              onChange={(id) => {
                setHostId(id);
                setProjectId("");
              }}
            />
          </span>
          <button
            className="icon-button"
            aria-label="刷新技能"
            title="刷新技能"
            disabled={locked}
            onClick={() => setRevision((v) => v + 1)}
          >
            <RefreshCw size={17} className={loading ? "skills-spinning" : ""} />
          </button>
          <button
            className="primary skills-add"
            disabled={locked}
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
                <p>扫描达到 512 项上限，请缩小技能目录后刷新。</p>
              )}
            </details>
          )}
          <section className="skills-installed">
            <h3>
              已安装 <small>{installed.length}</small>
            </h3>
            {grid(
              installed,
              installedExpanded,
              setInstalledExpanded,
              "已安装技能",
            )}
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
                            ? 2
                            : (i + (e.key === "ArrowRight" ? 1 : -1) + 3) % 3;
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
              {scope === "project" && (
                <Select
                  label="技能所在项目"
                  value={project?.id ?? ""}
                  disabled={busy}
                  searchable
                  compact
                  options={[
                    { value: "", label: "选择项目" },
                    ...projects.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={setProjectId}
                />
              )}
            </div>
            <p className="skills-scope-note">
              {scope === "platform"
                ? "随 Latte Work 提供，仅注入 Work 启动的 Agent。"
                : scope === "system"
                  ? "当前主机的全局技能；文件操作会影响该主机上的其他 Agent。"
                  : project
                    ? project.path
                    : "按所选主机和项目读取，不会启动 Agent。"}
            </p>
            <div
              role="tabpanel"
              id="skill-category-panel"
              aria-labelledby={`skill-tab-${scope}`}
            >
              {grid(
                category,
                categoryExpanded,
                setCategoryExpanded,
                "分类技能",
              )}
            </div>
          </section>
        </>
      )}
      {active && selected && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy && !confirm) {
              setSelected(undefined);
              setDetail(undefined);
            }
          }}
        >
          <Modal
            className="modal skill-detail"
            aria-labelledby="skill-detail-title"
          >
            <div className="skill-detail-top">
              <span className="skills-icon">
                <Box size={23} />
              </span>
              <div>
                {skill && (
                  <button
                    className="skill-toggle"
                    role="switch"
                    aria-label="启用技能"
                    aria-checked={skill.state === "enabled"}
                    disabled={
                      busy || !connected || skill.state === "uninstalled"
                    }
                    onClick={() =>
                      change(
                        skill,
                        skill.state === "enabled" ? "disabled" : "enabled",
                      )
                    }
                  >
                    <span />
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label="关闭技能详情"
                  disabled={busy}
                  onClick={() => {
                    setSelected(undefined);
                    setDetail(undefined);
                  }}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <h2 id="skill-detail-title">{skill?.name ?? "技能详情"}</h2>
            {!detail && (
              <p role="status">{error ? "技能详情暂不可用" : "正在读取…"}</p>
            )}
            {detail && (
              <>
                <p>{skill?.description}</p>
                <div className="skill-detail-meta">
                  <span>
                    {scopes.find((s) => s.value === skill?.scope)?.label} ·{" "}
                    {skill && states[skill.state]}
                  </span>
                  <span>{host?.name}</span>
                </div>
                {skill?.directory && (
                  <div className="skill-detail-path" title={skill.directory}>
                    <Folder size={14} />
                    <span>{skill.directory}</span>
                  </div>
                )}
                <div className="skill-markdown markdown" tabIndex={0}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ children, href }) => (
                        <span title={href}>{children}</span>
                      ),
                      img: ({ alt }) => <span>{alt || "图片"}</span>,
                    }}
                  >
                    {detail.markdown.replace(
                      /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                      "",
                    )}
                  </ReactMarkdown>
                </div>
                {onTry && (
                  <div className="skill-trial-project">
                    <Select
                      label="试用技能的项目"
                      compact
                      value={trialProject}
                      disabled={busy}
                      options={[
                        { value: "", label: "选择试用项目" },
                        ...projects
                          .filter(
                            (p) =>
                              skill?.scope !== "project" ||
                              p.id === project?.id,
                          )
                          .map((p) => ({ value: p.id, label: p.name })),
                      ]}
                      onChange={setTrialProject}
                    />
                  </div>
                )}
                <footer className="skill-detail-actions">
                  <button
                    className={skill?.state !== "uninstalled" ? "danger" : ""}
                    disabled={busy || !connected}
                    onClick={() =>
                      skill &&
                      change(
                        skill,
                        skill.state === "uninstalled"
                          ? "enabled"
                          : "uninstalled",
                      )
                    }
                  >
                    {skill?.state === "uninstalled" ? "重新安装" : "卸载"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void copyText(detail.markdown)
                        .then(() => setCopied(true))
                        .catch((e) => setError(message(e)));
                    }}
                  >
                    <Copy size={15} />
                    {copied ? "已复制" : "复制 Markdown"}
                  </button>
                  {onTry && (
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        !connected ||
                        skill?.state !== "enabled" ||
                        !trialProject
                      }
                      onClick={() => {
                        if (!skill || operation.current) return;
                        operation.current = true;
                        setBusy(true);
                        onBusy(true);
                        const version = generation.current;
                        void onTry(hostId, trialProject, skill)
                          .catch((cause) => {
                            if (version === generation.current)
                              setError(message(cause));
                          })
                          .finally(() => {
                            operation.current = false;
                            setBusy(false);
                            onBusy(false);
                          });
                      }}
                    >
                      立即试用
                    </button>
                  )}
                </footer>
              </>
            )}
            {error && (
              <p role="alert">
                {error}
                <button
                  disabled={busy}
                  onClick={() => {
                    setSelected(undefined);
                    setRevision((v) => v + 1);
                  }}
                >
                  刷新核对
                </button>
              </p>
            )}
          </Modal>
        </div>
      )}
      {active && confirm && (
        <div className="modal-backdrop skill-confirm-backdrop">
          <Modal className="modal" aria-labelledby="skill-confirm-title">
            <h2 id="skill-confirm-title">
              {confirm.next === "uninstalled"
                ? "卸载"
                : confirm.next === "disabled"
                  ? "禁用"
                  : "启用"}{" "}
              {confirm.skill.name}？
            </h2>
            <p>主机：{host?.name}</p>
            <p className="skill-detail-path">
              {confirm.skill.directory ?? "Latte Work 平台内置技能"}
            </p>
            <p>
              {confirm.skill.scope === "platform"
                ? "仅影响此主机上由 Latte Work 启动的 Agent。"
                : "会移动当前安装目录，影响这台主机上使用此目录的其他 Agent。"}
              {confirm.next === "uninstalled"
                ? "卸载后保留恢复副本，可在分类中重新安装。"
                : "可以随时在此恢复。"}{" "}
              已运行的会话及历史上下文保持原样，对后续新建的 Agent 会话生效。
            </p>
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
          <Modal className="modal" aria-labelledby="skill-add-title">
            <h2 id="skill-add-title">添加技能</h2>
            <p>
              从 {host?.name} 上的现有目录导入完整技能。目录需包含
              SKILL.md，不会执行其中的命令。
            </p>
            <label>
              安装到
              <Select
                label="技能安装范围"
                disabled={busy}
                value={importScope}
                options={[
                  { value: "system", label: "系统 · ~/.agents/skills" },
                  ...(project
                    ? [{ value: "project", label: `项目 · ${project.name}` }]
                    : []),
                ]}
                onChange={(v) => setImportScope(v as "system" | "project")}
              />
            </label>
            {!project && <p>如需添加到项目，请先在「项目」分类选择项目。</p>}
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
            <p>
              复制到 .agents/skills；原目录保留。最多 512 项、16
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
                  busy ||
                  !connected ||
                  !importPath.trim().startsWith("/") ||
                  (importScope === "project" && !project)
                }
                onClick={() =>
                  void mutate({ path: importPath, scope: importScope })
                }
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
