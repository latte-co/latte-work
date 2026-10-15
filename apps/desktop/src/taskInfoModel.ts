import type { Event, JsonValue } from "./protocol";
import { referenceMessage } from "./referenceMessage";
import { webLink } from "./browserLinks";

export interface InfoFile {
  path: string;
  name: string;
  directory: boolean;
}
export type InfoResource =
  ({ kind: "file" } & InfoFile) | { kind: "link"; url: string; title: string };
export interface InfoTodo {
  id: string;
  title: string;
  status: string;
}
const record = (
  value: JsonValue | undefined,
): Record<string, JsonValue | undefined> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
const text = (value: JsonValue | undefined) =>
  typeof value === "string" ? value : "";
const statuses = new Set(["pending", "in_progress", "completed"]);

export function artifactPath(value: string): string | null {
  let path = value.replace(/^<|>$/g, "");
  try {
    path = decodeURI(path);
  } catch {
    /* Preserve literal filenames. */
  }
  path = path.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, "");
  if (
    !path ||
    path.length > 4096 ||
    /[\x00-\x1f]/.test(path) ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.startsWith("//") ||
    path.startsWith("#")
  )
    return null;
  return path;
}

/** Presentation from recorded tool calls/results; never execute or infer success. */
export function taskInfo(
  events: Event[],
  sessionId?: string,
  projectPath?: string,
) {
  const links = new Map<string, { url: string; title: string }>();
  const files = new Map<string, InfoFile>();
  const products = new Map<string, InfoResource>();
  const resources = new Map<string, InfoResource>();
  const skills = new Map<string, number>();
  const tools = new Map<string, number>();
  const calls = new Map<string, Extract<Event["event"], { kind: "tool" }>>();
  const results = new Set<string>();
  let todos = new Map<string, InfoTodo>();
  const file = (
    value: string,
    title?: string,
    product = false,
    directory = false,
  ) => {
    let path = artifactPath(value);
    if (
      path &&
      projectPath &&
      path.startsWith(`${projectPath.replace(/\/$/, "")}/`)
    )
      path = path.slice(projectPath.replace(/\/$/, "").length + 1);
    if (!path) return;
    path = path.replace(/^\.\//, "");
    const entry: InfoFile = {
      path,
      name: title || files.get(path)?.name || path.split("/").at(-1) || path,
      directory,
    };
    if (files.size < 129 || files.has(path)) files.set(path, entry);
    const key = `file:${path}`;
    if (product) resources.delete(key);
    const target = product || products.has(key) ? products : resources;
    if (target.size < 129 || target.has(key))
      target.set(key, { kind: "file", ...entry });
  };
  const link = (value: string, title?: string) => {
    const url = webLink(value);
    if (url && (links.size < 129 || links.has(url))) {
      const entry = { url, title: title || links.get(url)?.title || url };
      links.set(url, entry);
      if (resources.size < 129 || resources.has(`link:${url}`))
        resources.set(`link:${url}`, { kind: "link", ...entry });
    }
  };
  const scan = (body: string, user: boolean) => {
    if (user) {
      const parsed = referenceMessage(body);
      for (const entry of parsed.references)
        file(entry.path, entry.name, false, entry.directory);
      body = parsed.text;
    }
    // Ignore fenced examples; inline code can contain actual linked file paths.
    const prose = body.replace(
      /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm,
      "",
    );
    const rest = prose.replace(
      /!?\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
      (_match, title: string, target: string) => {
        const value = target.replace(/^<|>$/g, "");
        if (webLink(value)) link(value, title);
        else file(value, title);
        return "";
      },
    );
    for (const match of rest.matchAll(
      /https?:\/\/[^\s<>`"'\[\]）。，；！？]+/g,
    )) {
      let url = match[0].replace(/[.,;!?]+$/, "");
      while (
        url.endsWith(")") &&
        (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)
      )
        url = url.slice(0, -1);
      link(url);
    }
    for (const match of rest.matchAll(/`((?:\/|\.\/)[^`\n]+)`/g))
      if (/\/[^/]+\.[^/]+$/.test(match[1])) file(match[1]);
  };
  // Streaming fragments are contiguous text events, so assemble before parsing links.
  let body = "",
    bodyKind = "";
  const flush = () => {
    if (body) scan(body, bodyKind === "user");
    body = "";
  };
  for (const { event } of events
    .filter((entry) => entry.session_id === sessionId)
    .sort((a, b) => a.seq - b.seq)) {
    if (event.kind === "text" || event.kind === "user") {
      if (event.kind !== bodyKind || event.kind === "user") flush();
      bodyKind = event.kind;
      body += event.text;
      continue;
    }
    flush();
    if (event.kind === "tool") {
      if (calls.has(event.id)) continue;
      calls.set(event.id, event);
      tools.set(event.name, (tools.get(event.name) ?? 0) + 1);
      if (event.name === "Skill") {
        const name = text(record(event.input).skill);
        if (name) skills.set(name, (skills.get(name) ?? 0) + 1);
      }
    }
    if (event.kind === "tool_result" && !results.has(event.id)) {
      results.add(event.id);
      const call = calls.get(event.id);
      if (!call || event.is_error) continue;
      const input = record(call.input);
      if (call.name === "TodoWrite" && Array.isArray(input.todos)) {
        todos = new Map();
        input.todos.forEach((value, i) => {
          const todo = record(value);
          const title = text(todo.content);
          if (title && statuses.has(text(todo.status)))
            todos.set(`todo:${i}`, {
              id: `todo:${i}`,
              title,
              status: text(todo.status),
            });
        });
      }
      if (call.name === "TaskCreate") {
        const output = record(event.content);
        const content =
          typeof event.content === "string"
            ? event.content
            : Array.isArray(event.content)
              ? event.content.map((part) => text(record(part).text)).join("\n")
              : "";
        const id =
          text(output.taskId) ||
          text(record(output.task ?? null).id) ||
          content.match(/Task #(\d+) created successfully/)?.[1];
        if (id && text(input.subject))
          todos.set(id, { id, title: text(input.subject), status: "pending" });
      }
      if (call.name === "TaskUpdate") {
        const id = text(input.taskId),
          old = todos.get(id);
        if (text(input.status) === "deleted") todos.delete(id);
        else if (old)
          todos.set(id, {
            ...old,
            title: text(input.subject) || old.title,
            status: statuses.has(text(input.status))
              ? text(input.status)
              : old.status,
          });
      }
      if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.name)) {
        const path = text(input.file_path) || text(input.notebook_path);
        if (path) file(path, undefined, true);
      }
      if (call.name === "Read") {
        const path = text(input.file_path);
        if (path) file(path);
      }
    }
    if (event.kind === "turn_changes")
      for (const entry of event.changes.summary.entries)
        if (entry.status !== "D" && entry.status !== "deleted")
          file(entry.path, undefined, true);
  }
  flush();
  const limited = <T>(values: Iterable<T>) => [...values].slice(0, 128);
  return {
    products: limited(products.values()),
    resources: limited(resources.values()),
    todos: limited(todos.values()),
    skills: limited(skills),
    tools: limited(tools),
    links: limited(links.values()),
    files: limited(files.values()),
    truncated: [todos, skills, tools, links, files, products, resources].some(
      (items) => items.size > 128,
    ),
  };
}
