import {
  Folder,
  Monitor,
  PanelRight,
  PanelLeft,
  MessageCirclePlus,
  X,
  RefreshCw,
  Circle,
  LoaderCircle,
  Globe,
} from "lucide-react";
import { request, message } from "./api";
import { Conversation } from "./Conversation";
import { Workspace } from "./Workspace";
import { Sidebar } from "./Sidebar";
import { SettingsPage } from "./SettingsPage";
import { HostDialogs } from "./HostDialogs";
import { SshPasswordDialog } from "./SshPasswordDialog";
import { useWorkbench } from "./useWorkbench";

export default function App() {
  const workbench = useWorkbench();
  const {
    hostId,
    connected,
    connecting,
    agent,
    projectId,
    events,
    error,
    setError,
    panel,
    setPanel,
    sidebarOpen,
    toggleSidebar,
    leftWidth,
    rightWidth,
    host,
    project,
    session,
    send,
    resize,
    setRetry,
  } = workbench;
  return (
    <>
      <div
        hidden={workbench.modal === "settings"}
        className={`app ${sidebarOpen ? "" : "sidebar-collapsed"}`}
        style={
          {
            "--sidebar-width": `${leftWidth}px`,
            "--workspace-width": `${rightWidth}px`,
          } as React.CSSProperties
        }
      >
        <Sidebar state={workbench} />
        <div
          className="resize-handle"
          role="separator"
          hidden={!sidebarOpen}
          aria-label="调整侧栏宽度"
          onPointerDown={(e) => resize(e, "left")}
        />
        <main className="main">
          <header className="topbar" data-tauri-drag-region>
            <div className="topbar-project">
              {!sidebarOpen && (
                <div className="topbar-controls">
                  <button
                    className="panel-toggle icon-button"
                    title="展开侧栏"
                    aria-label="展开侧栏"
                    aria-expanded={false}
                    aria-controls="project-sidebar"
                    onClick={toggleSidebar}
                  >
                    <PanelLeft size={16} />
                  </button>
                  <button
                    className="panel-toggle icon-button"
                    title="新对话 (⌘ N)"
                    aria-label="新对话"
                    onClick={() =>
                      void workbench
                        .createSession()
                        .catch((e) => setError(message(e)))
                    }
                  >
                    <MessageCirclePlus size={16} />
                  </button>
                </div>
              )}
              <Folder size={16} />
              <strong>{project?.name ?? "工作台"}</strong>
              <span className="topbar-slash">/</span>
              <span>{session?.title ?? "新任务"}</span>
            </div>
            <div className="topbar-actions">
              <span className="host-pill">
                {host.ssh ? <Globe size={12} /> : <Monitor size={12} />}
                {host.name}
              </span>
              <button
                className="panel-toggle icon-button"
                title={panel ? "收起工作区" : "展开工作区"}
                aria-label={panel ? "收起工作区" : "展开工作区"}
                aria-expanded={panel}
                aria-controls="project-workspace"
                onClick={() => setPanel((v) => !v)}
              >
                <PanelRight size={16} />
              </button>
            </div>
          </header>
          {(!connected || error || agent?.available === false) && (
            <div className="connection-banner">
              {connecting ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Circle size={10} />
              )}
              <span>
                {connecting
                  ? `正在连接 ${host.name}…`
                  : error ||
                    agent?.detail ||
                    "连接中断，正在重连。已启动的任务保留在 Host 上。"}
              </span>
              {!connecting && (
                <button title="重新连接" onClick={() => setRetry((v) => v + 1)}>
                  <RefreshCw size={13} />
                </button>
              )}
              {error && connected && (
                <button title="关闭提示" onClick={() => setError("")}>
                  <X size={13} />
                </button>
              )}
            </div>
          )}
          <Conversation
            key={
              session
                ? `${hostId}:${projectId}:${session.id}:${workbench.viewRevision}`
                : `draft:${workbench.viewRevision}`
            }
            session={session}
            hostId={hostId}
            settingsOpen={workbench.modal === "settings"}
            events={events}
            connected={connected}
            available={agent?.available ?? false}
            projectName={project?.name}
            projectId={project?.id}
            project={project}
            projects={workbench.projects}
            hosts={workbench.hosts}
            selectTaskProject={(target) => {
              try {
                workbench.selectTaskProject(target);
              } catch (cause) {
                setError(message(cause));
              }
            }}
            openProject={workbench.openProject}
            send={send}
            cancel={() => {
              if (session)
                void request(hostId, {
                  method: "cancel",
                  session_id: session.id,
                }).catch((e) => setError(message(e)));
            }}
            approve={async (id, allow) => {
              if (!session) return;
              try {
                await request(hostId, {
                  method: "approve",
                  session_id: session.id,
                  request_id: id,
                  allow,
                });
              } catch (e) {
                setError(message(e));
              }
            }}
          />
        </main>
        {panel && (
          <>
            <div
              className="resize-handle"
              role="separator"
              aria-label="调整工作区宽度"
              onPointerDown={(e) => resize(e, "right")}
            />
            <Workspace
              key={`${hostId}:${projectId}`}
              hostId={hostId}
              project={project}
              close={() => setPanel(false)}
            />
          </>
        )}
        <HostDialogs state={workbench} />
      </div>
      {workbench.modal === "settings" && <SettingsPage state={workbench} />}
      {workbench.passwordPrompt && (
        <SshPasswordDialog
          key={workbench.passwordPrompt.id}
          host={workbench.passwordPrompt}
          submit={workbench.submitPassword}
          cancel={workbench.cancelPasswordPrompt}
        />
      )}
    </>
  );
}
