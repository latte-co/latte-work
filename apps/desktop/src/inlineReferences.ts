import type { ReactNode } from "react";

/** What an inline code span inside an agent message refers to. */
export type InlineReference =
  | { kind: "url"; url: string }
  | { kind: "projectPath"; path: string; line?: string }
  | { kind: "externalPath"; path: string; line?: string }
  | { kind: "text" };

/** Bound noise: longer spans are prose or code, never a usable reference. */
const MAX_REFERENCE_LENGTH = 512;
const URL_PATTERN = /^https?:\/\/[^\s<>"'`]+$/;
// Characters that mark shell/code syntax rather than a literal path.
const PATH_HOSTILE = /[\s{}()[\]$*?|\\;"'`<>,=]/;
const LINE_SUFFIX = /:(\d{1,5}(?:-\d{1,5})?)$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,15}$/;

function pathLike(text: string): {
  kind: "projectPath" | "externalPath";
  path: string;
  line?: string;
} | null {
  if (PATH_HOSTILE.test(text)) return null;
  // A trailing `file.ts:12` or `file.ts:12-20` line hint is stripped, not
  // treated as part of the path; the number rides along for tooltips.
  const line = text.match(LINE_SUFFIX)?.[1];
  const stripped = text.replace(LINE_SUFFIX, "");
  if (!stripped) return null;
  if (stripped.startsWith("/") || stripped.startsWith("~/"))
    return { kind: "externalPath", path: stripped, line };
  const directory = stripped.endsWith("/");
  const segments = stripped.split("/").filter(Boolean);
  // A `..` segment would resolve outside the project once the chip is joined
  // with the project root, so such spans stay plain text.
  if (segments.some((segment) => segment === "..")) return null;
  const last = segments.at(-1) ?? "";
  if (!directory && (!last || /^\.{1,2}$/.test(last) || /^\.{3,}$/.test(last)))
    return null;
  const namedFile = EXTENSION.test(last) || last.startsWith(".");
  if (!namedFile && !directory) return null;
  return { kind: "projectPath", path: stripped, line };
}

/** Classify a single inline code span from an agent message. */
export function classifyInlineCode(raw: string): InlineReference {
  const text = raw.trim();
  if (!text || text.length > MAX_REFERENCE_LENGTH || /\s/.test(text))
    return { kind: "text" };
  if (URL_PATTERN.test(text)) return { kind: "url", url: text };
  return pathLike(text) ?? { kind: "text" };
}

const OTHER_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const FILE_URL = /^file:\/\/(.+)$/;
const FRAGMENT_LINE = /#L(\d{1,5}(?:-\d{1,5})?)$/;

/**
 * Classify a markdown link target. Same path rules as code spans, plus
 * `file:///` unwrapping and `#L12` line fragments; anchors and unknown
 * schemes stay inert instead of guessing at local paths.
 */
export function classifyLinkHref(href: string): InlineReference {
  const text = href.trim();
  if (!text || text.length > MAX_REFERENCE_LENGTH) return { kind: "text" };
  if (URL_PATTERN.test(text)) return { kind: "url", url: text };
  const file = text.match(FILE_URL)?.[1];
  if (file) return pathLike(file) ?? { kind: "text" };
  if (text.startsWith("#") || OTHER_SCHEME.test(text)) return { kind: "text" };
  const fragment = text.match(FRAGMENT_LINE)?.[1];
  const body = fragment
    ? text.slice(0, text.length - fragment.length - 2)
    : text;
  const reference = pathLike(body);
  if (!reference) return { kind: "text" };
  return { ...reference, line: reference.line ?? fragment };
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
