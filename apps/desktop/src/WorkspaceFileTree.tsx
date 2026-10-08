import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { message, request } from "./api";
import type { FileEntry } from "./protocol";

interface TreeProps {
  hostId: string;
  projectId: string;
  file: string;
  active: boolean;
  revision: number;
  openFile: (path: string) => void;
}

export function WorkspaceFileTree(props: TreeProps) {
  return <Directory {...props} path="" expanded />;
}

function Directory({
  path,
  expanded,
  ...props
}: TreeProps & { path: string; expanded: boolean }) {
  const { hostId, projectId, active, revision } = props;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active || !expanded) return;
    let disposed = false;
    setLoading(true);
    setError("");
    void request(hostId, { method: "files", project_id: projectId, path })
      .then((response) => {
        if (response.kind !== "files")
          throw new Error("无法读取项目文件，请检查 Server 版本");
        if (!disposed) setEntries(response.entries);
      })
      .catch((cause) => {
        if (!disposed) setError(message(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [hostId, projectId, path, active, expanded, revision, retry]);
  if (!expanded) return null;
  return (
    <ul className="file-tree-list">
      {loading && (
        <li className="file-tree-notice" role="status">
          正在读取…
        </li>
      )}
      {error && (
        <li className="file-tree-notice" role="alert">
          <span>{error}</span>
          <button onClick={() => setRetry((value) => value + 1)}>重试</button>
        </li>
      )}
      {entries.map((entry) => (
        <Entry key={entry.path} {...props} entry={entry} />
      ))}
      {!loading && !error && entries.length === 0 && (
        <li className="file-tree-notice">目录为空</li>
      )}
    </ul>
  );
}

function Entry({ entry, ...props }: TreeProps & { entry: FileEntry }) {
  const containsFile = props.file.startsWith(`${entry.path}/`);
  const [expanded, setExpanded] = useState(containsFile);
  useEffect(() => {
    if (containsFile) setExpanded(true);
  }, [props.file, containsFile]);
  return (
    <li>
      <button
        className="file-tree-entry"
        title={entry.path}
        aria-expanded={entry.directory ? expanded : undefined}
        aria-current={
          !entry.directory && entry.path === props.file ? "page" : undefined
        }
        onClick={() =>
          entry.directory
            ? setExpanded((value) => !value)
            : props.openFile(entry.path)
        }
      >
        {entry.directory ? (
          <>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Folder size={15} />
          </>
        ) : (
          <FileText size={15} />
        )}
        <span>{entry.name}</span>
      </button>
      {entry.directory && (
        <Directory {...props} path={entry.path} expanded={expanded} />
      )}
    </li>
  );
}
