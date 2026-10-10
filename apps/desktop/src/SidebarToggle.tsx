import { PanelLeft } from "lucide-react";
import type { SidebarPreview } from "./useSidebarPreview";

/** The collapsed trigger is shared by conversation and merged workspace headers. */
export function SidebarToggle({
  toggle,
  preview,
}: {
  toggle: () => void;
  preview?: SidebarPreview;
}) {
  const label = preview?.visible ? "固定侧栏" : "展开侧栏";
  return (
    <button
      className="panel-toggle icon-button"
      data-sidebar-trigger
      title={label}
      aria-label={label}
      aria-expanded={preview?.visible ?? false}
      aria-controls="project-sidebar"
      onClick={toggle}
      {...preview?.triggerProps}
    >
      <PanelLeft size={16} />
    </button>
  );
}
