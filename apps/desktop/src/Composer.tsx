import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  FileVideo,
  Folder,
  Plus,
  Search,
  X,
} from "lucide-react";
import { chooseReferencePath, message, request } from "./api";
import type { AgentSlashCommand, FileEntry } from "./protocol";
import {
  commandTitle,
  composerTrigger,
  appCommandAction,
  type AppCommandAction,
  hasCommandArguments,
  isNativeSubagentCommand,
  subagentPanelAliases,
  subagentPanelArgumentNotice,
  unifiedComposerCommands,
  referencePrompt,
  type ComposerTrigger,
} from "./composerActions";

import {
  MAX_PASTE_FILE,
  clipboardFilePaths,
  importClipboardFile,
  isLongPaste,
  storePastedFile,
  type ComposerReference,
} from "./pasteAttachments";
import { AttachmentImage } from "./AttachmentImage";
import { referenceKind } from "./referenceMessage";

interface Props {
  focusRequest?: number;
  referenceState?: { scope: string; entries: ComposerReference[] };
  onReferencesChange?: (value: {
    scope: string;
    entries: ComposerReference[];
  }) => void;
  agent: string;
  hostId: string;
  projectId?: string;
  sessionId?: string;
  connected: boolean;
  disabled: boolean;
  sending: boolean;
  hidden: boolean;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  onSubmit: (prompt: string, uiAction?: "subagents") => Promise<boolean>;
  onOpenSubagents?: () => void;
  onOpenModelSettings?: (target: "model" | "effort") => string | null;
  toolbar: (
    submit: () => void,
    hasContent: boolean,
    localNavigation: AppCommandAction | null,
  ) => ReactNode;
}
type Option = {
  id: string;
  label: string;
  detail: string;
  icon: "file" | "folder" | "back" | "command";
  choose: () => void;
};
export function Composer(props: Props) {
  const {
    agent,
    hostId,
    projectId,
    sessionId,
    connected,
    disabled,
    sending,
    hidden,
    value,
    onChange,
    onSubmit,
    placeholder,
    toolbar,
  } = props;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickerContext = useRef<string | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  useEffect(() => {
    if (props.focusRequest && !props.hidden) input.current?.focus();
  }, [props.focusRequest, props.hidden]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || hidden) return;
    function fit() {
      if (!element) return;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
    }
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, hidden]);
  const composing = useRef(false);
  const submitting = useRef(false);
  const scope = `${hostId}:${projectId}:${agent}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [localReferences, setLocalReferences] = useState<{
    scope: string;
    entries: ComposerReference[];
  }>({ scope, entries: [] });
  const references = props.referenceState ?? localReferences;
  const setReferences = props.onReferencesChange ?? setLocalReferences;
  const attached = references.scope === scope ? references.entries : [];
  const [pasting, setPasting] = useState(false);
  const [pasteProgress, setPasteProgress] = useState("");
  const pasteOperation = useRef(0);
  const pasteBusy = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  useEffect(() => {
    pasteOperation.current++;
    pasteBusy.current = false;
    setPasting(false);
    setPasteProgress("");
    setRetryFiles([]);
    pickerContext.current = null;
    setDragging(false);
    dragDepth.current = 0;
    return () => {
      pasteOperation.current++;
    };
  }, [scope, sessionId, hidden, disabled, sending, connected]);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [browse, setBrowse] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(0);
  const [commands, setCommands] = useState<AgentSlashCommand[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [external, setExternal] = useState(false);
  const [externalPath, setExternalPath] = useState("");
  const [externalError, setExternalError] = useState("");
  const [externalBusy, setExternalBusy] = useState(false);
  const referenceOperation = useRef(0);
  const currentContext = useRef("");
  currentContext.current = `${scope}:${sessionId}:${disabled}:${sending}:${hidden}:${connected}`;
  useEffect(
    () => () => {
      referenceOperation.current++;
    },
    [],
  );
  const [revision, retry] = useState(0);
  const listId = useId();
  const menu =
    !disabled &&
    !sending &&
    !hidden &&
    (addMenu || browse !== null || trigger !== null);
  const mode = addMenu ? "add" : browse !== null ? "files" : trigger?.kind;
  const query = browse !== null ? search : (trigger?.query ?? "");
  const slash = query.lastIndexOf("/");
  const path =
    mode === "files"
      ? (browse ?? (slash < 0 ? "" : query.slice(0, slash)))
      : "";
  const filter = (
    browse !== null ? search : slash < 0 ? query : query.slice(slash + 1)
  ).toLowerCase();
  function close() {
    setAddMenu(false);
    referenceOperation.current++;
    setExternal(false);
    setExternalPath("");
    setExternalError("");
    setExternalBusy(false);
    setTrigger(null);
    setBrowse(null);
    setSearch("");
  }
  useEffect(() => {
    close();
    setCommands([]);
    setNotice("");
    // A different project never inherits references. Existing-session drafts survive remounts.
    if (references.scope !== scope) setReferences({ scope, entries: [] });
  }, [scope]);
  useEffect(() => {
    if (!sending && !props.referenceState) {
      setReferences({ scope, entries: [] });
      close();
    }
  }, [sessionId]);
  useEffect(() => {
    if (hidden || disabled || sending) close();
  }, [hidden, disabled, sending]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  useEffect(() => {
    if (!menu || mode === "add") return;
    let disposed = false;
    setEntries([]);
    setCommands([]);
    setError("");
    setLoading(true);
    if (!connected || !projectId) {
      setError("请先连接项目所在主机");
      setLoading(false);
      return;
    }
    // Debounce typed paths; the server enforces canonical project containment.
    const timer = window.setTimeout(() => {
      void request(
        hostId,
        mode === "commands"
          ? { method: "agent_commands", project_id: projectId, agent }
          : { method: "files", project_id: projectId, path },
      )
        .then((response) => {
          if (disposed) return;
          if (mode === "commands" && response.kind === "agent_commands")
            setCommands(response.commands);
          else if (mode === "files" && response.kind === "files")
            setEntries(response.entries);
          else throw new Error("响应格式不匹配，请更新项目所在主机的 Server");
        })
        .catch((cause) => {
          if (!disposed) setError(message(cause));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }, 120);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [menu, mode, hostId, projectId, agent, connected, path, revision]);
  useEffect(() => {
    setSelected(0);
  }, [query, path, mode, entries, commands]);
  useEffect(() => {
    root.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  function replaceTrigger(replacement: string) {
    const start =
      trigger?.start ?? input.current?.selectionStart ?? value.length;
    const end = trigger?.end ?? start;
    const next = value.slice(0, start) + replacement + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(
        start + replacement.length,
        start + replacement.length,
      );
    });
  }
  function attach(entry: FileEntry) {
    if (attached.length >= 20) {
      setNotice("最多添加 20 个文件或目录引用");
      return;
    }
    if (!attached.some((item) => item.path === entry.path))
      setReferences({ scope, entries: [...attached, entry] });
    if (trigger) replaceTrigger("");
    else input.current?.focus();
    close();
    setNotice("");
  }
  async function addExternal(directory?: boolean) {
    if (externalBusy || !connected || !projectId) return;
    const context = currentContext.current;
    const operation = ++referenceOperation.current;
    const valid = () =>
      context === currentContext.current &&
      operation === referenceOperation.current;
    setExternalBusy(true);
    setExternalError("");
    try {
      const chosen =
        directory === undefined
          ? externalPath.trim()
          : await chooseReferencePath(directory);
      if (!valid() || !chosen) return;
      if (!chosen.startsWith("/"))
        throw new Error("请输入文件或目录的绝对路径，例如 /home/user/docs");
      const response = await request(hostId, {
        method: "resolve_reference",
        project_id: projectId,
        path: chosen,
      });
      if (!valid()) return;
      if (response.kind !== "file_reference")
        throw new Error("无法解析引用，请更新项目所在主机的 Server");
      attach(response.entry);
    } catch (cause) {
      if (valid()) setExternalError(message(cause));
    } finally {
      if (valid()) setExternalBusy(false);
    }
  }
  function navigate(next: string) {
    setBrowse(next);
    setSearch("");
  }
  function command(name: string) {
    replaceTrigger(`/${name} `);
    close();
  }
  const panelAliases = [
    ...subagentPanelAliases,
    ...commands.filter(isNativeSubagentCommand).map((command) => command.name),
  ];
  const localNavigation = appCommandAction(value, commands);
  const options: Option[] =
    mode === "commands"
      ? unifiedComposerCommands(commands)
          .filter((item) =>
            `${item.name} ${commandTitle(item, agent)} ${item.description} ${item.ui_action === "subagents" ? panelAliases.join(" ") : ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .sort(
            (a, b) =>
              Number(b.name.toLowerCase() === query.toLowerCase()) -
                Number(a.name.toLowerCase() === query.toLowerCase()) ||
              Number(!!b.ui_action) - Number(!!a.ui_action),
          )
          .map((item) => ({
            id: item.name,
            label: commandTitle(item, agent),
            detail: `${item.argument_hint} ${item.description}`.trim(),
            icon: "command",
            choose: () => command(item.name),
          }))
      : [
          ...(path
            ? [
                {
                  id: "parent",
                  label: "上一级",
                  detail: path,
                  icon: "back" as const,
                  choose: () =>
                    navigate(path.split("/").slice(0, -1).join("/")),
                },
              ]
            : []),
          ...(!loading && !error && path
            ? [
                {
                  id: "attach-folder",
                  label: "引用此文件夹",
                  detail: path,
                  icon: "folder" as const,
                  choose: () =>
                    attach({
                      name: path.split("/").at(-1)!,
                      path,
                      directory: true,
                    }),
                },
              ]
            : []),
          ...(!loading && !error
            ? entries
                .filter((item) => item.name.toLowerCase().includes(filter))
                .map((item) => ({
                  id: `entry:${item.path}`,
                  label: item.name,
                  detail: item.directory
                    ? "Tab 引用"
                    : item.path === item.name
                      ? ""
                      : item.path,
                  icon: item.directory
                    ? ("folder" as const)
                    : ("file" as const),
                  choose: () =>
                    item.directory ? navigate(item.path) : attach(item),
                }))
            : []),
        ];
  const index = Math.min(selected, Math.max(0, options.length - 1));
  useEffect(() => {
    if (addMenu)
      root.current
        ?.querySelector<HTMLButtonElement>(".composer-add-menu button")
        ?.focus();
  }, [addMenu]);
  async function storeAttachments(
    files: File[],
    paths: string[],
    valid: () => boolean,
    longText = false,
  ) {
    if (!connected || !projectId)
      throw new Error("请先连接项目所在主机，再添加附件");
    const count = paths.length || files.length;
    if (attached.length + count > 20)
      throw new Error("最多添加 20 个附件或引用");
    if (files.some((file) => file.size > MAX_PASTE_FILE))
      throw new Error("单个附件不能超过 64 MiB");
    const added: ComposerReference[] = [];
    for (let i = 0; i < count; i++) {
      if (!valid()) return;
      const label = `正在保存附件 ${i + 1}/${count}`;
      setPasteProgress(`${label}…`);
      const entry = paths.length
        ? await importClipboardFile(hostId, projectId, paths[i])
        : await storePastedFile(
            files[i],
            hostId,
            valid,
            (percent) => {
              if (valid())
                setPasteProgress(
                  percent === 100 && hostId !== "local"
                    ? `正在上传到远程主机 ${i + 1}/${count}…`
                    : `${label} · ${percent}%`,
                );
            },
            longText ? "text" : undefined,
          );
      if (!valid()) return;
      added.push(entry);
    }
    setReferences({
      scope,
      entries: [
        ...attached,
        ...added.filter(
          (entry) => !attached.some((old) => old.path === entry.path),
        ),
      ],
    });
    input.current?.focus();
  }
  async function addFiles(files: File[], retrying = false) {
    if (
      !files.length ||
      disabled ||
      sending ||
      hidden ||
      pasteBusy.current ||
      externalBusy
    )
      return;
    if (retryFiles.length && !retrying) {
      setNotice("请先重试或移除未添加附件");
      return;
    }
    const context = currentContext.current;
    const operation = ++pasteOperation.current;
    const valid = () =>
      context === currentContext.current &&
      operation === pasteOperation.current;
    pasteBusy.current = true;
    setPasting(true);
    setNotice("");
    setRetryFiles([]);
    close();
    try {
      await storeAttachments(files, [], valid);
    } catch (cause) {
      if (valid()) {
        setNotice(`${message(cause)}（未添加本次附件，草稿已保留）`);
        setRetryFiles(files);
      }
    } finally {
      if (valid()) {
        pasteBusy.current = false;
        setPasting(false);
        setPasteProgress("");
        input.current?.focus();
      }
    }
  }
  function dropFiles(event: React.DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled || sending || hidden || pasteBusy.current || externalBusy)
      return;
    const directories = Array.from(event.dataTransfer.items ?? []).some(
      (item) => item.webkitGetAsEntry?.()?.isDirectory,
    );
    if (directories) {
      setNotice(
        "暂不支持上传文件夹，请选择其中的文件；工作区目录可通过引用添加",
      );
      return;
    }
    void addFiles(Array.from(event.dataTransfer.files));
  }
  async function paste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    if (disabled || sending || pasteBusy.current || externalBusy) return;
    const files = Array.from(event.clipboardData.files);
    const text = event.clipboardData.getData("text/plain");
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    const context = currentContext.current;
    const operation = ++pasteOperation.current;
    const valid = () =>
      context === currentContext.current &&
      operation === pasteOperation.current;
    pasteBusy.current = true;
    setPasting(true);
    setNotice("");
    setPasteProgress("正在读取剪贴板…");
    close();
    try {
      const nativePaths = await clipboardFilePaths();
      // A clipboard manager may replace the pasteboard after the paste event.
      // Keep the event's text snapshot authoritative unless it describes files.
      const textLines = text.trim().split(/\r?\n/);
      const paths =
        !text.trim() ||
        (textLines.length === nativePaths.length &&
          nativePaths.every((path, index) => {
            const line = textLines[index];
            return (
              line === path ||
              line === path.split("/").at(-1) ||
              line === `file://${path}` ||
              line === `file://${encodeURI(path)}`
            );
          }))
          ? nativePaths
          : [];
      if (!valid()) return;
      const longText = !paths.length && !files.length && isLongPaste(text);
      if (!paths.length && !files.length && !longText) {
        if (!text) throw new Error("剪贴板中没有可粘贴的文本或文件");
        if (latestValue.current !== value)
          throw new Error("输入内容已变化，请重新粘贴");
        onChange(value.slice(0, start) + text + value.slice(end));
        requestAnimationFrame(() => {
          input.current?.focus();
          input.current?.setSelectionRange(
            start + text.length,
            start + text.length,
          );
        });
        return;
      }
      const items = longText
        ? [
            new File([text], `粘贴文本-${Date.now()}.txt`, {
              type: "text/plain",
            }),
          ]
        : files;
      await storeAttachments(items, paths, valid, longText);
    } catch (cause) {
      if (valid())
        setNotice(`${message(cause)}（未添加本次附件，剪贴板内容未改变）`);
    } finally {
      if (valid()) {
        pasteBusy.current = false;
        setPasting(false);
        setPasteProgress("");
        requestAnimationFrame(() => {
          if (valid()) input.current?.focus();
        });
      }
    }
  }
  async function submit() {
    if (
      disabled ||
      sending ||
      submitting.current ||
      pasteBusy.current ||
      retryFiles.length
    )
      return;
    if (localNavigation) {
      openAppCommand(localNavigation);
      return;
    }
    if (value.trimStart().startsWith("/") && attached.length) {
      setNotice("Agent 命令使用原生参数，请先移除项目引用，避免改变命令含义。");
      return;
    }
    if (!value.trim() && !attached.length) return;
    const owner = scope;
    const commandContext = currentContext.current;
    submitting.current = true;
    close();
    const nativeCommand = value.trim().match(/^\/([^\s]+)(?:\s|$)/)?.[1];
    try {
      let catalog = commands;
      if (
        nativeCommand &&
        !catalog.some((command) => command.name === nativeCommand)
      ) {
        const response = await request(hostId, {
          method: "agent_commands",
          agent,
          project_id: projectId!,
        });
        if (response.kind !== "agent_commands")
          throw new Error("无法读取原生命令列表");
        catalog = response.commands;
        if (
          currentScope.current !== owner ||
          currentContext.current !== commandContext
        )
          return;
      }
      const uiAction = appCommandAction(value, catalog);
      if (uiAction) {
        openAppCommand(uiAction);
        return;
      }
      const prompt = referencePrompt(value, attached);
      if (await onSubmit(prompt)) {
        if (!props.referenceState && currentScope.current === owner)
          setReferences({ scope: owner, entries: [] });
        setNotice("");
      }
    } catch (cause) {
      if (currentScope.current === owner) setNotice(message(cause));
    } finally {
      submitting.current = false;
    }
  }
  function openAppCommand(action: AppCommandAction) {
    close();
    if (action === "subagents") {
      if (!props.onOpenSubagents) {
        setNotice("无法打开子智能体面板");
        return;
      }
      props.onOpenSubagents();
    } else {
      const error =
        props.onOpenModelSettings?.(action) ??
        (props.onOpenModelSettings ? null : "无法打开模型设置");
      if (error) {
        setNotice(error);
        return;
      }
    }
    if (hasCommandArguments(value))
      setNotice(
        action === "subagents"
          ? subagentPanelArgumentNotice
          : `已打开${action === "model" ? "模型" : "思考强度"}菜单；请在菜单中选择，输入内容已保留。`,
      );
    else {
      onChange("");
      setNotice("");
    }
  }
  function keys(event: React.KeyboardEvent) {
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229
    )
      return;
    if (menu) {
      if (addMenu && event.key !== "Escape") return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        input.current?.focus();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(
          (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            Math.max(1, options.length),
        );
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const option = options[index];
        const entry = entries.find(
          (item) => `entry:${item.path}` === option?.id,
        );
        if (event.key === "Tab" && entry?.directory) attach(entry);
        else option?.choose();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }
  return (
    <div
      className={`composer ${!connected ? "disabled" : ""}${dragging ? " composer-dragging" : ""}`}
      ref={root}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        if (
          !disabled &&
          !sending &&
          !hidden &&
          !pasteBusy.current &&
          !externalBusy
        ) {
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          disabled || sending || hidden || pasting || externalBusy
            ? "none"
            : "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={dropFiles}
    >
      <input
        type="file"
        multiple
        hidden
        ref={fileInput}
        aria-label="选择本机附件"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (pickerContext.current === currentContext.current)
            void addFiles(files);
          pickerContext.current = null;
        }}
      />
      {dragging && (
        <div className="composer-drop-hint" role="status">
          松开以添加附件
        </div>
      )}
      {menu && addMenu && (
        <div
          className="composer-menu composer-add-menu"
          role="menu"
          aria-label="添加文件"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              keys(event);
              return;
            }
            if (event.key === "Tab") {
              close();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              buttons[
                (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                  buttons.length
              ]?.focus();
            }
          }}
        >
          <button
            role="menuitem"
            disabled={
              !connected || !projectId || pasting || !!retryFiles.length
            }
            onClick={() => {
              pickerContext.current = currentContext.current;
              close();
              fileInput.current?.click();
            }}
          >
            <FileText size={16} />
            <span>
              添加本机文件…<small>从这台电脑选择文件，可多选</small>
            </span>
          </button>
          <button
            role="menuitem"
            disabled={!connected || !projectId || pasting}
            onClick={() => {
              close();
              setBrowse("");
              input.current?.focus();
            }}
          >
            <Folder size={16} />
            <span>
              引用工作区文件…
              <small>
                {hostId === "local"
                  ? "浏览本机工作区，仅引用路径"
                  : "浏览远程工作区，仅引用路径"}
              </small>
            </span>
          </button>
        </div>
      )}
      {menu && !addMenu && (
        <div
          className={`composer-menu${mode === "commands" ? " composer-command-menu" : ""}`}
          onKeyDown={keys}
        >
          <div className="composer-menu-heading">
            <span>{mode === "commands" ? "命令" : "引用工作区文件"}</span>
            <span>
              {mode === "commands"
                ? agent === "claude"
                  ? "Claude Code"
                  : agent
                : "↑↓ 选择 · Enter 确认 · Esc 关闭"}
            </span>
          </div>
          {external && mode === "files" ? (
            <div
              className="composer-external-path"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  close();
                  input.current?.focus();
                }
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void addExternal();
                }
              }}
            >
              <label className="composer-menu-search">
                <Folder size={16} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="引用绝对路径"
                  placeholder={
                    hostId === "local"
                      ? "/Users/你/文件或目录"
                      : "/home/user/文件或目录（远程主机）"
                  }
                  value={externalPath}
                  onChange={(event) => setExternalPath(event.target.value)}
                  disabled={externalBusy}
                />
              </label>
              <p className="composer-menu-path">
                {hostId === "local" ? "本机" : "当前远程主机"}上的绝对路径 · 由
                Agent 按当前权限读取
              </p>
              <button
                disabled={externalBusy || !externalPath.trim() || !connected}
                onClick={() => void addExternal()}
              >
                {externalBusy ? "正在检查…" : "添加引用"}
              </button>
            </div>
          ) : (
            browse !== null && (
              <label className="composer-menu-search">
                <Search size={16} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="搜索当前目录"
                  placeholder="搜索当前目录…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-controls={listId}
                  aria-activedescendant={
                    options.length ? `${listId}-${index}` : undefined
                  }
                />
              </label>
            )
          )}
          {mode === "files" && !external && (
            <div className="composer-menu-path">
              {path || "项目根目录"} · 引用路径，供 Agent 按需读取
            </div>
          )}
          <div
            hidden={external && mode === "files"}
            role="listbox"
            id={listId}
            aria-label={mode === "commands" ? "斜杠命令" : "项目引用"}
            className="composer-menu-list"
          >
            {options.map((option, i) => {
              const Icon =
                option.icon === "folder"
                  ? Folder
                  : option.icon === "file"
                    ? FileText
                    : option.icon === "back"
                      ? ArrowLeft
                      : null;
              return (
                <div
                  key={option.id}
                  id={`${listId}-${i}`}
                  title={
                    option.id.startsWith("entry:")
                      ? option.id.slice(6)
                      : `${option.label} ${option.detail}`
                  }
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setSelected(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={option.choose}
                  className="composer-menu-option"
                >
                  {Icon && <Icon size={17} />}
                  <span>
                    {option.icon === "command" ? (
                      <>
                        <span className="composer-command-title">
                          {option.label}
                        </span>
                        <span className="composer-command-id">
                          /{option.id}
                        </span>
                      </>
                    ) : (
                      option.label
                    )}
                  </span>
                  <small>{option.detail}</small>
                  {option.icon === "folder" &&
                    option.id.startsWith("entry:") && (
                      <ChevronRight size={15} />
                    )}
                </div>
              );
            })}
            {loading && (
              <p role="status">
                {mode === "commands"
                  ? "正在读取 Agent 原生命令…"
                  : "正在读取项目目录…"}
              </p>
            )}
            {error && (
              <div className="composer-menu-error" role="alert">
                {error}
                <button onClick={() => retry((n) => n + 1)}>重试</button>
              </div>
            )}
            {!loading && !error && !options.length && (
              <p>
                没有匹配项
                {mode === "commands"
                  ? "，以当前 Agent 返回的命令为准"
                  : "，可输入目录路径继续查找"}
              </p>
            )}
          </div>
          {mode === "files" && (
            <div
              className="composer-reference-actions"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  close();
                  input.current?.focus();
                }
              }}
            >
              {externalError && <p role="alert">{externalError}</p>}
              {hostId === "local" && external && (
                <>
                  <button
                    disabled={externalBusy || !connected}
                    onClick={() => void addExternal(false)}
                  >
                    <FileText size={16} />
                    选择文件并引用…
                  </button>
                  <button
                    disabled={externalBusy || !connected}
                    onClick={() => void addExternal(true)}
                  >
                    <Folder size={16} />
                    选择文件夹并引用…
                  </button>
                </>
              )}
              <button
                disabled={externalBusy}
                onClick={() => {
                  setExternal((current) => !current);
                  setExternalError("");
                }}
              >
                {external
                  ? "返回项目目录"
                  : hostId === "local"
                    ? "引用本机路径…"
                    : "引用远程路径…"}
              </button>
            </div>
          )}
          {mode === "commands" && (
            <div className="composer-menu-footer">
              <span>↑↓ 选择</span>
              <span>↵ 补全</span>
              <span>esc 关闭</span>
            </div>
          )}
        </div>
      )}
      {!!attached.length && (
        <div className="composer-references" aria-label="已添加附件和引用">
          {attached.map((entry) => (
            <span key={entry.path} title={entry.path}>
              <small className="composer-reference-kind">
                {entry.attachmentKind ? "附件" : "引用"}
              </small>
              {!entry.directory && referenceKind(entry) === "image" ? (
                <AttachmentImage
                  reference={entry}
                  variant="chip"
                  hostId={hostId}
                  projectId={projectId}
                  sessionId={sessionId}
                  connected={connected}
                  active={!hidden}
                  onOpen={close}
                />
              ) : (
                <>
                  {entry.directory ? (
                    <Folder size={14} />
                  ) : entry.attachmentKind === "video" ? (
                    <FileVideo size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                  <span>
                    {entry.attachmentKind && !entry.directory
                      ? entry.name
                      : entry.path}
                  </span>
                </>
              )}
              <button
                disabled={sending || pasting}
                aria-label={`${entry.attachmentKind ? "移除附件" : "移除引用"} ${entry.path}`}
                onClick={() =>
                  setReferences({
                    scope,
                    entries: attached.filter(
                      (item) => item.path !== entry.path,
                    ),
                  })
                }
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        rows={1}
        aria-label="任务输入"
        aria-autocomplete="list"
        aria-controls={menu && !addMenu ? listId : undefined}
        aria-expanded={menu && !addMenu}
        aria-activedescendant={
          menu && !addMenu && options.length ? `${listId}-${index}` : undefined
        }
        placeholder={placeholder}
        value={value}
        disabled={disabled || sending || pasting}
        onPaste={(event) => void paste(event)}
        onChange={(event) => {
          onChange(event.target.value);
          setNotice("");
          setBrowse(null);
          setAddMenu(false);
          setTrigger(
            composing.current
              ? null
              : composerTrigger(
                  event.target.value,
                  event.target.selectionStart,
                ),
          );
        }}
        onClick={(event) => {
          const el = event.currentTarget;
          setTrigger(composerTrigger(el.value, el.selectionStart));
          setBrowse(null);
        }}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            setTrigger(
              composerTrigger(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
              ),
            );
        }}
        onCompositionStart={() => {
          composing.current = true;
          close();
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setTrigger(
            composerTrigger(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            ),
          );
        }}
        onKeyDown={keys}
      />
      {pasting && (
        <div className="composer-notice" role="status">
          {pasteProgress}
        </div>
      )}
      {notice && (
        <div className="composer-notice" role="status">
          {notice}
        </div>
      )}
      {!!retryFiles.length && !pasting && (
        <div className="composer-attachment-retry">
          <button
            disabled={disabled || sending || !connected}
            onClick={() => void addFiles(retryFiles, true)}
          >
            重试添加附件
          </button>
          <button
            disabled={disabled || sending}
            onClick={() => {
              setRetryFiles([]);
              setNotice("");
            }}
          >
            移除未添加附件
          </button>
        </div>
      )}
      <div className="composer-toolbar">
        <button
          className="icon-button composer-add"
          title="添加附件或引用工作区文件"
          aria-label="添加文件"
          aria-haspopup="menu"
          aria-expanded={menu && addMenu}
          disabled={disabled || sending || pasting}
          onClick={() => {
            const open = !menu;
            close();
            setAddMenu(open);
          }}
        >
          <Plus size={19} />
        </button>
        {toolbar(
          () => void submit(),
          !pasting &&
            !retryFiles.length &&
            (!!value.trim() || !!attached.length),
          localNavigation,
        )}
      </div>
    </div>
  );
}
