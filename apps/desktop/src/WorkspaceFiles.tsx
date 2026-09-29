import { useAppClose } from "./appLifecycle";
import { CodeView } from "./CodeView";
import { useEffect, useState } from "react";
import { FileText, Folder, ArrowLeft, RefreshCw } from "lucide-react";
import type { FileEntry, Project } from "./protocol";
import { request, message } from "./api";
import { ChangesView } from "./ChangesView";

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
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active || tab !== "files") return;
    let disposed = false;
    setLoading(true);
    setError("");
    void request(
      hostId,
      file
        ? { method: "read_file", project_id: project.id, path: file }
        : { method: "files", project_id: project.id, path },
    )
      .then((r) => {
        if (disposed) return;
        if (r.kind === "files") setEntries(r.entries);
        else if (r.kind === "content") {
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
  }, [hostId, project.id, path, file, tab, revision, active]);
  if (tab === "diff")
    return <ChangesView hostId={hostId} project={project} active={active} />;
  return (
    <>
      <div className="workspace-file-heading">
        <span>项目文件</span>
        <button
          className="icon-button"
          aria-label="刷新"
          title="刷新"
          disabled={loading}
          onClick={() => refresh((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="breadcrumb" title={file || path || project.path}>
        {project.name}
        <span>/</span>
        {file || path || "文件"}
      </div>
      {(file || path) && (
        <div className="file-toolbar">
          <button
            onClick={() =>
              file
                ? navigate({ file: "" })
                : navigate({ path: path.split("/").slice(0, -1).join("/") })
            }
          >
            <ArrowLeft size={13} />
            {file ? "返回目录" : "上一级"}
          </button>
          {file && !loading && !error && (
            <span>只读预览{truncated ? " · 内容已截断" : ""}</span>
          )}
        </div>
      )}
      {loading ? (
        <div className="panel-empty" role="status">
          正在读取…
        </div>
      ) : error ? (
        <div className="panel-error" role="alert">
          {error}
        </div>
      ) : !file ? (
        <div className="file-list">
          {entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() =>
                navigate(
                  entry.directory ? { path: entry.path } : { file: entry.path },
                )
              }
            >
              {entry.directory ? <Folder size={15} /> : <FileText size={15} />}
              <span>{entry.name}</span>
            </button>
          ))}
          {entries.length === 0 && <p className="muted">目录为空</p>}
        </div>
      ) : (
        <CodeView content={content} />
      )}
    </>
  );
}
