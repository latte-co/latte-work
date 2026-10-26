import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { Workbench } from "./useWorkbench";
import { SkillsSettings } from "./SkillsSettings";

/** Main navigation page. Conversation and workspace remain mounted behind it. */
export function SkillsPage({
  state,
  active,
  busy,
  onBusy,
  onClose,
  onCreate,
  controls,
}: {
  state: Workbench;
  active: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onCreate: (hostId: string) => void;
  controls?: ReactNode;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) back.current?.focus();
  }, [active]);
  return (
    <main
      className="skills-page"
      aria-label="技能管理"
      hidden={!active}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !busy) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="topbar" data-tauri-drag-region="deep">
        <div className="topbar-project">
          {controls}
          <button
            ref={back}
            className="icon-button"
            aria-label="返回对话"
            title="返回对话"
            disabled={busy}
            onClick={onClose}
          >
            <ArrowLeft size={16} />
          </button>
          <span>技能</span>
        </div>
      </header>
      <div className="skills-page-body">
        <SkillsSettings
          state={state}
          active={active}
          onBusy={onBusy}
          onCreate={onCreate}
        />
      </div>
    </main>
  );
}
