import type { AgentEnvironment } from "./protocol";

export function formatEnvironment(environment: AgentEnvironment): string {
  return Object.entries(environment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

export function parseEnvironment(text: string): AgentEnvironment {
  const environment: AgentEnvironment = Object.create(null);
  let bytes = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const equal = line.indexOf("=");
    const name = line.slice(0, equal);
    if (equal < 1 || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name))
      throw new Error(
        `第 ${index + 1} 行应为 NAME=value，变量名只能包含字母、数字和下划线，且不能以数字开头。`,
      );
    if (Object.hasOwn(environment, name))
      throw new Error(`第 ${index + 1} 行的变量名重复。`);
    if (
      [
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
      ].includes(name) ||
      name.startsWith("LATTE_WORK_")
    )
      throw new Error(
        `第 ${index + 1} 行不能覆盖主机身份、工作目录或 LATTE_WORK_ 变量。`,
      );
    const value = line.slice(equal + 1);
    const length = new TextEncoder().encode(value).length;
    if (value.includes("\0") || length > 8192)
      throw new Error(`第 ${index + 1} 行的值不能包含 NUL，且最多 8 KiB。`);
    bytes += name.length + length + 2;
    environment[name] = value;
  }
  if (Object.keys(environment).length > 64 || bytes > 32 * 1024)
    throw new Error("环境变量最多 64 项，总大小最多 32 KiB。");
  return environment;
}
