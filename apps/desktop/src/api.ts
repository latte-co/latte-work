import { invoke } from "@tauri-apps/api/core";
import type { Request, Response } from "./protocol";
export interface Host {
  id: string;
  name: string;
  ssh: string | null;
  server_path: string | null;
  auth?: "none" | "identity_file" | "password";
  identity_file?: string | null;
  port?: number | null;
}
export const localHost: Host = {
  id: "local",
  name: "本机",
  ssh: null,
  server_path: null,
};
export const native = "__TAURI_INTERNALS__" in window;
const connections = new Map<
  string,
  { signature: string; promise: Promise<Response> }
>();
export function connect(host: Host, password?: string): Promise<Response> {
  const signature = JSON.stringify(host);
  const pending = connections.get(host.id);
  if (pending?.signature === signature && password === undefined)
    return pending.promise;
  const invokeConnection = () =>
    invoke<Response>("connect_host", { host, password });
  const promise = (
    pending
      ? pending.promise.catch(() => undefined).then(invokeConnection)
      : invokeConnection()
  ).finally(() => {
    if (connections.get(host.id)?.promise === promise)
      connections.delete(host.id);
  });
  connections.set(host.id, { signature, promise });
  return promise;
}
export function disconnect(hostId: string): Promise<void> {
  return invoke("disconnect_host", { hostId });
}
export function chooseProjectFolder(): Promise<string | null> {
  return invoke("choose_project_folder");
}
export function chooseIdentityFile(): Promise<string | null> {
  return invoke("choose_identity_file");
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
  const value = error instanceof Error ? error.message : String(error);
  return value === "SSH_PASSWORD_REQUIRED" ? "请输入 SSH 密码后连接" : value;
}

export function revealProject(
  hostId: string,
  projectId: string,
): Promise<void> {
  return invoke("reveal_project", { hostId, projectId });
}

export async function bindAgentProvider(
  hostId: string,
  agent: string,
  providerId: string | null,
): Promise<Response> {
  const response = await invoke<Response>("bind_agent_provider", {
    hostId,
    agent,
    providerId,
  });
  if (response.kind === "error") throw new Error(response.message);
  return response;
}

export async function agentProviders(hostId: string): Promise<Response> {
  const response = await invoke<Response>("agent_providers", { hostId });
  if (response.kind === "error") throw new Error(response.message);
  return response;
}
