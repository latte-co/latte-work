import type { ReactNode } from "react";

/** What an inline code span inside an agent message refers to. */
export type InlineReference =
  | { kind: "url"; url: string }
  | { kind: "projectPath"; path: string }
  | { kind: "externalPath"; path: string }
  | { kind: "text" };

/** Bound noise: longer spans are prose or code, never a usable reference. */
const MAX_REFERENCE_LENGTH = 512;
const URL_PATTERN = /^https?:\/\/[^\s<>"'`]+$/;
// Characters that mark shell/code syntax rather than a literal path.
const PATH_HOSTILE = /[\s{}()[\]$*?|\\;"'`<>,=]/;
const LINE_SUFFIX = /:(\d{1,5}(?:-\d{1,5})?)$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,15}$/;

function pathLike(
  text: string,
): { kind: "projectPath" | "externalPath"; path: string } | null {
  if (PATH_HOSTILE.test(text)) return null;
  // A trailing `file.ts:12` or `file.ts:12-20` line hint is stripped, not
  // treated as part of the path.
  const stripped = text.replace(LINE_SUFFIX, "");
  if (!stripped) return null;
  if (stripped.startsWith("/") || stripped.startsWith("~/"))
    return { kind: "externalPath", path: stripped };
  const directory = stripped.endsWith("/");
  const last = stripped.split("/").at(-1) ?? "";
  if (!directory && (!last || /^\.{1,2}$/.test(last) || /^\.{3,}$/.test(last)))
    return null;
  const namedFile = EXTENSION.test(last) || last.startsWith(".");
  if (!namedFile && !directory) return null;
  return { kind: "projectPath", path: stripped };
}

/** Classify a single inline code span from an agent message. */
export function classifyInlineCode(raw: string): InlineReference {
  const text = raw.trim();
  if (!text || text.length > MAX_REFERENCE_LENGTH || /\s/.test(text))
    return { kind: "text" };
  if (URL_PATTERN.test(text)) return { kind: "url", url: text };
  return pathLike(text) ?? { kind: "text" };
}

/** Flatten rendered code children to the literal text markdown received. */
export function codeText(children: ReactNode): string {
  if (
    children === null ||
    children === undefined ||
    typeof children === "boolean"
  )
    return "";
  if (typeof children === "string" || typeof children === "number")
    return String(children);
  if (Array.isArray(children)) return children.map(codeText).join("");
  if (typeof children === "object" && "props" in children)
    return codeText((children.props as { children?: ReactNode }).children);
  return "";
}
