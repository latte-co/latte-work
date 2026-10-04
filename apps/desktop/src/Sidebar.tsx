import { useEffect, useState } from "react";
import {
  Plus,
  Folder,
  FolderOpen,
  Globe2,
  CirclePause,
  CircleAlert,
  CircleHelp,
  ChevronDown,
  ChevronRight,
  Settings2,
  Pin,
  Archive,
  MessageCirclePlus,
  PanelLeft,
  SquarePen,
  MoreHorizontal,
  PinOff,
  ArchiveRestore,
} from "lucide-react";
import { WorkingStatus } from "./WorkingStatus";
import { SessionHoverCard, ProjectHoverCard } from "./SidebarHoverCard";
import { agentSessionLabels, agentSessionState } from "./agentSessionState";
import { useHistoryLoadingIndicator } from "./useHistoryLoadingIndicator";
import { SessionActions } from "./SessionActions";
import type { HostedSession } from "./sessionNavigation";
import { ProjectActions } from "./ProjectActions";
import type { HostedProject } from "./projectCatalog";
import { message, request } from "./api";
import { statusNames } from "./Conversation";
import type { Session } from "./protocol";
import type { Workbench } from "./useWorkbench";
export function Sidebar({
  state,
  historyPending = state.historyLoading,
}: {
  state: Workbench;
  historyPending?: boolean;
}) {
  const loadingScope = JSON.stringify([
    state.hostId,
    state.sessionId,
    state.viewRevision,
  ]);
  const loading = useHistoryLoadingIndicator(!!historyPending, loadingScope);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
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
  const backgroundProjects = JSON.stringify(
    projects
      .filter((p) => p.hostId !== hostId || p.id !== projectId)
      .map((p) => ({ hostId: p.hostId, id: p.id })),
  );
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const targets: { hostId: string; id: string }[] =
        JSON.parse(backgroundProjects);
      for (const project of targets) {
        if (disposed) return;
        const key = `${project.hostId}:${project.id}`;
        try {
          const result = await request(project.hostId, {
            method: "sessions",
            project_id: project.id,
          });
          if (!disposed && result.kind === "sessions") {
            setSessionCache((old) => ({ ...old, [key]: result.sessions }));
          }
        } catch {
          // Keep the last known state; reconnect remains an explicit host action.
        }
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [backgroundProjects, connected, state.modal]);
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
  const liveSessionState = (s: HostedSession) =>
    state.agentSessionState?.(s) ??
    agentSessionState(
      s,
      state.isHostConnected?.(s.hostId) ?? (s.hostId === hostId && connected),
    );
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
    const loadingHistory =
      s.id === sessionId && s.hostId === hostId && loading.visible;
    const liveState = liveSessionState(s);
    const liveLabel = agentSessionLabels[liveState];
    const pendingAgent = liveState === "opening" || liveState === "restoring";
    const loadingLabel = loadingHistory
      ? "正在加载对话"
      : pendingAgent
        ? liveLabel
        : null;
    const row = (
      <SessionHoverCard
        title={s.title}
        project={sourceProject?.name ?? "项目"}
        host={sourceHost?.name ?? s.hostId}
        taskStatus={statusNames[s.status]}
        agentState={liveState}
      >
        <button
          className={`session-row ${shortcut ? "pinned-session" : ""} ${s.id === sessionId && s.hostId === hostId ? "active" : ""}`}
          aria-label={s.title}
          aria-description={`${sourceProject?.name ?? "项目"} · ${sourceHost?.name ?? s.hostId} · ${statusNames[s.status]}${liveState === "closed" ? "" : ` · ${liveLabel}`}`}
          onClick={() => {
            setExpandedProjects((old) => ({
              ...old,
              [`${s.hostId}:${s.project_id}`]: true,
            }));
            state.openSession(s);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.currentTarget.focus();
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
          <span className="session-label">
            {s.title}
            {duplicateTitle && (
              <small>
                {sourceProject?.name} · {sourceHost?.name}
              </small>
            )}
          </span>
          <span className="row-status">
            {loadingLabel ? (
              <span
                className="session-history-loading"
                aria-label={loadingLabel}
                title={loadingLabel}
              >
                <WorkingStatus label="" animated />
              </span>
            ) : s.status === "running" ? (
              <span
                className="session-progress"
                role="img"
                aria-label="执行中"
                title="执行中"
              >
                <i />
                <i />
                <i />
              </span>
            ) : s.status === "waiting" ? (
              <CirclePause
                className="session-waiting"
                size={14}
                role="img"
                aria-label="等待确认"
              >
                <title>等待确认</title>
              </CirclePause>
            ) : s.status === "failed" ? (
              <CircleAlert
                size={14}
                className="failure"
                role="img"
                aria-label="执行失败"
              >
                <title>执行失败</title>
              </CircleAlert>
            ) : s.status === "unknown" ? (
              <CircleHelp size={14} role="img" aria-label="状态待确认">
                <title>状态待确认</title>
              </CircleHelp>
            ) : s.unread ? (
              <span
                className="unread-dot"
                role="img"
                aria-label="未读"
                title="未读"
              />
            ) : null}
          </span>
        </button>
      </SessionHoverCard>
    );
    const menuOpen =
      sessionContext?.session.id === s.id &&
      sessionContext.session.hostId === s.hostId;
    const runAction = async (
      action: Parameters<Workbench["sessionAction"]>[1],
    ) => {
      setActionBusy(`${s.hostId}:${s.id}`);
      try {
        await state.sessionAction(s.hostId, action);
        if (sourceProject) await loadProjectSessions(sourceProject);
      } catch (error) {
        setError(message(error));
      } finally {
        setActionBusy(null);
      }
    };
    return (
      <div
        className="session-item"
        data-menu-open={menuOpen}
        key={`${s.hostId}:${s.id}`}
      >
        {row}
        <div className="session-row-actions">
          <button
            className="icon-button"
            aria-label={`${s.title} 的更多操作`}
            title="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.currentTarget.focus();
              const rect = e.currentTarget.getBoundingClientRect();
              showMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            className="icon-button"
            aria-label={`${s.pinned_at === null ? "置顶" : "取消置顶"} ${s.title}`}
            title={s.pinned_at === null ? "置顶" : "取消置顶"}
            disabled={!!actionBusy || s.archived}
            onClick={() =>
              void runAction({
                method: "pin_session",
                session_id: s.id,
                pinned: s.pinned_at === null,
              })
            }
          >
            {s.pinned_at === null ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button
            className="icon-button"
            aria-label={`${s.archived ? "取消归档" : "归档"} ${s.title}`}
            title={
              ["running", "waiting"].includes(s.status)
                ? "请先停止任务，再归档"
                : s.archived
                  ? "取消归档"
                  : "归档"
            }
            disabled={!!actionBusy || ["running", "waiting"].includes(s.status)}
            onClick={() =>
              void runAction({
                method: "archive_session",
                session_id: s.id,
                archived: !s.archived,
              })
            }
          >
            {s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
        </div>
      </div>
    );
  };
  return (
    <aside
      id="project-sidebar"
      className="sidebar"
      hidden={!state.sidebarOpen}
      data-tauri-drag-region="deep"
    >
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
        <button
          title="添加项目"
          className="icon-button"
          onClick={(event) => {
            event.currentTarget.focus();
            openProject();
          }}
        >
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
          const allSessions = Array.from(
            new Map(
              [
                ...state.pinned.filter(
                  (s) => s.hostId === p.hostId && s.project_id === p.id,
                ),
                ...projectSessions.map((s) => ({ ...s, hostId: p.hostId })),
              ].map((s) => [s.id, s]),
            ).values(),
          ).filter((s) => !s.archived);
          const hasSnapshot =
            (selected && connected) || sessionCache[key] !== undefined;
          const hostConnected =
            state.isHostConnected?.(p.hostId) ??
            (p.hostId === hostId && connected);
          const openStates = allSessions.map((s) => liveSessionState(s));
          const opened =
            hasSnapshot &&
            hostConnected &&
            allSessions.every((s) => s.agent_session_open !== undefined) &&
            openStates.every((s) => s === "open" || s === "closed")
              ? openStates.filter((s) => s === "open").length
              : null;
          const projectHost =
            hosts.find((h) => h.id === p.hostId)?.name ?? p.hostId;
          const noSessions =
            !projectSessions.some((s) => !s.archived) &&
            !state.pinned.some(
              (s) =>
                s.hostId === p.hostId && s.project_id === p.id && !s.archived,
            );
          const empty =
            (selected ? connected : sessionCache[key] !== undefined) &&
            !loadingProjects[key] &&
            !projectErrors[key] &&
            noSessions;
          const running = projectSessions.some((s) => s.status === "running");
          const waiting = projectSessions.some((s) => s.status === "waiting");
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
                className={`project-heading ${selected ? "selected" : ""} ${empty ? "empty" : ""}`}
                data-menu-open={
                  context?.project.id === p.id &&
                  context.project.hostId === p.hostId
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.currentTarget
                    .querySelector<HTMLButtonElement>(".project-row")
                    ?.focus();
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
                <ProjectHoverCard
                  title={p.name}
                  path={p.path}
                  host={projectHost}
                  total={hasSnapshot ? allSessions.length : null}
                  opened={opened}
                >
                  <button
                    className="project-row"
                    onClick={toggle}
                    aria-label={p.name}
                    aria-expanded={expanded}
                    aria-controls={`sessions-${key}`}
                    aria-description={`${p.path} · ${projectHost}`}
                  >
                    <span className="project-folder">
                      {expanded ? (
                        <FolderOpen size={15} />
                      ) : (
                        <Folder size={15} />
                      )}
                      {p.hostId !== "local" && (
                        <span
                          className="project-remote-mark"
                          role="img"
                          aria-label="远程项目"
                          title="远程项目"
                        >
                          <Globe2 size={8} aria-hidden="true" />
                        </span>
                      )}
                    </span>
                    <span className="project-name">{p.name}</span>
                    {p.hostId !== "local" && (
                      <small className="project-host">
                        {hosts.find((h) => h.id === p.hostId)?.name}
                      </small>
                    )}
                    <span className="row-status">
                      {!expanded &&
                        (running ? (
                          <span
                            className="session-progress project-activity"
                            role="img"
                            aria-label="项目中有对话执行中"
                            title="有对话执行中"
                          >
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : waiting ? (
                          <CirclePause
                            className="session-waiting project-activity"
                            size={14}
                            role="img"
                            aria-label="项目中有对话等待确认"
                          />
                        ) : null)}
                    </span>
                  </button>
                </ProjectHoverCard>
                <div className="project-row-actions">
                  <button
                    className="icon-button"
                    aria-label={`${p.name} 的更多操作`}
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={
                      context?.project.id === p.id &&
                      context.project.hostId === p.hostId
                    }
                    onClick={(e) => {
                      e.currentTarget.focus();
                      const rect = e.currentTarget.getBoundingClientRect();
                      showProjectMenu({ x: rect.left, y: rect.bottom });
                    }}
                  >
                    <MoreHorizontal size={14} />
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
                    <SquarePen size={14} />
                  </button>
                </div>
              </div>
              <div id={`sessions-${key}`} hidden={!expanded}>
                {expanded && (
                  <div className="session-list">
                    {projectSessions
                      .filter(
                        (s) =>
                          !s.archived &&
                          s.pinned_at === null &&
                          !state.pinned.some(
                            (pinned) =>
                              pinned.hostId === p.hostId && pinned.id === s.id,
                          ),
                      )
                      .map((s) => sessionRow({ ...s, hostId: p.hostId }))}
                    {noSessions &&
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
      <div className="sidebar-footer">
        <button onClick={() => setModal("settings")}>
          <Settings2 size={16} />
          设置
        </button>
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
