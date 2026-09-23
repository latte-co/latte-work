import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, Pencil, X } from "lucide-react";
import { message, revealProject } from "./api";
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
  const [view, setView] = useState<"menu" | "edit" | "remove">("menu");
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState(point);
  const menu = useRef<HTMLDivElement>(null);
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
      if (view === "menu" && !menu.current?.contains(e.target as Node)) close();
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
        <button role="menuitem" onClick={() => setView("remove")}>
          <X size={17} />
          <span>移除项目</span>
        </button>
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
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={view === "edit" ? "编辑项目" : "移除项目"}
      >
        <button
          className="modal-close icon-button"
          aria-label="关闭"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
        <h2>{view === "edit" ? "编辑项目" : "移除项目"}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
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
              {busy ? "正在保存…" : view === "edit" ? "保存" : "移除项目"}
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
