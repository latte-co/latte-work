import { TaskOverview } from "./TaskOverview";
import { useAppLifecycle } from "./appLifecycle";
import { useCallback, useRef, useState } from "react";
import { DraftStore } from "./drafts";
import {
  Folder,
  Monitor,
  PanelRight,
  PanelLeft,
  MessageCirclePlus,
  X,
  RefreshCw,
  Circle,
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
import { useSubagents } from "./useSubagents";
import { latestTurnChanges } from "./transcript";
import {
  openWorkspaceResource,
  openTurnChanges,
  openSubagents,
  CONVERSATION_MIN_WIDTH,
} from "./workspaceState";

export default function App() {
  useAppLifecycle();
  const workbench = useWorkbench();
  const drafts = useRef(new DraftStore()).current;
  const historyScope = JSON.stringify([
    workbench.hostId,
    workbench.sessionId,
    workbench.viewRevision,
  ]);
  const [readyHistoryScope, setReadyHistoryScope] = useState<string | null>(
    null,
  );
  const historyReady = useCallback(
    () => setReadyHistoryScope(historyScope),
    [historyScope],
  );
  const historyPending =
    !!workbench.sessionId &&
    (workbench.connected || workbench.connecting) &&
    (workbench.historyLoading || readyHistoryScope !== historyScope);
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
  const subagents = useSubagents(hostId, session?.id, connected, events);
  const lastTurn = latestTurnChanges(events);
  const lastTurnVersion = lastTurn
    ? JSON.stringify([
        lastTurn.request_id,
        lastTurn.undo,
        lastTurn.interrupted,
        lastTurn.background_pending,
      ])
    : undefined;
  const showSubagents = () => openSubagents(workbench.workspaceId);
  const merged = panel && workbench.workspace.expanded;
  const conversationHidden = merged && !workbench.workspace.conversationActive;
  const overview = (
    <TaskOverview
      key={workbench.workspaceId}
      hostId={hostId}
      project={project}
      connected={connected}
      subagents={subagents}
      openChanges={() => openWorkspaceResource(workbench.workspaceId, "diff")}
      openSubagents={showSubagents}
    />
  );
  return (
    <>
      <div
        hidden={workbench.modal === "settings"}
        className={`app ${sidebarOpen ? "" : "sidebar-collapsed"}${panel ? " workspace-visible" : ""}${merged ? " workspace-merged" : ""}`}
        style={
          {
            "--sidebar-width": `${leftWidth}px`,
            "--conversation-min-width": `${CONVERSATION_MIN_WIDTH}px`,
            "--workspace-width": `${rightWidth}px`,
          } as React.CSSProperties
        }
      >
        <Sidebar state={workbench} historyPending={historyPending} />
        <div
          className="resize-handle"
          role="separator"
          hidden={!sidebarOpen}
          aria-label="调整侧栏宽度"
          onPointerDown={(e) => resize(e, "left")}
        />
        <main
          id="conversation-panel"
          className={`main${conversationHidden ? " conversation-hidden" : ""}`}
          role={merged ? "tabpanel" : undefined}
          aria-labelledby={merged ? "conversation-workspace-tab" : undefined}
          aria-hidden={conversationHidden || undefined}
          inert={conversationHidden}
        >
          <header
            className="topbar"
            data-tauri-drag-region="deep"
            inert={merged}
            aria-hidden={merged || undefined}
          >
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
              {overview}
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
          {connected && (error || agent?.available === false) && (
            <div className="connection-banner">
              <Circle size={10} />
              <span>{error || agent?.detail}</span>
              <button title="重新连接" onClick={() => setRetry((v) => v + 1)}>
                <RefreshCw size={13} />
              </button>
              {error && (
                <button title="关闭提示" onClick={() => setError("")}>
                  <X size={13} />
                </button>
              )}
            </div>
          )}
          <Conversation
            subagents={subagents}
            openSubagents={showSubagents}
            openTurnChanges={(changes, path) => {
              if (session)
                openTurnChanges(
                  workbench.workspaceId,
                  session.id,
                  changes.request_id,
                  changes.summary.baseline_at,
                  path,
                );
            }}
            drafts={drafts}
            agent={agent}
            session={session}
            hostId={hostId}
            agentSessionState={
              session
                ? workbench.agentSessionState({ ...session, hostId })
                : undefined
            }
            agentSessionError={
              session
                ? workbench.agentSessionTransitions[
                    JSON.stringify([hostId, session.id])
                  ]?.error
                : undefined
            }
            onModelReady={() =>
              setError((old) => (old.startsWith("模型不在当前") ? "" : old))
            }
            settingsOpen={workbench.modal === "settings" || conversationHidden}
            events={events}
            historyLoading={workbench.historyLoading}
            hasEarlierHistory={workbench.hasEarlierHistory}
            earlierHistoryLoading={workbench.earlierHistoryLoading}
            loadEarlierHistory={workbench.loadEarlierHistory}
            readingScope={workbench.readingScope}
            readingPositions={workbench.readingPositions}
            onHistoryReady={historyReady}
            connected={connected}
            connecting={connecting}
            connectionError={error}
            connectionLost={workbench.connectionLost}
            reconnect={() => setRetry((v) => v + 1)}
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
            cancel={async () => {
              if (!session) return false;
              try {
                await request(hostId, {
                  method: "cancel",
                  session_id: session.id,
                });
                return true;
              } catch (e) {
                setError(message(e));
                return false;
              }
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
        <div
          className="resize-handle workspace-resize"
          hidden={!panel || merged}
          role="separator"
          aria-label="调整工作区宽度"
          onPointerDown={(e) => resize(e, "right")}
        />
        <Workspace
          sessionId={session?.id}
          lastTurnVersion={lastTurnVersion}
          overview={overview}
          subagents={subagents}
          workspaceId={workbench.workspaceId}
          conversationTitle={session?.title ?? "新任务"}
          sidebarOpen={sidebarOpen}
          toggleSidebar={toggleSidebar}
          hostId={hostId}
          hostName={host.name}
          project={project}
          visible={panel && workbench.modal !== "settings"}
          connected={connected}
          close={() =>
            merged ? workbench.restoreWorkspace() : setPanel(false)
          }
        />
        <HostDialogs state={workbench} />
      </div>
      <div hidden={workbench.modal !== "settings"}>
        <SettingsPage
          state={workbench}
          active={workbench.modal === "settings"}
        />
      </div>
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
