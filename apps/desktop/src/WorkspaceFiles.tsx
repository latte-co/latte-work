import { useAppClose } from "./appLifecycle";
import { CodeView } from "./CodeView";
import { useEffect, useState } from "react";
import { Folders, RefreshCw, WrapText } from "lucide-react";
import type { Project } from "./protocol";
import { request, message } from "./api";
import { ChangesView } from "./ChangesView";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import { useStatusIssues } from "./statusNotices";
import { useFileTreeWidth } from "./useFileTreeWidth";

const WRAP_STORAGE_KEY = "latte-work.file-wrap.v1";

function savedWrap() {
  try {
    return localStorage.getItem(WRAP_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function WorkspaceFiles({
  hostId,
  project,
  tab,
  active: visible,
  path,
  file,
  navigate,
}: {
  hostId: string;
  project: Project;
  tab: "files" | "diff";
  active: boolean;
  path: string;
  file: string;
  navigate: (value: { path?: string; file?: string }) => void;
}) {
  const [closing, setClosing] = useState(false);
  const active = visible && !closing;
  useAppClose(
    `${tab === "diff" ? "改动" : "文件"} · ${project.name}`,
    () => {
      setClosing(true);
    },
    () => setClosing(false),
  );
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [wrap, setWrap] = useState(savedWrap);
  const treeWidth = useFileTreeWidth(active && tab === "files" && treeOpen);
  useEffect(() => {
    try {
      localStorage.setItem(WRAP_STORAGE_KEY, String(wrap));
    } catch {
      // Wrapping remains available when local storage is unavailable.
    }
  }, [wrap]);
  useEffect(() => {
    if (!active || tab !== "files") return;
    if (!file) {
      setLoading(false);
      setError("");
      return;
    }
    let disposed = false;
    setLoading(true);
    setError("");
    void request(hostId, {
      method: "read_file",
      project_id: project.id,
      path: file,
    })
      .then((r) => {
        if (disposed) return;
        if (r.kind === "content") {
          setContent(r.text);
          setTruncated(r.truncated);
        } else throw new Error("无法读取项目文件，请检查 Server 版本");
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [hostId, project.id, file, tab, revision, active]);
  useStatusIssues([
    {
      id: `file:${hostId}:${project.id}:${file || path}`,
      title: `${file || path || project.name} 未能读取`,
      error: active && tab === "files" && file ? error : "",
      pending: active && tab === "files" && !!file && loading,
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
  ]);
  if (tab === "diff")
    return <ChangesView hostId={hostId} project={project} active={active} />;
  return (
    <div className="workspace-files">
      <div className="workspace-file-header">
        <div
          className="workspace-file-path"
          title={`${project.path}/${file || path}`}
        >
          <button
            className="workspace-file-project"
            aria-label="返回项目目录"
            title={project.path}
            disabled={!file && !path}
            onClick={() => {
              navigate({ file: "", path: "" });
              setTreeOpen(true);
            }}
          >
            {project.name}
          </button>
          <span className="workspace-file-path-separator">/</span>
          <span className="workspace-file-location">
            {file || path || "文件"}
          </span>
        </div>
        {file && !loading && !error && truncated && (
          <span className="workspace-file-truncated">内容已截断</span>
        )}
        <div className="workspace-file-actions">
          <button
            className="icon-button"
            aria-label="自动换行"
            title="自动换行"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={treeOpen ? "隐藏文件树" : "显示文件树"}
            title={treeOpen ? "隐藏文件树" : "显示文件树"}
            aria-pressed={treeOpen}
            onClick={() => setTreeOpen((value) => !value)}
          >
            <Folders size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="刷新"
            title="刷新"
            disabled={loading}
            onClick={() => refresh((v) => v + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="workspace-files-body" ref={treeWidth.container}>
        <div className="workspace-file-content">
          {!file ? (
            <div className="workspace-file-empty">
              <Folders size={28} aria-hidden="true" />
              <strong>打开文件</strong>
              <span>从右侧目录选择文件</span>
            </div>
          ) : loading ? (
            <div className="panel-empty" role="status">
              正在读取…
            </div>
          ) : error ? null : (
            <CodeView key={file} content={content} wrap={wrap} />
          )}
        </div>
        <div
          className="resize-handle workspace-file-resize"
          role="separator"
          aria-label="调整文件目录宽度"
          aria-orientation="vertical"
          aria-valuemin={Math.round(treeWidth.minimum)}
          aria-valuemax={Math.round(treeWidth.maximum)}
          aria-valuenow={treeWidth.width}
          tabIndex={0}
          hidden={!treeOpen}
          onPointerDown={treeWidth.onPointerDown}
          onKeyDown={treeWidth.onKeyDown}
        />
        <nav
          className="workspace-file-tree"
          aria-label="项目文件树"
          hidden={!treeOpen}
          style={{ flexBasis: treeWidth.width }}
        >
          <WorkspaceFileTree
            key={`${hostId}:${project.id}`}
            hostId={hostId}
            projectId={project.id}
            file={file}
            directoryPath={path}
            active={active && treeOpen}
            revision={revision}
            openFile={(nextFile) =>
              navigate({
                file: nextFile,
                path: nextFile.split("/").slice(0, -1).join("/"),
              })
            }
          />
        </nav>
      </div>
    </div>
  );
}
