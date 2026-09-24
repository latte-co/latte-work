import { useEffect, useState } from "react";
import { FileText, Folder, ArrowLeft, RefreshCw } from "lucide-react";
import type { FileEntry, Project } from "./protocol";
import { request, message } from "./api";
export function WorkspaceFiles({
  hostId,
  project,
  tab,
  active,
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
  const setPath = (path: string) => navigate({ path });
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [content, setContent] = useState("");
  const setFile = (file: string) => navigate({ file });
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setError("");
    const query =
      tab === "diff"
        ? { method: "diff" as const, project_id: project.id }
        : file
          ? { method: "read_file" as const, project_id: project.id, path: file }
          : { method: "files" as const, project_id: project.id, path };
    void request(hostId, query)
      .then((r) => {
        if (disposed) return;
        if (r.kind === "files") setEntries(r.entries);
        if (r.kind === "content") {
          setContent(r.text);
          setTruncated(r.truncated);
        }
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
  return (
    <>
      <div className="workspace-file-heading">
        <span>{tab === "files" ? "项目文件" : "工作区改动"}</span>
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
      <div className="breadcrumb">
        {project.name}
        <span>/</span>
        {tab === "diff" ? "Git diff" : file || path || "文件"}
      </div>
      {loading ? (
        <div className="panel-empty">正在读取…</div>
      ) : error ? (
        <div className="panel-error">{error}</div>
      ) : tab === "files" && !file ? (
        <div className="file-list">
          {path && (
            <button
              onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
            >
              <ArrowLeft size={15} />
              上一级
            </button>
          )}
          {entries.map((e) => (
            <button
              key={e.path}
              onClick={() => (e.directory ? setPath(e.path) : setFile(e.path))}
            >
              {e.directory ? <Folder size={15} /> : <FileText size={15} />}
              <span>{e.name}</span>
            </button>
          ))}
          {entries.length === 0 && <p className="muted">目录为空</p>}
        </div>
      ) : (
        <>
          <div className="file-toolbar">
            {tab === "files" && (
              <button onClick={() => setFile("")}>
                <ArrowLeft size={13} />
                返回目录
              </button>
            )}
            <span>只读预览{truncated ? " · 内容已截断" : ""}</span>
          </div>
          <div className="code-view">
            {content.split("\n").map((line, i) => (
              <div
                className={`code-line ${tab === "diff" ? (line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "hunk" : "") : ""}`}
                key={i}
              >
                <span className="line-number">{i + 1}</span>
                <code>{line || " "}</code>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
