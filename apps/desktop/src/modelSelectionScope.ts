import type { Effort } from "./protocol";
export const modelSelectionScope = (
  host: string,
  project: string | undefined,
  agent: string,
  model: string | null,
  effort: Effort | null,
) => JSON.stringify([host, project, agent, model, effort]);
