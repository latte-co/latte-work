import { WebLink } from "./LinkHandling";
import { copyText } from "./clipboard";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  Save,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "./api";
import {
  classifyInlineCode,
  classifyLinkHref,
  codeText,
  type InlineReference,
} from "./inlineReferences";
import { InlineRefMenu, type InlineRefMenuItem } from "./InlineRefMenu";
import { InlineRefTooltip } from "./InlineRefTooltip";
import type { SourceData } from "./sourceLoader";
import { webLink } from "./browserLinks";

export function CopyButton({
  text,
  label,
  iconOnly = false,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
}) {
  const [state, setState] = useState("");
  useEffect(() => setState(""), [text]);
  return (
    <span className="copy-action">
      <button
        aria-label={state === "已复制" ? state : label}
        title={state || label}
        onClick={() => {
          void copyText(text).then(
            () => setState("已复制"),
            (e) => setState(`复制失败：${message(e)}`),
          );
        }}
      >
        {state === "已复制" ? <Check size={14} /> : <Copy size={14} />}
        {!iconOnly && (state === "已复制" ? state : label)}
      </button>
      {state.startsWith("复制失败") && <span role="alert">{state}</span>}
    </span>
  );
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement);
  const props = code?.props as
    { className?: string; children?: ReactNode } | undefined;
  const raw = codeText(props?.children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <div className="code-block-heading">
        <span>{props?.className?.replace("language-", "") || "代码"}</span>
        <CopyButton label="复制代码" text={raw} />
      </div>
      <pre>
        <code className={props?.className}>{raw}</code>
      </pre>
    </div>
  );
}
/** Workspace hooks that make inline references in messages actionable. */
export interface MessageActions {
  /** Open a project-relative path in the workspace file browser. */
  openFile?: (path: string) => void;
  /** Absolute paths belong to this host and can leave the app locally. */
  localHost?: boolean;
  /** Absolute project root, used to resolve local editor and file-manager calls. */
  projectRoot?: string;
  /** Bounded project-file read shared by save-as and content copy. */
  readProjectFile?: (path: string) => Promise<SourceData>;
  /** Menu actions report failures to a persistent status surface. */
  reportError?: (text: string) => void;
}
const MessageActionsContext = createContext<MessageActions>({});
const absolutePath = (root: string | undefined, relative: string) => {
  if (!root) return relative;
  return `${root.replace(/\/$/, "")}/${relative.replace(/^\.\//, "").replace(/^\//, "")}`;
};
const baseName = (path: string) =>
  path.split("/").filter(Boolean).at(-1) ?? path.replace(/\/$/, "");
function textual(data: SourceData) {
  const sniff = data.bytes.subarray(0, Math.min(data.bytes.length, 8192));
  if (sniff.includes(0)) throw new Error("二进制文件不支持复制内容");
  return new TextDecoder().decode(data.bytes);
}
async function copyProjectContent(
  actions: MessageActions,
  path: string,
  report: (text: string) => void,
) {
  if (!actions.readProjectFile) {
    report("当前视图不支持读取文件内容");
    return;
  }
  try {
    const data = await actions.readProjectFile(path);
    await copyText(textual(data));
  } catch (e) {
    report(message(e));
  }
}
async function saveAs(
  actions: MessageActions,
  kind: "projectPath" | "externalPath",
  path: string,
  name: string,
  report: (text: string) => void,
) {
  try {
    if (kind === "projectPath") {
      if (!actions.readProjectFile) return;
      const data = await actions.readProjectFile(path);
      await invoke("save_file_as", { name, data: Array.from(data.bytes) });
      return;
    }
    await invoke("save_local_file_as", { path, name });
  } catch (e) {
    report(message(e));
  }
}
type PathReference = Extract<
  InlineReference,
  { kind: "projectPath" | "externalPath" }
