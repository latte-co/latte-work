import { useEffect, useState } from "react";
import {
  Plus,
  Folder,
  ChevronDown,
  ChevronRight,
  Settings2,
  Pin,
  Archive,
  Ellipsis,
  MessageCirclePlus,
  PanelLeft,
  SquarePen,
} from "lucide-react";
import { SessionActions } from "./SessionActions";
import type { HostedSession } from "./sessionNavigation";
import { ProjectActions } from "./ProjectActions";
import type { HostedProject } from "./projectCatalog";
import { message, request } from "./api";
import { statusNames } from "./Conversation";
import type { Session } from "./protocol";
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
  const [expandedProjects, setExpandedProjects] = useState<
    Record<string, boolean>
  >({});
  const [sessionCache, setSessionCache] = useState<Record<string, Session[]>>(
    {},
  );
  const [loadingProjects, setLoadingProjects] = useState<
    Record<string, boolean>
  >({});
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>(
    {},
  );
  const [archivedProjects, setArchivedProjects] = useState<
    Record<string, boolean>
  >({});
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
    connected,
    createSession,
    setError,
    projects,
    projectId,
    openProject,
    hostErrors,
    sessions,
    sessionId,
    setModal,
  } = state;
  useEffect(() => {
    if (!projectId || !connected) return;
    const key = `${hostId}:${projectId}`;
    setSessionCache((old) => ({ ...old, [key]: sessions }));
  }, [hostId, projectId, connected, sessions]);
  async function loadProjectSessions(project: HostedProject) {
    const key = `${project.hostId}:${project.id}`;
    setLoadingProjects((old) => ({ ...old, [key]: true }));
    setProjectErrors((old) => ({ ...old, [key]: "" }));
    try {
      const fetch = () =>
        request(project.hostId, {
          method: "sessions",
          project_id: project.id,
        });
      let result;
      try {
        result = await fetch();
      } catch {
        const host = hosts.find((value) => value.id === project.hostId);
        if (!host) throw new Error("项目所在主机已移除");
        await state.refreshHost(host);
        result = await fetch();
      }
      if (result.kind !== "sessions") throw new Error("无法加载项目任务");
      setSessionCache((old) => ({ ...old, [key]: result.sessions }));
    } catch (error) {
      setProjectErrors((old) => ({ ...old, [key]: message(error) }));
    } finally {
      setLoadingProjects((old) => ({ ...old, [key]: false }));
    }
  }
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
    const row = (
      <button
        className={`session-row ${shortcut ? "pinned-session" : ""} ${s.id === sessionId && s.hostId === hostId ? "active" : ""}`}
        title={`${sourceProject?.name ?? "项目"} · ${sourceHost?.name ?? s.hostId} · ${statusNames[s.status]}`}
        onClick={() => {
          setExpandedProjects((old) => ({
            ...old,
            [`${s.hostId}:${s.project_id}`]: true,
          }));
          state.openSession(s);
        }}
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
        {shortcut && <Pin size={13} />}
        <span className="session-label">
          {s.title}
          {duplicateTitle && (
            <small>
              {sourceProject?.name} · {sourceHost?.name}
            </small>
          )}
        </span>
        {["running", "waiting"].includes(s.status) && (
          <span className={`session-dot ${s.status}`} />
        )}
        {s.unread && <span className="unread-dot" aria-label="未读" />}
      </button>
    );
    if (shortcut) return <div key={`${s.hostId}:${s.id}`}>{row}</div>;
    return (
      <div className="session-item" key={`${s.hostId}:${s.id}`}>
        {row}
        <button
          className="session-more icon-button"
          aria-label={`${s.title} 的更多操作`}
          title="更多操作"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            showMenu({ x: rect.right, y: rect.bottom });
          }}
        >
          <Ellipsis size={15} />
        </button>
      </div>
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
          const expanded = expandedProjects[key] ?? selected;
          const projectSessions = selected
            ? sessions
            : (sessionCache[key] ?? []);
          const showArchived = selected
            ? state.showArchived
            : (archivedProjects[key] ?? false);
          const hasActivity = projectSessions.some((s) =>
            ["running", "waiting"].includes(s.status),
          );
          const toggle = () => {
            setExpandedProjects((old) => ({ ...old, [key]: !expanded }));
            if (!expanded && !selected) void loadProjectSessions(p);
          };
          const showProjectMenu = (point: { x: number; y: number }) => {
            setSessionContext(null);
            setContext({ project: p, point });
          };
          return (
            <div className="project-group" key={key}>
              <div
                className={`project-heading ${selected ? "selected" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  showProjectMenu({
                    x: e.clientX || rect.left + 20,
                    y: e.clientY || rect.bottom,
                  });
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "ContextMenu" ||
                    (e.shiftKey && e.key === "F10")
                  ) {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    showProjectMenu({
                      x: rect.left + 20,
                      y: rect.bottom,
                    });
                  }
                }}
              >
                <button
                  className="project-row"
                  onClick={toggle}
                  aria-expanded={expanded}
                  aria-controls={`sessions-${key}`}
                  title={`${p.path} · ${hosts.find((h) => h.id === p.hostId)?.name ?? ""}`}
                >
                  <span className="project-folder">
                    <Folder size={15} />
                    {p.hostId !== "local" && (
                      <span className="project-remote-mark" />
                    )}
                  </span>
                  <span className="project-name">{p.name}</span>
                  {p.hostId !== "local" && (
                    <small className="project-host">
                      {hosts.find((h) => h.id === p.hostId)?.name}
                    </small>
                  )}
                  {hasActivity && (
                    <span className="project-activity" title="有运行中的任务" />
                  )}
                </button>
                <button
                  className="project-more icon-button"
                  aria-label={`${p.name} 的更多操作`}
                  title="更多操作"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    showProjectMenu({ x: rect.right, y: rect.bottom });
                  }}
                >
                  <Ellipsis size={15} />
                </button>
                <button
                  className="project-new-task icon-button"
                  aria-label={`在 ${p.name} 中新建任务`}
                  title={`在 ${p.name} 中新建任务`}
                  onClick={() => {
                    setExpandedProjects((old) => ({ ...old, [key]: true }));
                    void createSession(p).catch((e) => setError(message(e)));
                  }}
                >
                  <SquarePen size={15} />
                </button>
              </div>
              <div id={`sessions-${key}`} hidden={!expanded}>
                {expanded && (
                  <div className="session-list">
                    {projectSessions
                      .filter((s) => s.archived === showArchived)
                      .map((s) => sessionRow({ ...s, hostId: p.hostId }))}
                    {(projectSessions.some((s) => s.archived) ||
                      showArchived) && (
                      <button
                        className="archive-toggle"
                        onClick={() => {
                          if (selected)
                            state.setShowArchived((value) => !value);
                          else
                            setArchivedProjects((old) => ({
                              ...old,
                              [key]: !showArchived,
                            }));
                        }}
                      >
                        <Archive size={13} />
                        {showArchived
                          ? "返回会话"
                          : `已归档 (${projectSessions.filter((s) => s.archived).length})`}
                      </button>
                    )}
                    {projectSessions.filter((s) => s.archived === showArchived)
                      .length === 0 &&
                      (projectErrors[key] ? (
                        <button
                          className="no-sessions"
                          title={projectErrors[key]}
                          onClick={() => void loadProjectSessions(p)}
                        >
                          加载失败 · 重试
                        </button>
                      ) : (
                        <span className="no-sessions">
                          {loadingProjects[key]
                            ? "正在加载任务…"
                            : showArchived
                              ? "没有已归档会话"
                              : "还没有任务"}
                        </span>
                      ))}
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
