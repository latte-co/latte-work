import { useEffect, useState } from "react";
import { ArrowLeft, FileDiff, RefreshCw } from "lucide-react";
import type { GitChange, Project } from "./protocol";
import { request, message } from "./api";
import { CodeView } from "./CodeView";
const sections = { unstaged: "未暂存", staged: "已暂存", untracked: "未跟踪" };
const statuses: Record<string, string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  R: "重命名",
  C: "复制",
  U: "冲突",
  "?": "新增",
};
export function ChangesView({
  hostId,
  project,
  active,
}: {
  hostId: string;
  project: Project;
  active: boolean;
}) {
  const [entries, setEntries] = useState<GitChange[]>([]);
  const [selected, setSelected] = useState<GitChange>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [content, setContent] = useState("");
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setError("");
    setContent("");
    setTruncated(false);
    void request(
      hostId,
      selected
        ? {
            method: "change_diff",
            project_id: project.id,
            path: selected.path,
            section: selected.section,
          }
        : { method: "changes", project_id: project.id },
    )
      .then((r) => {
        if (disposed) return;
        if (r.kind === "changes") {
          setEntries(r.entries);
          setTruncated(r.truncated);
        } else if (r.kind === "content") {
          setContent(r.text);
          setTruncated(r.truncated);
        } else
          throw new Error(
            "此 Server 不支持结构化改动，请更新到与 App 相同的版本",
          );
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
  }, [active, hostId, project.id, revision, selected]);
  const lines = content.split("\n");
  const added =
    selected?.section === "untracked"
      ? lines.length - (lines.at(-1) === "" ? 1 : 0)
      : lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
          .length;
  const removed = lines.filter(
    (line) => line.startsWith("-") && !line.startsWith("---"),
  ).length;
  return (
    <>
      <div className="workspace-file-heading">
        <span>工作区改动</span>
        <button
          className="icon-button"
          title="刷新"
          aria-label="刷新改动"
          disabled={loading}
          onClick={() => refresh((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="breadcrumb" title={project.path}>
        {project.name}
        <span>/</span>
        {selected?.path || "项目内的 Git 改动"}
      </div>
      {selected && (
        <div className="file-toolbar">
          <button onClick={() => setSelected(undefined)}>
            <ArrowLeft size={13} />
            返回改动列表
          </button>
          <span>
            {sections[selected.section]}
            {!loading && !error && (
              <span className="diff-stats">
                {" "}
                · +{added} −{selected.section === "untracked" ? 0 : removed}
              </span>
            )}
          </span>
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
      ) : selected ? (
        <>
          {truncated && (
            <p className="panel-notice">内容已截断，统计仅包含显示部分。</p>
          )}
          {content ? (
            <CodeView
              content={content}
              diff={selected.section !== "untracked"}
            />
          ) : (
            <div className="panel-empty">此文件已无差异，返回列表刷新。</div>
          )}
        </>
      ) : (
        <div className="changes-list">
          <p className="panel-notice">
            {entries.length
              ? `${new Set(entries.map((entry) => entry.path)).size} 个文件有改动`
              : "工作区干净，没有改动"}
            {truncated ? " · 仅显示前 1000 项或部分结果，请缩小项目范围" : ""}
          </p>
          {Object.entries(sections).map(([section, title]) => {
            const files = entries.filter((entry) => entry.section === section);
            return files.length ? (
              <section key={section}>
                <h3>
                  {title}
                  <span>{files.length}</span>
                </h3>
                {files.map((entry) => (
                  <button
                    key={entry.path}
                    title={
                      entry.previous_path
                        ? `${entry.previous_path} → ${entry.path}`
                        : entry.path
                    }
                    onClick={() => setSelected(entry)}
                  >
                    <FileDiff size={15} />
                    <span>{entry.path}</span>
                    <small>{statuses[entry.status] ?? entry.status}</small>
                  </button>
                ))}
              </section>
            ) : null;
          })}
        </div>
      )}
    </>
  );
}
