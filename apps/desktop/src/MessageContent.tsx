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
import { classifyInlineCode, codeText } from "./inlineReferences";
import { InlineRefMenu, type InlineRefMenuItem } from "./InlineRefMenu";
import { InlineRefTooltip } from "./InlineRefTooltip";
import type { SourceData } from "./sourceLoader";

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
function InlineCodeRef({ children }: { children?: ReactNode }) {
  const actions = useContext(MessageActionsContext);
  const raw = codeText(children);
  const reference = classifyInlineCode(raw);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  // Same hover contract as the sidebar hover cards: 350ms delay, dismissed by
  // leaving, scrolling, resizing, Escape, and any menu or click.
  const [hover, setHover] = useState<DOMRect | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();
  function cancelHover() {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  }
  function scheduleHover(target: HTMLButtonElement) {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      if (target.isConnected) setHover(target.getBoundingClientRect());
    }, 350);
  }
  useEffect(() => () => cancelHover(), []);
  useEffect(() => {
    if (point) cancelHover();
  }, [point]);
  // Always-on dismissal: scrolling while the timer is still pending must not
  // pop the tooltip at a stale anchor afterwards. setHover(null) on an
  // already-null state bails out, so a scroll costs no render.
  useEffect(() => {
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
  }, []);
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
  const file = !directory;
  const local = reference.kind === "externalPath";
  const title = local
    ? actions.localHost
      ? "打开文件，右键查看更多操作"
      : "文件操作菜单"
    : "在工作区中打开，右键查看更多操作";
  const open = () => {
    if (reference.kind === "projectPath") {
      actions.openFile?.(reference.path);
      return;
    }
    if (!actions.localHost) return;
    void invoke("open_path", { path: reference.path }).catch((e) =>
      report(message(e)),
    );
  };
  // Codex-style hover: reveal the full path (resolved against the project
  // root when known) plus a muted hint matching the available actions.
  const tipPath =
    reference.kind === "projectPath" && actions.projectRoot
      ? absolutePath(actions.projectRoot, reference.path)
      : reference.path;
  const tipPrimary = reference.line
    ? `${tipPath} (line ${reference.line})`
    : tipPath;
  const tipHint =
    reference.kind === "projectPath"
      ? "左键在工作区打开 · 右键更多操作"
      : actions.localHost
        ? "左键打开 · 右键更多操作"
        : "右键复制路径";
  const items: InlineRefMenuItem[] = [];
  if (reference.kind === "projectPath") {
    items.push({
      key: "open",
      icon: directory ? <FolderOpen size={16} /> : <FileText size={16} />,
      label: "打开文件",
      run: () => actions.openFile?.(reference.path),
    });
  } else if (actions.localHost) {
    items.push({
      key: "open",
      icon: directory ? <FolderOpen size={16} /> : <FileText size={16} />,
      label: "打开文件",
      run: () =>
        void invoke("open_path", { path: reference.path }).catch((e) =>
          report(message(e)),
        ),
    });
  }
  if (actions.localHost) {
    const target =
      reference.kind === "projectPath"
        ? absolutePath(actions.projectRoot, reference.path)
        : reference.path;
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
  if (local && actions.localHost) {
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
export function MessageContent({ text }: { text: string }) {
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ pre: CodeBlock, a: WebLink, code: InlineCodeRef }}
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
