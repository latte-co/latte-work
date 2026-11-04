import { WebLink } from "./LinkHandling";
import { copyText } from "./clipboard";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, ExternalLink, FileText, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "./api";
import { classifyInlineCode, codeText } from "./inlineReferences";

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
  /** Absolute paths belong to this host and may be revealed in the file manager. */
  localHost?: boolean;
}
const MessageActionsContext = createContext<MessageActions>({});

function InlineCodeRef({ children }: { children?: ReactNode }) {
  const actions = useContext(MessageActionsContext);
  const raw = codeText(children);
  const reference = classifyInlineCode(raw);
  const [error, setError] = useState("");
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
  const title =
    reference.kind === "projectPath"
      ? `在工作区中打开 ${reference.path}`
      : actions.localHost
        ? `在访达中显示 ${reference.path}`
        : "仅本机路径可在访达中显示";
  const open = () => {
    if (reference.kind === "projectPath") {
      setError("");
      actions.openFile?.(reference.path);
      return;
    }
    if (!actions.localHost) {
      setError("仅本机路径可在访达中显示");
      return;
    }
    void invoke("reveal_path", { path: reference.path }).then(
      () => setError(""),
      (e) => setError(message(e)),
    );
  };
  const directory = reference.path.endsWith("/");
  return (
    <code className="inline-code-ref">
      <button
        className="inline-ref-button"
        title={title}
        aria-label={title}
        onClick={open}
      >
        {directory ? <FolderOpen size={12} /> : <FileText size={12} />}
        {raw}
      </button>
      {error && <span role="alert">{error}</span>}
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