>;
/** An absolute path inside the current project, as the file tab's relative form. */
function projectRelative(
  root: string | undefined,
  external: string,
): string | null {
  if (!root) return null;
  const base = root.replace(/\/$/, "");
  return external.startsWith(`${base}/`)
    ? external.slice(base.length + 1)
    : null;
}
function openInlineReference(
  reference: PathReference,
  actions: MessageActions,
  report: (text: string) => void,
) {
  if (reference.kind === "projectPath") {
    actions.openFile?.(reference.path);
    return;
  }
  // Absolute paths inside the current project open in the workspace file tab;
  // only paths outside any project fall back to the guarded system opener.
  const relative = projectRelative(actions.projectRoot, reference.path);
  if (relative && actions.openFile) {
    actions.openFile(relative);
    return;
  }
  if (!actions.localHost) {
    // Remote absolutes are copy-only; left click runs the only available
    // action instead of dead-ending.
    void copyText(reference.path).catch((e) => report(message(e)));
    return;
  }
  void invoke("open_path", { path: reference.path }).catch((e) =>
    report(message(e)),
  );
}
/** Context-menu actions shared by reference chips and markdown file links. */
function inlineRefMenuItems(
  reference: PathReference,
  actions: MessageActions,
  report: (text: string) => void,
): InlineRefMenuItem[] {
  const directory = reference.path.endsWith("/");
  const file = !directory;
  const items: InlineRefMenuItem[] = [];
  // The open action exists only where something can actually open: the file
  // tab for project paths (or absolutes inside the root), or the guarded
  // system opener for other local absolutes. Remote paths stay copy-only.
  const openable =
    reference.kind === "projectPath" ||
    actions.localHost ||
    (actions.openFile !== undefined &&
      projectRelative(actions.projectRoot, reference.path) !== null);
  if (openable)
    items.push({
      key: "open",
      icon: directory ? <FolderOpen size={16} /> : <FileText size={16} />,
      label: "打开文件",
      run: () => openInlineReference(reference, actions, report),
    });
  if (actions.localHost) {
    // Without a project root the resolved editor target would be the bare
    // relative path and always fail, so hide the item instead.
    const resolvable =
      reference.kind === "externalPath" || actions.projectRoot !== undefined;
    const target =
      reference.kind === "projectPath"
        ? absolutePath(actions.projectRoot, reference.path)
        : reference.path;
    if (resolvable)
      items.push({
        key: "vscode",
        icon: <Code2 size={16} />,
        label: "在 VS Code 中打开",
        run: () =>
          void invoke("open_in_vscode", { path: target }).catch((e) =>
            report(message(e)),
          ),
      });
  }
  const canSaveAs =
    file &&
    (reference.kind === "projectPath"
      ? actions.readProjectFile !== undefined
      : actions.localHost);
  if (canSaveAs) {
    items.push(
      { key: "sep-1", separator: true },
      {
        key: "save-as",
        icon: <Save size={16} />,
        label: "另存为...",
        run: () =>
          void saveAs(
            actions,
            reference.kind,
            reference.path,
            baseName(reference.path),
            report,
          ),
      },
    );
  }
  items.push({
    key: "copy-path",
    icon: <Copy size={16} />,
    label: "复制路径",
    run: () => void copyText(reference.path).catch((e) => report(message(e))),
  });
  if (
    file &&
    (reference.kind === "projectPath"
      ? actions.readProjectFile !== undefined
      : actions.localHost)
  ) {
    items.push({
      key: "copy-content",
      icon: <FileText size={16} />,
      label: "复制文件内容",
      run: () => {
        if (reference.kind === "projectPath") {
          void copyProjectContent(actions, reference.path, report);
          return;
        }
        void invoke<string>("read_local_text", { path: reference.path })
          .then((text) => copyText(text))
          .catch((e) => report(message(e)));
      },
    });
  }
  if (reference.kind === "externalPath" && actions.localHost) {
    items.push(
      { key: "sep-2", separator: true },
      {
        key: "reveal",
        icon: <Eye size={16} />,
        label: "在访达中显示",
        run: () =>
          void invoke("reveal_path", { path: reference.path }).catch((e) =>
            report(message(e)),
          ),
      },
    );
  }
  return items;
}
function InlineCodeRef({ children }: { children?: ReactNode }) {
  const actions = useContext(MessageActionsContext);
  const raw = codeText(children);
  const reference = classifyInlineCode(raw);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  // Same hover contract as the sidebar hover cards: 350ms delay, dismissed by
  // leaving, scrolling, resizing, Escape, and any menu or click. `pending`
  // gates the dismissal listeners so idle chips carry none of them.
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [pending, setPending] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();
  function cancelHover() {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setPending(false);
    setHover(null);
  }
  function scheduleHover(target: HTMLButtonElement) {
    if (point) return;
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setPending(false);
      if (target.isConnected) setHover(target.getBoundingClientRect());
    }, 350);
    setPending(true);
  }
  useEffect(() => () => cancelHover(), []);
  useEffect(() => {
    if (point) cancelHover();
  }, [point]);
  // Scrolling while the timer is still pending must not pop the tooltip at a
  // stale anchor afterwards, so dismissal listeners stay mounted through the
  // pending phase, not only while the tooltip is visible.
  useEffect(() => {
    if (!hover && !pending) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelHover();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("resize", cancelHover);
    window.addEventListener("scroll", cancelHover, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", cancelHover);
      window.removeEventListener("scroll", cancelHover, true);
    };
  }, [hover, pending]);
  if (reference.kind === "text") return <code>{children}</code>;
  if (reference.kind === "url")
    return (
      <code className="inline-code-ref">
        <WebLink href={reference.url} className="inline-ref-link">
          <ExternalLink size={12} />
          {raw}
        </WebLink>
      </code>
    );
  // Outside the conversation (markdown previews, settings) the chips degrade
  // back to plain code instead of dead ends.
  const provided =
    actions.openFile !== undefined || actions.localHost !== undefined;
  if (reference.kind === "projectPath" && !actions.openFile)
    return <code>{children}</code>;
  if (reference.kind === "externalPath" && !provided)
    return <code>{children}</code>;
  const report = actions.reportError ?? (() => undefined);
  const directory = reference.path.endsWith("/");
  const local = reference.kind === "externalPath";
  const title = local
    ? actions.localHost
      ? "打开文件，右键查看更多操作"
      : "点击复制路径，右键查看更多操作"
    : "在工作区中打开，右键查看更多操作";
  const open = () => openInlineReference(reference, actions, report);
  // Codex-style hover: reveal the full path (resolved against the project
  // root when known) plus a muted hint matching the available actions.
  const tipPath =
    reference.kind === "projectPath" && actions.projectRoot
      ? absolutePath(actions.projectRoot, reference.path)
      : reference.path;
  const tipPrimary = reference.line
    ? `${tipPath} (${reference.line.includes("-") ? "lines" : "line"} ${reference.line})`
    : tipPath;
  const tipHint =
    reference.kind === "projectPath"
      ? "左键在工作区打开 · 右键更多操作"
      : actions.localHost
        ? "左键打开 · 右键更多操作"
        : "点击复制路径 · 右键更多操作";
  const items = inlineRefMenuItems(reference, actions, report);
  return (
    <code className="inline-code-ref">
      <button
        className="inline-ref-button"
        aria-label={title}
        aria-describedby={hover && !point ? tipId : undefined}
        onClick={() => {
          cancelHover();
          open();
        }}
        onMouseEnter={(event) => scheduleHover(event.currentTarget)}
        onMouseLeave={cancelHover}
        onFocus={(event) => scheduleHover(event.currentTarget)}
        onBlur={cancelHover}
        onContextMenu={(event) => {
          event.preventDefault();
          cancelHover();
          setPoint({ x: event.clientX, y: event.clientY });
        }}
      >
        {directory ? <FolderOpen size={12} /> : <FileText size={12} />}
        {raw}
      </button>
      {point && (
        <InlineRefMenu
          point={point}
          label={`文件操作：${baseName(reference.path)}`}
          items={items}
          close={() => setPoint(null)}
        />
      )}
      {hover && !point && (
        <InlineRefTooltip
          anchor={hover}
          id={tipId}
          primary={tipPrimary}
          secondary={tipHint}
        />
      )}
    </code>
  );
}
/**
 * Markdown link targets: http(s) keep browser semantics; local path targets
 * open in the workspace file tab and carry the same context menu as reference
 * chips. Anything else renders as plain text instead of a dead blue link.
 */
