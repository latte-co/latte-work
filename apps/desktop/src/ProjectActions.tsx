import { Modal } from "./Modal";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, Pencil, X } from "lucide-react";
import { message, revealProject } from "./api";
import {
  openProjectSessions,
  needsCloseConfirmation,
  closeProjectSessions,
  type CloseProjectResult,
} from "./projectSessions";
import type { Session } from "./protocol";
import type { HostedProject } from "./projectCatalog";
import type { Workbench } from "./useWorkbench";
export function ProjectActions({
  project,
  point,
  close,
  state,
}: {
  project: HostedProject;
  point: { x: number; y: number };
  close: () => void;
  state: Workbench;
}) {
  const [view, setView] = useState<
    "menu" | "edit" | "remove" | "close" | "close-result"
  >("menu");
  const [opened, setOpened] = useState<Session[]>();
  const [closeTargets, setCloseTargets] = useState<Session[]>([]);
  const [closeResult, setCloseResult] = useState<CloseProjectResult>({
    closed: [],
    failed: [],
  });
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState(point);
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (view !== "menu") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const rows = await openProjectSessions(project.hostId, project.id);
        if (!disposed) {
          setOpened(rows);
          setError("");
        }
      } catch (cause) {
        if (!disposed) setError(message(cause));
      }
      if (!disposed) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project.hostId, project.id, view]);
  async function performClose(targets: Session[], confirmed = false) {
    setBusy(true);
    setError("");
    try {
      const result = await closeProjectSessions(
        project.hostId,
        project.id,
        targets,
        (host, id) =>
          state.sessionAction(host, {
            method: "close_agent_session",
            session_id: id,
            only_if_idle: !confirmed,
          }),
      );
      setCloseResult((old) => ({
        closed: [...old.closed, ...result.closed],
        failed: result.failed,
      }));
      if (!result.failed.length) close();
      else setView("close-result");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function retryFailed() {
    setBusy(true);
    setError("");
    try {
      const opened = await openProjectSessions(project.hostId, project.id);
      const targets = closeResult.failed.map(
        (item) => opened.find((s) => s.id === item.session.id) ?? item.session,
      );
      setCloseTargets(targets);
      if (needsCloseConfirmation(targets)) setView("close");
      else await performClose(targets);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function closeAll() {
    setBusy(true);
    setError("");
    try {
      const targets = await openProjectSessions(project.hostId, project.id);
      setOpened(targets);
      setCloseTargets(targets);
      if (!targets.length) return;
      if (needsCloseConfirmation(targets)) setView("close");
      else await performClose(targets);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  useEffect(
    () => () => {
      if (opener.current?.isConnected) opener.current.focus();
    },
    [],
  );
  useLayoutEffect(() => {
    if (menu.current) {
      const rect = menu.current.getBoundingClientRect();
      setPosition({
        x: Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8)),
      });
      menu.current.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [point]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!busy) close();
      }
      if (view !== "menu") return;
      if (e.key === "Tab") {
        close();
        return;
      }
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
    const outside = (e: PointerEvent) => {
      if (view === "menu" && !busy && !menu.current?.contains(e.target as Node))
        close();
    };
    const resize = () => {
      if (view === "menu") close();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resize);
    };
  }, [view, busy, close]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (view === "edit")
        await state.renameProject(project.hostId, project.id, name);
      else await state.removeProject(project.hostId, project.id);
      close();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const finder = () => {
    close();
    void revealProject(project.hostId, project.id).catch((e) =>
      state.setError(message(e)),
    );
  };
  if (view === "menu")
    return createPortal(
      <div
        ref={menu}
        role="menu"
        aria-label={`${project.name} 项目操作`}
        className="project-context-menu"
        style={{ left: position.x, top: position.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button role="menuitem" onClick={() => setView("edit")}>
          <Pencil size={17} />
          <span>编辑</span>
        </button>
        {project.hostId === "local" && (
          <>
            <div role="separator" />
            <button role="menuitem" onClick={finder}>
              <Folder size={17} />
              <span>在 Finder 中显示</span>
            </button>
          </>
        )}
        <div role="separator" />
        <button
          role="menuitem"
          disabled={busy || !opened?.length}
          title={error || "关闭此项目已打开的 Agent 会话，保留聊天记录"}
          onClick={() => void closeAll()}
        >
          <X size={17} />
          <span>
            {opened === undefined
              ? "关闭全部对话"
              : `关闭全部对话（${opened.length}）`}
          </span>
        </button>
        <div role="separator" />
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => setView("remove")}
        >
          <X size={17} />
          <span>移除项目</span>
        </button>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>,
      document.body,
    );
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <Modal
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={
          view === "edit"
            ? "编辑项目"
            : view === "remove"
              ? "移除项目"
              : "关闭全部对话"
        }
      >
        <button
          className="modal-close icon-button"
          aria-label="关闭"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
        <h2>
          {view === "edit"
            ? "编辑项目"
            : view === "remove"
              ? "移除项目"
              : "关闭全部对话"}
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (view === "close") void performClose(closeTargets, true);
            else if (view === "close-result") void retryFailed();
            else void save();
          }}
        >
          {view === "edit" ? (
            <>
              <label>
                项目名称
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </label>
              <p className="form-note project-path-note">{project.path}</p>
            </>
          ) : view === "close" ? (
            <p>
              将关闭「{project.name}」的 {closeTargets.length} 个 Agent
              会话，其中有运行任务、待审批操作、后台任务或待确认状态。关闭会停止这些任务，聊天记录、草稿和置顶状态保留。
            </p>
          ) : view === "close-result" ? (
            <div role="status">
              <p>
                已关闭 {closeResult.closed.length} 个，
                {closeResult.failed.length} 个关闭失败。
              </p>
              {closeResult.failed.map((item) => (
                <p key={item.session.id}>
                  {item.session.title}：{item.error}
                </p>
              ))}
            </div>
          ) : (
            <p>
              将「{project.name}
              」从项目列表移除。文件和聊天记录会保留，重新添加同一目录即可恢复。
            </p>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={close}
            >
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy
                ? view === "close" || view === "close-result"
                  ? "正在关闭…"
                  : "正在保存…"
                : view === "edit"
                  ? "保存"
                  : view === "remove"
                    ? "移除项目"
                    : view === "close"
                      ? "关闭全部"
                      : "重试失败项"}
            </button>
          </div>
        </form>
      </Modal>
    </div>,
    document.body,
  );
}
