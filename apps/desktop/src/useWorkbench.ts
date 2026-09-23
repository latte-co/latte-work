import { useEffect, useRef, useState } from "react";
import {
  connect,
  loadHosts,
  saveHosts,
  request,
  localHost,
  native,
  message,
  type Host,
} from "./api";
import type {
  AgentInfo,
  Effort,
  Event,
  Project,
  Session,
  Request,
} from "./protocol";
import { appendEvents } from "./transcript";
import { sessionAfterRefresh } from "./sessionSelection";
import { hostedProjects, readCatalog, writeCatalog } from "./projectCatalog";

import {
  pinnedSessions,
  readPinnedCache,
  type HostedSession,
} from "./sessionNavigation";

function readSidebarPreference(): { open: boolean; width: number } {
  try {
    const value = JSON.parse(
      localStorage.getItem("latte-work.sidebar.v1") ?? "null",
    );
    return {
      open: typeof value?.open === "boolean" ? value.open : true,
      width:
        typeof value?.width === "number" && Number.isFinite(value.width)
          ? Math.max(200, Math.min(320, value.width))
          : 244,
    };
  } catch {
    return { open: true, width: 244 };
  }
}

/** Coordinates host transport and durable projections; UI components render this state. */
export function useWorkbench() {
  const [hosts, setHosts] = useState<Host[]>([localHost]);
  const [hostId, setHostId] = useState("local");
  const [retry, setRetry] = useState(0);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [serverId, setServerId] = useState("");
  const [agent, setAgent] = useState<AgentInfo>();
  const [catalog, setCatalog] = useState(readCatalog);
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({});
  const projects = hostedProjects(
    catalog,
    hosts.map((h) => h.id),
  );
  const [projectId, setProjectId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const draft = useRef(false);
  const navigationRevision = useRef(0);
  const [viewRevision, setViewRevision] = useState(0);
  const sending = useRef(false);
  function resetConversationView() {
    navigationRevision.current += 1;
    setViewRevision(navigationRevision.current);
  }
  const selectedSessionId = useRef(sessionId);
  selectedSessionId.current = sessionId;
  const [pinCache, setPinCache] = useState(readPinnedCache);
  const [showArchived, setShowArchived] = useState(false);
  const pendingSession = useRef<{
    hostId: string;
    projectId: string;
    id: string;
  } | null>(null);
  const pinned = pinnedSessions(pinCache, projects, hostId, sessions);
  useEffect(() => {
    try {
      localStorage.setItem(
        "latte-work.pinned-sessions.v1",
        JSON.stringify(pinCache),
      );
    } catch {
      /* Display cache only. */
    }
  }, [pinCache]);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    for (const target of hosts) {
      const pollPins = async () => {
        try {
          const result = await request(target.id, {
            method: "pinned_sessions",
          });
          if (!disposed && result.kind === "sessions") {
            setPinCache((old) => ({ ...old, [target.id]: result.sessions }));
          }
        } catch {
          /* Host discovery/reconnect handles offline hosts. Keep cached shortcuts. */
        }
        if (!disposed)
          timers.set(
            target.id,
            setTimeout(() => void pollPins(), 5000),
          );
      };
      void pollPins();
    }
    return () => {
      disposed = true;
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [hosts]);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"project" | "host" | "settings" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectHostId, setProjectHostId] = useState("local");
  const [ssh, setSsh] = useState("");
  const [serverPath, setServerPath] = useState("");
  const [panel, setPanel] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => readSidebarPreference().open,
  );
  const [leftWidth, setLeftWidth] = useState(
    () => readSidebarPreference().width,
  );
  useEffect(() => {
    try {
      localStorage.setItem(
        "latte-work.sidebar.v1",
        JSON.stringify({ open: sidebarOpen, width: leftWidth }),
      );
    } catch {
      /* Nonessential layout preference. */
    }
  }, [sidebarOpen, leftWidth]);
  function toggleSidebar() {
    if (!sidebarOpen)
      setRightWidth((width) =>
        Math.min(width, Math.max(280, window.innerWidth - leftWidth - 362)),
      );
    setSidebarOpen((open) => !open);
  }
  const [rightWidth, setRightWidth] = useState(350);
  const host = hosts.find((h) => h.id === hostId) ?? localHost;
  const project = projects.find(
    (p) => p.id === projectId && p.hostId === hostId,
  );
  const session = sessions.find((s) => s.id === sessionId);
  const selection = useRef({ hostId, projectId });
  selection.current = { hostId, projectId };
  const pendingSend = useRef<
    | {
        id: string;
        host: string;
        session: string;
        text: string;
        model: string | null;
        effort: Effort | null;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (native)
      void loadHosts()
        .then(setHosts)
        .catch((e) => setError(message(e)));
  }, []);
  useEffect(() => writeCatalog(catalog), [catalog]);
  function updateProjects(id: string, values: Project[]) {
    setCatalog((old) => ({ ...old, [id]: values }));
  }
  async function refreshHost(target: Host) {
    try {
      const hello = await connect(target);
      if (hello.kind !== "hello")
        throw new Error(hello.kind === "error" ? hello.message : "连接失败");
      const result = await request(target.id, { method: "projects" });
      if (result.kind === "projects")
        updateProjects(target.id, result.projects);
      setHostErrors((old) => ({ ...old, [target.id]: "" }));
      if (target.id === selection.current.hostId) setRetry((v) => v + 1);
    } catch (e) {
      setHostErrors((old) => ({ ...old, [target.id]: message(e) }));
    }
  }
  // Discover each saved host independently; one offline host cannot hide the others.
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    for (const target of hosts) {
      void connect(target)
        .then(async (hello) => {
          if (hello.kind !== "hello")
            throw new Error(
              hello.kind === "error" ? hello.message : "连接失败",
            );
          const result = await request(target.id, { method: "projects" });
          if (!disposed && result.kind === "projects") {
            updateProjects(target.id, result.projects);
            setHostErrors((old) => ({ ...old, [target.id]: "" }));
          }
        })
        .catch((e) => {
          if (!disposed)
            setHostErrors((old) => ({ ...old, [target.id]: message(e) }));
        });
    }
    return () => {
      disposed = true;
    };
  }, [hosts]);
  useEffect(() => {
    if (!native) {
      setError("请通过 make dev 启动桌面应用。浏览器预览不连接主机。");
      return;
    }
    let disposed = false;
    setConnecting(true);
    setConnected(false);
    void connect(host)
      .then(async (r) => {
        if (disposed) return;
        if (r.kind !== "hello")
          throw new Error(r.kind === "error" ? r.message : "Server 握手失败");
        setServerId(r.server_id);
        setAgent(r.agents.find((a) => a.id === "claude"));
        const result = await request(host.id, { method: "projects" });
        if (disposed) return;
        if (result.kind === "projects") {
          updateProjects(host.id, result.projects);
          setProjectId((id) =>
            result.projects.some((p) => p.id === id)
              ? id
              : (result.projects[0]?.id ?? ""),
          );
        }
        setConnected(true);
        setHostErrors((old) => ({ ...old, [host.id]: "" }));
        setError("");
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      })
      .finally(() => {
        if (!disposed) setConnecting(false);
      });
    return () => {
      disposed = true;
    };
    // Host changes are keyed by immutable id; retry reconnects without dropping history.
  }, [hostId, retry]);
  useEffect(() => {
    if (connected || connecting || !native) return;
    const timer = setTimeout(() => setRetry((v) => v + 1), 5000);
    return () => clearTimeout(timer);
  }, [connected, connecting]);
  useEffect(() => {
    if (!projectId || !connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const r = await request(hostId, {
          method: "sessions",
          project_id: projectId,
        });
        if (!disposed && r.kind === "sessions") {
          const pending = pendingSession.current;
          const desired =
            pending?.hostId === hostId && pending.projectId === projectId
              ? pending.id
              : null;
          if (desired && !r.sessions.some((s) => s.id === desired)) {
            const detail = await request(hostId, {
              method: "poll",
              session_id: desired,
              after: Number.MAX_SAFE_INTEGER,
            });
            if (disposed) return;
            if (
              detail.kind === "events" &&
              detail.session.project_id === projectId
            )
              r.sessions.push(detail.session);
          }
          if (desired) pendingSession.current = null;
          setSessions((old) => {
            const selected = old.find(
              (s) => s.id === selectedSessionId.current,
            );
            return selected && !r.sessions.some((s) => s.id === selected.id)
              ? [...r.sessions, selected]
              : r.sessions;
          });
          setSessionId((id) =>
            sessionAfterRefresh(id, desired, r.sessions, draft.current),
          );
        }
      } catch (e) {
        if (!disposed) setError(message(e));
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [projectId, hostId, connected]);
  useEffect(() => {
    if (!sessionId || !connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    setEvents([]);
    const poll = async () => {
      try {
        const r = await request(hostId, {
          method: "poll",
          session_id: sessionId,
          after: cursor,
        });
        if (disposed) return;
        if (r.kind === "events") {
          cursor = r.events.at(-1)?.seq ?? cursor;
          setEvents((previous) => appendEvents(previous, r.events));
          setSessions((previous) =>
            previous.map((s) => (s.id === r.session.id ? r.session : s)),
          );
          timer = setTimeout(() => void poll(), r.has_more ? 0 : 650);
        }
      } catch (e) {
        if (!disposed) {
          setError(message(e));
          setConnected(false);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, hostId, connected]);
  function updateSession(targetHostId: string, value: Session) {
    setPinCache((old) => ({
      ...old,
      [targetHostId]: [
        ...(old[targetHostId] ?? []).filter((s) => s.id !== value.id),
        ...(value.pinned_at !== null && !value.archived ? [value] : []),
      ],
    }));
    if (
      selection.current.hostId === targetHostId &&
      selection.current.projectId === value.project_id
    )
      setSessions((old) => old.map((s) => (s.id === value.id ? value : s)));
  }
  async function sessionAction(targetHostId: string, action: Request) {
    const result = await request(targetHostId, action);
    if (result.kind === "session") updateSession(targetHostId, result.session);
    else if (result.kind !== "ok") throw new Error("会话操作失败");
  }
  function openSession(target: HostedSession) {
    selectProject(target.hostId, target.project_id);
    draft.current = false;
    if (target.id !== sessionId) resetConversationView();
    pendingSession.current = {
      hostId: target.hostId,
      projectId: target.project_id,
      id: target.id,
    };
    setShowArchived(target.archived);
    if (target.hostId === hostId && target.project_id === projectId) {
      pendingSession.current = null;
      if (target.id !== sessionId) {
        setEvents([]);
        setSessionId(target.id);
      }
    }
    if (
      target.unread &&
      target.hostId === hostId &&
      target.id === sessionId &&
      connected
    )
      void sessionAction(target.hostId, {
        method: "mark_session_unread",
        session_id: target.id,
        unread: false,
      }).catch((e) => setError(message(e)));
  }
  useEffect(() => {
    if (!connected || !sessionId) return;
    let disposed = false;
    void request(hostId, {
      method: "mark_session_unread",
      session_id: sessionId,
      unread: false,
    })
      .then((r) => {
        if (!disposed && r.kind === "session") updateSession(hostId, r.session);
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      });
    return () => {
      disposed = true;
    };
  }, [hostId, sessionId, connected]);
  async function createSession(): Promise<void> {
    if (!project || !connected) return;
    pendingSession.current = null;
    draft.current = true;
    selectedSessionId.current = "";
    setSessionId("");
    setEvents([]);
    setShowArchived(false);
    setError("");
    resetConversationView();
  }
  async function persistSession(
    revision: number,
  ): Promise<Session | undefined> {
    if (!project) return;
    const r = await request(hostId, {
      method: "create_session",
      project_id: project.id,
      agent: "claude",
    });
    if (r.kind === "session") {
      if (
        selection.current.hostId === hostId &&
        selection.current.projectId === project.id
      ) {
        setSessions((old) => [
          r.session,
          ...old.filter((s) => s.id !== r.session.id),
        ]);
        if (navigationRevision.current === revision) {
          draft.current = false;
          selectedSessionId.current = r.session.id;
          setShowArchived(false);
          setSessionId(r.session.id);
          setEvents([]);
        }
      }
      return r.session;
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "n" &&
        !modal &&
        connected &&
        projectId
      ) {
        event.preventDefault();
        void createSession().catch((e) => setError(message(e)));
      }
      if (event.key === "Escape" && !busy && modal !== "settings")
        setModal(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [projectId, hostId, connected, modal, busy]);
  async function send(
    text: string,
    model: string | null,
    effort: Effort | null,
  ): Promise<boolean> {
    if (!connected || !text.trim() || sending.current) return false;
    sending.current = true;
    try {
      const target =
        session ?? (await persistSession(navigationRevision.current));
      if (!target) return false;
      const old = pendingSend.current;
      const id =
        old?.host === hostId &&
        old.session === target.id &&
        old.text === text &&
        old.model === model &&
        old.effort === effort
          ? old.id
          : crypto.randomUUID();
      pendingSend.current = {
        id,
        host: hostId,
        session: target.id,
        text,
        model,
        effort,
      };
      await request(hostId, {
        method: "send",
        session_id: target.id,
        request_id: id,
        text,
        model,
        effort,
      });
      if (pendingSend.current?.id === id) pendingSend.current = undefined;
      if (
        selection.current.hostId !== hostId ||
        selection.current.projectId !== projectId
      )
        return true;
      setSessions((previous) =>
        previous.map((s) =>
          s.id === target.id ? { ...s, status: "running", model, effort } : s,
        ),
      );
      setError("");
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      sending.current = false;
    }
  }
  async function addProject(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const target = hosts.find((h) => h.id === projectHostId);
      if (!target) throw new Error("请选择项目所在主机");
      const hello = await connect(target);
      if (hello.kind !== "hello")
        throw new Error(hello.kind === "error" ? hello.message : "连接失败");
      const r = await request(target.id, {
        method: "add_project",
        path: projectPath.trim(),
        name: projectName.trim() || null,
      });
      if (r.kind === "project") {
        setCatalog((old) => ({
          ...old,
          [target.id]: [
            ...(old[target.id] ?? []).filter((p) => p.id !== r.project.id),
            r.project,
          ],
        }));
        selectProject(target.id, r.project.id);
        if (target.id === hostId && !connected) setRetry((v) => v + 1);
        setModal(null);
        setProjectPath("");
        setError("");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function addHost(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const value: Host = {
        id: crypto.randomUUID(),
        name: ssh.trim(),
        ssh: ssh.trim(),
        server_path: serverPath.trim(),
      };
      const result = await connect(value);
      if (result.kind !== "hello") throw new Error("远程 Server 握手失败");
      const updated = [...hosts, value];
      await saveHosts(updated);
      setHosts(updated);
      setProjectHostId(value.id);
      setProjectPath("");
      setModal("project");
      setSsh("");
      setServerPath("");
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function selectProject(targetHostId: string, id: string) {
    pendingSession.current = null;
    if (id === projectId && targetHostId === hostId) return;
    draft.current = false;
    resetConversationView();
    if (targetHostId !== hostId) {
      setConnected(false);
      setAgent(undefined);
      setServerId("");
      setHostId(targetHostId);
    }
    setShowArchived(false);
    setError("");
    setProjectId(id);
    setSessions([]);
    setSessionId("");
    setEvents([]);
  }
  async function renameProject(targetHostId: string, id: string, name: string) {
    const result = await request(targetHostId, {
      method: "rename_project",
      project_id: id,
      name,
    });
    if (result.kind !== "project") throw new Error("项目更新失败");
    setCatalog((old) => ({
      ...old,
      [targetHostId]: (old[targetHostId] ?? []).map((p) =>
        p.id === id ? result.project : p,
      ),
    }));
  }
  async function removeProject(targetHostId: string, id: string) {
    const result = await request(targetHostId, {
      method: "remove_project",
      project_id: id,
    });
    if (result.kind !== "projects") throw new Error("项目移除失败");
    updateProjects(targetHostId, result.projects);
    if (
      selection.current.hostId === targetHostId &&
      selection.current.projectId === id
    )
      selectProject(targetHostId, result.projects[0]?.id ?? "");
  }
  function openProject() {
    setProjectHostId(hostId);
    setProjectPath("");
    setProjectName("");
    setError("");
    setModal("project");
  }
  function resize(e: React.PointerEvent, side: "left" | "right") {
    const x = e.clientX;
    const width = side === "left" ? leftWidth : rightWidth;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => {
      const value = width + (event.clientX - x) * (side === "left" ? 1 : -1);
      if (side === "left")
        setLeftWidth(
          Math.max(
            200,
            Math.min(
              320,
              window.innerWidth - (panel ? rightWidth : 0) - 362,
              value,
            ),
          ),
        );
      else
        setRightWidth(
          Math.max(
            280,
            Math.min(
              600,
              window.innerWidth - (sidebarOpen ? leftWidth : 0) - 362,
              value,
            ),
          ),
        );
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }
  return {
    hosts,
    hostId,
    setHostId,
    connected,
    connecting,
    serverId,
    agent,
    projects,
    hostErrors,
    projectId,
    sessions,
    pinned,
    openSession,
    sessionAction,
    showArchived,
    setShowArchived,
    sessionId,
    viewRevision,
    setSessionId,
    events,
    setEvents,
    error,
    setError,
    modal,
    setModal,
    busy,
    projectPath,
    setProjectPath,
    projectName,
    setProjectName,
    projectHostId,
    setProjectHostId,
    openProject,
    renameProject,
    removeProject,
    refreshHost,
    ssh,
    setSsh,
    serverPath,
    setServerPath,
    panel,
    setPanel,
    sidebarOpen,
    toggleSidebar,
    leftWidth,
    rightWidth,
    host,
    project,
    session,
    createSession,
    send,
    addProject,
    addHost,
    selectProject,
    resize,
    setRetry,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
