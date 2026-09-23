import { useEffect, useState } from "react";
import {
  Plus,
  Folder,
  ChevronDown,
  ChevronRight,
  Settings2,
  Pin,
  Archive,
  MessageCirclePlus,
  PanelLeft,
} from "lucide-react";
import { SessionActions } from "./SessionActions";
import type { HostedSession } from "./sessionNavigation";
import { ProjectActions } from "./ProjectActions";
import type { HostedProject } from "./projectCatalog";
import { message } from "./api";
import { statusNames } from "./Conversation";
import type { Workbench } from "./useWorkbench";
export function Sidebar({ state }: { state: Workbench }) {
  const [sessionContext, setSessionContext] = useState<{
    session: HostedSession;
    point: { x: number; y: number };
  } | null>(null);
  const [context, setContext] = useState<{
    project: HostedProject;
    point: { x: number; y: number };
  } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sections, setSections] = useState(() => {
    const defaults = { pinned: true, projects: true };
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem("latte-work.sidebar-sections.v1") ?? "null",
      );
      if (!value || typeof value !== "object") return defaults;
      return {
        pinned:
          "pinned" in value && typeof value.pinned === "boolean"
            ? value.pinned
            : true,
        projects:
          "projects" in value && typeof value.projects === "boolean"
            ? value.projects
            : true,
      };
    } catch {
      return defaults;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "latte-work.sidebar-sections.v1",
        JSON.stringify(sections),
      );
    } catch {
      /* Nonessential presentation preference. */
    }
  }, [sections]);
  const sectionToggle = (key: keyof typeof sections, label: string) => (
    <button
      className="section-toggle"
      aria-expanded={sections[key]}
      aria-controls={`sidebar-${key}`}
      onClick={() => setSections((old) => ({ ...old, [key]: !old[key] }))}
    >
      {label}
      {sections[key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  );
  const {
    hosts,
    hostId,
    project,
    connected,
    createSession,
    setError,
    projects,
    projectId,
    selectProject,
    openProject,
    hostErrors,
    sessions,
    sessionId,
    setModal,
  } = state;
  const sessionRow = (s: HostedSession, shortcut = false) => {
    const sourceProject = projects.find(
      (p) => p.hostId === s.hostId && p.id === s.project_id,
    );
    const sourceHost = hosts.find((h) => h.id === s.hostId);
    const duplicateTitle =
      shortcut && state.pinned.filter((p) => p.title === s.title).length > 1;
    const showMenu = (point: { x: number; y: number }) => {
      setContext(null);
      setSessionContext({ session: s, point });
    };
    return (
      <button
        key={`${s.hostId}:${s.id}`}
        className={`session-row ${shortcut ? "pinned-session" : ""} ${s.id === sessionId && s.hostId === hostId ? "active" : ""}`}
        title={`${sourceProject?.name ?? "项目"} · ${sourceHost?.name ?? s.hostId} · ${statusNames[s.status]}`}
        onClick={() => state.openSession(s)}
        onContextMenu={(e) => {
          e.preventDefault();
          showMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            showMenu({ x: rect.left + 16, y: rect.bottom });
          }
        }}
      >
        {shortcut ? (
          <Pin size={13} />
        ) : (
          <span className={`session-dot ${s.status}`} />
        )}
        <span className="session-label">
          {s.title}
          {duplicateTitle && (
            <small>
              {sourceProject?.name} · {sourceHost?.name}
            </small>
          )}
        </span>
        {shortcut && ["running", "waiting"].includes(s.status) && (
          <span className={`session-dot ${s.status}`} />
        )}
        {s.unread && <span className="unread-dot" aria-label="未读" />}
      </button>
    );
  };
  return (
    <aside id="project-sidebar" className="sidebar" hidden={!state.sidebarOpen}>
      <div className="window-drag" data-tauri-drag-region>
        <button
          className="panel-toggle icon-button"
          title="收起侧栏"
          aria-label="收起侧栏"
          aria-expanded={true}
          aria-controls="project-sidebar"
          onClick={state.toggleSidebar}
        >
          <PanelLeft size={16} />
        </button>
      </div>
      <div className="brand">
        <div className="brand-mark">
          L<span>••</span>
        </div>
        <span className="brand-name">
          Latte<span className="brand-light"> Work</span>
        </span>
        <span className="version">PREVIEW</span>
      </div>
      <button
        className="new-task"
        disabled={!project || !connected}
        onClick={() => void createSession().catch((e) => setError(message(e)))}
      >
        <MessageCirclePlus size={16} />
        新任务<span>⌘ N</span>
      </button>
      {state.pinned.length > 0 && (
        <section className="pinned-section" aria-label="置顶会话">
          <div className="section-heading">
            {sectionToggle("pinned", "置顶")}
          </div>
          <div
            id="sidebar-pinned"
            className="pinned-session-list"
            hidden={!sections.pinned}
          >
            {state.pinned.map((s) => sessionRow(s, true))}
          </div>
        </section>
      )}
      <div className="section-heading">
        {sectionToggle("projects", "项目")}
        <button title="添加项目" className="icon-button" onClick={openProject}>
          <Plus size={15} />
        </button>
      </div>
      <div
        id="sidebar-projects"
        className="project-list"
        hidden={!sections.projects}
      >
        {projects.map((p) => {
          const key = `${p.hostId}:${p.id}`;
          const selected = p.id === projectId && p.hostId === hostId;
          const expanded = selected && !collapsed[key];
          const toggle = () => {
            if (!selected) selectProject(p.hostId, p.id);
            setCollapsed((old) => ({ ...old, [key]: expanded }));
          };
          return (
            <div className="project-group" key={key}>
              <div
                className="project-heading"
                onContextMenu={(e) => {
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setContext({
                    project: p,
                    point: {
                      x: e.clientX || rect.left + 20,
                      y: e.clientY || rect.bottom,
                    },
                  });
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "ContextMenu" ||
                    (e.shiftKey && e.key === "F10")
                  ) {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setContext({
                      project: p,
                      point: { x: rect.left + 20, y: rect.bottom },
                    });
                  }
                }}
              >
                <button
                  className={`project-row ${selected ? "selected" : ""}`}
                  onClick={toggle}
                  aria-expanded={expanded}
                  aria-controls={`sessions-${key}`}
                  title={`${p.path} · ${hosts.find((h) => h.id === p.hostId)?.name ?? ""}`}
                >
                  <Folder size={16} />
                  <span>{p.name}</span>
                  <small className="project-host">
                    {hosts.find((h) => h.id === p.hostId)?.name}
                  </small>
                </button>
                <button
                  className="project-toggle icon-button"
                  aria-label={`${expanded ? "折叠" : "展开"} ${p.name} 的任务`}
                  aria-expanded={expanded}
                  aria-controls={`sessions-${key}`}
                  onClick={toggle}
                >
                  {expanded ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </button>
              </div>
              <div id={`sessions-${key}`} hidden={!expanded}>
                {expanded && (
                  <div className="session-list">
                    {sessions
                      .filter((s) => s.archived === state.showArchived)
                      .map((s) => sessionRow({ ...s, hostId }))}
                    {(sessions.some((s) => s.archived) ||
                      state.showArchived) && (
                      <button
                        className="archive-toggle"
                        onClick={() => state.setShowArchived((value) => !value)}
                      >
                        <Archive size={13} />
                        {state.showArchived
                          ? "返回会话"
                          : `已归档 (${sessions.filter((s) => s.archived).length})`}
                      </button>
                    )}
                    {sessions.filter((s) => s.archived === state.showArchived)
                      .length === 0 && (
                      <span className="no-sessions">
                        {state.showArchived ? "没有已归档会话" : "还没有任务"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {projects.length === 0 && (
          <div className="sidebar-empty">
            <Folder size={22} />
            <p>把项目带到这里</p>
            <span>本地目录，或远程工作区</span>
          </div>
        )}
      </div>
      {!sections.projects && (
        <div className="sidebar-spacer" aria-hidden="true" />
      )}
      {hosts
        .filter((h) => hostErrors[h.id])
        .map((h) => (
          <button
            className="host-unavailable"
            key={h.id}
            title={hostErrors[h.id]}
            onClick={() => {
              void state.refreshHost(h);
            }}
          >
            {h.name} 暂时无法连接 · 重试
          </button>
        ))}
      <button className="add-project-link" onClick={openProject}>
        <Plus size={15} />
        添加项目
      </button>
      <div className="sidebar-footer">
        <button onClick={() => setModal("settings")}>
          <Settings2 size={16} />
          设置
          <span className={`connection-dot ${connected ? "online" : ""}`} />
        </button>
        <div className="footer-note">
          <span className="mini-mark">L</span>你的项目。你的 Agent。
        </div>
      </div>
      {sessionContext && (
        <SessionActions
          key={`${sessionContext.session.hostId}:${sessionContext.session.id}`}
          session={sessionContext.session}
          point={sessionContext.point}
          state={state}
          close={() => setSessionContext(null)}
        />
      )}
      {context && (
        <ProjectActions
          key={`${context.project.hostId}:${context.project.id}:${context.point.x}:${context.point.y}`}
          project={context.project}
          point={context.point}
          state={state}
          close={() => setContext(null)}
        />
      )}
    </aside>
  );
}