function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const actions = useContext(MessageActionsContext);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  if (href && webLink(href)) return <WebLink href={href}>{children}</WebLink>;
  const reference = href ? classifyLinkHref(href) : ({ kind: "text" } as const);
  const provided =
    actions.openFile !== undefined || actions.localHost !== undefined;
  const inert = <span className="markdown-link-inert">{children}</span>;
  if (reference.kind !== "projectPath" && reference.kind !== "externalPath")
    return inert;
  if (reference.kind === "projectPath" && !actions.openFile) return inert;
  if (reference.kind === "externalPath" && !provided) return inert;
  const report = actions.reportError ?? (() => undefined);
  return (
    <>
      <button
        type="button"
        className="markdown-file-link"
        title={reference.path}
        onClick={() => openInlineReference(reference, actions, report)}
        onContextMenu={(event) => {
          event.preventDefault();
          setPoint({ x: event.clientX, y: event.clientY });
        }}
      >
        {children}
      </button>
      {point && (
        <InlineRefMenu
          point={point}
          label={`文件操作：${baseName(reference.path)}`}
          items={inlineRefMenuItems(reference, actions, report)}
          close={() => setPoint(null)}
        />
      )}
    </>
  );
}
export function MessageContent({ text }: { text: string }) {
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ pre: CodeBlock, a: MarkdownLink, code: InlineCodeRef }}
      >
        {text}
      </ReactMarkdown>
    </>
  );
}
export function MessageActionsProvider({
  value,
  children,
}: {
  value: MessageActions;
  children: ReactNode;
}) {
  return (
    <MessageActionsContext.Provider value={value}>
      {children}
    </MessageActionsContext.Provider>
  );
}
