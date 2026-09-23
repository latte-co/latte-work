import { invoke } from "@tauri-apps/api/core";
import type { Request, Response } from "./protocol";
export interface Host {
  id: string;
  name: string;
  ssh: string | null;
  server_path: string | null;
}
export const localHost: Host = {
  id: "local",
  name: "本机",
  ssh: null,
  server_path: null,
};
export const native = "__TAURI_INTERNALS__" in window;
const connections = new Map<string, Promise<Response>>();
export function connect(host: Host): Promise<Response> {
  const pending = connections.get(host.id);
  if (pending) return pending;
  const promise = invoke<Response>("connect_host", { host }).finally(() =>
    connections.delete(host.id),
  );
  connections.set(host.id, promise);
  return promise;
}
export function chooseProjectFolder(): Promise<string | null> {
  return invoke("choose_project_folder");
}
export async function request(
  hostId: string,
  request: Request,
): Promise<Response> {
  const response = await invoke<Response>("host_request", { hostId, request });
  if (response.kind === "error") throw new Error(response.message);
  return response;
}
export async function loadHosts(): Promise<Host[]> {
  return [localHost, ...(await invoke<Host[]>("load_hosts"))];
}
export async function saveHosts(hosts: Host[]): Promise<void> {
  return invoke("save_hosts", { hosts: hosts.filter((h) => h.id !== "local") });
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function revealProject(
  hostId: string,
  projectId: string,
): Promise<void> {
  return invoke("reveal_project", { hostId, projectId });
}
