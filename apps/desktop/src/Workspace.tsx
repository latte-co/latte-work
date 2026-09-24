import { useWorkspaceState, type WorkspaceTab as Tab } from "./workspaceState";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Files,
  GitCompareArrows,
  TerminalSquare,
  Plus,
  X,
  PanelRight,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { Project } from "./protocol";
import { request, message } from "./api";
import { WorkspaceFiles } from "./WorkspaceFiles";
import { TerminalPane } from "./TerminalPane";

type Kind = "terminal" | "files" | "diff";

const labels = { terminal: "终端", files: "文件", diff: "改动" };
const icons = {
  terminal: TerminalSquare,
  files: Files,
  diff: GitCompareArrows,
};

export function Workspace({
  workspaceId,
  hostId,
  hostName,
  project,
  visible,
  connected,
  close,
}: {
  workspaceId: string;
  hostId: string;
  hostName: string;
  project?: Project;
  visible: boolean;
  connected: boolean;
  close: () => void;
}) {
  const [state, update] = useWorkspaceState(workspaceId);
  const expanded = state.expanded;
  // Keep each visited conversation mounted so switching preserves its emulator.
  const [pages, setPages] = useState<
    { key: string; hostId: string; hostName: string; project: Project }[]
  >([]);
  useEffect(() => {
    if (!project) return;
    const key = workspaceId;
    setPages((pages) =>
      pages.some((p) => p.key === key)
        ? pages
        : [...pages, { key, hostId, hostName, project }],
    );
  }, [workspaceId, hostId, hostName, project]);
  return (
    <aside
      id="project-workspace"
      className={`workspace${expanded ? " expanded" : ""}`}
      hidden={!visible}
    >
      {pages.map((page) => {
        const selected = !!project && page.key === workspaceId;
        return (
          <WorkspacePage
            key={page.key}
            workspaceId={page.key}
            hostId={selected ? hostId : page.hostId}
            hostName={selected ? hostName : page.hostName}
            project={selected ? project! : page.project}
            selected={selected}
            active={selected && visible}
            connected={selected && connected}
            expanded={expanded}
            expand={() => update((state) => ({ expanded: !state.expanded }))}
            close={close}
          />
        );
      })}
      {!project && (
        <div className="workspace-page empty">
          <header data-tauri-drag-region="deep">
            <div className="workspace-header-space" data-tauri-drag-region />
            <button
              className="icon-button"
              aria-label="收起工作区"
              onClick={close}
            >
              <PanelRight size={16} />
            </button>
          </header>
          <div className="workspace-empty" aria-label="工作区入口">
            <div className="workspace-launchers">
              {(["diff", "terminal", "files"] as const).map((kind) => {
                const Icon = icons[kind];
                return (
                  <button key={kind} disabled title="选择项目后打开">
                    <Icon size={18} />
                    <span>{labels[kind]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function WorkspacePage({
  workspaceId,
  hostId,
  hostName,
  project,
  selected,
  active,
  connected,
  expanded,
  expand,
  close,
}: {
  hostId: string;
  hostName: string;
  workspaceId: string;
  project: Project;
  selected: boolean;
  active: boolean;
  connected: boolean;
  expanded: boolean;
  expand: () => void;
  close: () => void;
}) {
  const [state, update] = useWorkspaceState(workspaceId);
  const { tabs, current } = state;
  const setTabs = (value: Tab[] | ((tabs: Tab[]) => Tab[])) =>
    update((state) => ({
      tabs: typeof value === "function" ? value(state.tabs) : value,
    }));
  const select = (id: string) => update({ current: id });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [revision, refresh] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const tabPrefix = useId();
  const tablist = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (active)
      tablist.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.closest(".workspace-tab")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, current]);
  useEffect(() => {
    if (!selected || !connected) return;
    let disposed = false;
    const groups = new Map<
      string,
      { hostId: string; projectId: string; ids: Set<string> }
    >();
    for (const tab of tabs) {
      if (tab.kind !== "terminal") continue;
      const ownerHost = tab.hostId ?? hostId;
      const projectId = tab.terminal.project_id;
      const key = JSON.stringify([ownerHost, projectId]);
      const group = groups.get(key) ?? {
        hostId: ownerHost,
        projectId,
        ids: new Set<string>(),
      };
      group.ids.add(tab.id);
      groups.set(key, group);
    }
    if (!groups.size) return;
    void Promise.all(
      [...groups.values()].map(async (group) => {
        const response = await request(group.hostId, {
          method: "terminals",
          project_id: group.projectId,
        });
        if (response.kind !== "terminals")
          throw new Error("终端列表响应格式不匹配");
        return { group, terminals: response.terminals };
      }),
    )
      .then((results) => {
        if (disposed) return;
        // The conversation owns the tabs; each terminal retains its original host.
        setTabs((tabs) =>
          tabs.flatMap<Tab>((tab) => {
            if (tab.kind !== "terminal") return [tab];
            const result = results.find(
              (r) =>
                r.group.hostId === (tab.hostId ?? hostId) &&
                r.group.ids.has(tab.id),
            );
            if (!result) return [tab];
            const terminal = result.terminals.find(
              (t) => t.id === tab.id && t.project_id === result.group.projectId,
            );
            return terminal ? [{ ...tab, terminal }] : [];
          }),
        );
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      });
    return () => {
      disposed = true;
    };
  }, [selected, connected, hostId, project.id, revision]);
  useEffect(() => {
    if (!active) setMenu(false);
  }, [active]);
  async function add(kind: Kind) {
    setMenu(false);
    setError("");
    if (kind !== "terminal") {
      setTabs((tabs) =>
        tabs.some((t) => t.id === kind)
          ? tabs
          : [...tabs, { id: kind, kind, hostId, hostName, project }],
      );
      select(kind);
      return;
    }
    setBusy(true);
    const terminalId = crypto.randomUUID();
    update((state) => ({
      tabs: [
        ...state.tabs,
        {
          id: terminalId,
          kind: "terminal",
          hostId,
          hostName,
          project,
          terminal: {
            id: terminalId,
            project_id: project.id,
            title: "终端",
            exited: false,
            exit_code: null,
          },
        },
      ],
      current: terminalId,
    }));
    try {
      const response = await request(hostId, {
        method: "create_terminal",
        project_id: project.id,
        terminal_id: terminalId,
        cols: 80,
        rows: 24,
      });
      if (response.kind !== "terminal") throw new Error("无法创建终端");
      setTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === terminalId
            ? { ...tab, kind: "terminal", terminal: response.terminal }
            : tab,
        ),
      );
    } catch (e) {
      setError(message(e));
      // Recover a creation whose reply was lost by listing, never blindly respawn.
      refresh((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  async function remove(tab: Tab) {
    setBusy(true);
    setError("");
    try {
      if (tab.kind === "terminal")
        await request(tab.hostId ?? hostId, {
          method: "close_terminal",
          terminal_id: tab.id,
        });
      setTabs((tabs) => tabs.filter((t) => t.id !== tab.id));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const title = (tab: Tab) =>
    tab.kind === "terminal"
      ? `${tab.terminal.title} · ${tab.hostName ?? hostName}`
      : labels[tab.kind];
  return (
    <div
      className={`workspace-page${tabs.length ? "" : " empty"}`}
      hidden={!selected}
    >
      <header data-tauri-drag-region="deep">
        <div
          ref={tablist}
          className="workspace-tabs"
          role="tablist"
          aria-label="工作区标签"
        >
          {tabs.map((tab) => {
            const Icon = icons[tab.kind];
            return (
              <div
                key={tab.id}
                className={`workspace-tab${current === tab.id ? " active" : ""}`}
              >
                <button
                  role="tab"
                  id={`tab-${tabPrefix}-${tab.id}`}
                  aria-selected={current === tab.id}
                  aria-controls={`pane-${tabPrefix}-${tab.id}`}
                  tabIndex={current === tab.id ? 0 : -1}
                  title={title(tab)}
                  onClick={() => select(tab.id)}
                  onKeyDown={(e) => {
                    if (
                      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                    ) {
                      e.preventDefault();
                      const index = tabs.indexOf(tab);
                      const next =
                        tabs[
                          e.key === "Home"
                            ? 0
                            : e.key === "End"
                              ? tabs.length - 1
                              : (index +
                                  (e.key === "ArrowRight" ? 1 : -1) +
                                  tabs.length) %
                                tabs.length
                        ];
                      select(next.id);
                      e.currentTarget
                        .closest('[role="tablist"]')
                        ?.querySelector<HTMLButtonElement>(
                          `[id="tab-${tabPrefix}-${next.id}"]`,
                        )
                        ?.focus();
                    }
                  }}
                >
                  <Icon size={16} />
                  <span>{title(tab)}</span>
                </button>
                <button
                  className="tab-close icon-button"
                  aria-label={`关闭${title(tab)}`}
                  title={
                    tab.kind === "terminal"
                      ? "关闭终端并结束其中的进程"
                      : "关闭标签"
                  }
                  disabled={busy || (tab.kind === "terminal" && !connected)}
                  onClick={() => void remove(tab)}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
        {tabs.length > 0 && (
          <button
            ref={trigger}
            className="icon-button workspace-add"
            aria-label="添加工作区标签"
            title="添加标签"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={busy}
            onClick={() => setMenu((v) => !v)}
          >
            <Plus size={18} />
          </button>
        )}
        <div className="workspace-header-space" data-tauri-drag-region />
        <button
          className="icon-button"
          aria-label={expanded ? "还原工作区" : "展开工作区到主区域"}
          title={expanded ? "还原" : "展开"}
          onClick={expand}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          className="icon-button"
          title="收起工作区"
          aria-label="收起工作区"
          onClick={close}
        >
          <PanelRight size={16} />
        </button>
      </header>
      {menu && trigger.current && (
        <AddMenu
          trigger={trigger.current}
          connected={connected}
          close={() => {
            setMenu(false);
            trigger.current?.focus();
          }}
          choose={(kind) => void add(kind)}
        />
      )}
      {error && (
        <div className="terminal-notice" role="alert">
          <span>{error}</span>
          <button
            onClick={() => {
              setError("");
              refresh((v) => v + 1);
            }}
          >
            刷新
          </button>
        </div>
      )}
      {tabs.map((tab) => (
        <section
          key={tab.id}
          id={`pane-${tabPrefix}-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tabPrefix}-${tab.id}`}
          className="workspace-pane"
          hidden={current !== tab.id}
        >
          {tab.kind === "terminal" ? (
            <TerminalPane
              hostId={tab.hostId ?? hostId}
              terminal={tab.terminal}
              active={active && current === tab.id && !busy}
              connected={connected}
            />
          ) : (
            <WorkspaceFiles
              hostId={tab.hostId ?? hostId}
              project={tab.project ?? project}
              tab={tab.kind}
              path={tab.path ?? ""}
              file={tab.file ?? ""}
              navigate={(value) =>
                setTabs((tabs) =>
                  tabs.map((t) => (t.id === tab.id ? { ...t, ...value } : t)),
                )
              }
              active={active && current === tab.id && connected}
            />
          )}
        </section>
      ))}
      {!tabs.length && (
        <div className="workspace-empty" aria-label="工作区入口">
          <div className="workspace-launchers">
            {(["diff", "terminal", "files"] as const).map((kind) => {
              const Icon = icons[kind];
              return (
                <button
                  key={kind}
                  disabled={!connected || busy}
                  onClick={() => void add(kind)}
                >
                  <Icon size={18} />
                  <span>{labels[kind]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function AddMenu({
  trigger,
  connected,
  close,
  choose,
}: {
  trigger: HTMLButtonElement;
  connected: boolean;
  close: () => void;
  choose: (kind: Kind) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const rect = trigger.getBoundingClientRect();
  useEffect(() => {
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const outside = (e: PointerEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !trigger.contains(e.target as Node)
      )
        close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
      if (e.key === "Tab") close();
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const buttons = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length
        ]?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
    };
  }, [trigger, close]);
  return createPortal(
    <div
      className="workspace-add-menu project-context-menu"
      ref={menu}
      role="menu"
      aria-label="添加工作区标签"
      style={{
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 232)),
        top: Math.min(rect.bottom + 6, window.innerHeight - 132),
      }}
    >
      {(["diff", "terminal", "files"] as const).map((kind) => {
        const Icon = icons[kind];
        return (
          <button
            key={kind}
            role="menuitem"
            disabled={kind === "terminal" && !connected}
            onClick={() => choose(kind)}
          >
            <Icon size={18} />
            <span>{labels[kind]}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
