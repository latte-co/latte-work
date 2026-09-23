import type { Project } from "./protocol";

export type ProjectCatalog = Record<string, Project[]>;
export type HostedProject = Project & { hostId: string };
const key = "latte-work.projects.v1";

// A display cache keeps offline projects reachable. The server remains authoritative.
export function readCatalog(): ProjectCatalog {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, projects]) =>
          Array.isArray(projects) &&
          projects.every(
            (p) =>
              p &&
              typeof p.id === "string" &&
              typeof p.name === "string" &&
              typeof p.path === "string",
          ),
      ),
    );
  } catch {
    return {};
  }
}
export function writeCatalog(value: ProjectCatalog) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Nonessential cache. */
  }
}
export function hostedProjects(
  catalog: ProjectCatalog,
  hosts: string[],
): HostedProject[] {
  return hosts.flatMap((hostId) =>
    (catalog[hostId] ?? []).map((project) => ({ ...project, hostId })),
  );
}
