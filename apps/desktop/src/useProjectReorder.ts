import type { HostedProject } from "./projectCatalog";
import { useListReorder } from "./useListReorder";
export function useProjectReorder(options: {
  projects: HostedProject[];
  enabled: boolean;
  onMove: (source: string, target: string, after: boolean) => void;
}) {
  const reorder = useListReorder({
    ...options,
    items: options.projects,
    rowSelector: ".project-group[data-project-key]",
    rowKey: "projectKey",
    label: (project) => project.name,
  });
  return {
    ...reorder,
    drag: reorder.drag ? { ...reorder.drag, project: reorder.drag.item } : null,
  };
}
