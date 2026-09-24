import { ProjectDialog } from "./ProjectDialog";
import type { Workbench } from "./useWorkbench";

export function HostDialogs({ state }: { state: Workbench }) {
  return state.modal === "project" ? <ProjectDialog state={state} /> : null;
}
