import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  Globe2,
  Monitor,
  Plus,
} from "lucide-react";
import type { Host } from "./api";
import type { HostedProject } from "./projectCatalog";

export function TaskProjectPicker({
  project,
  projects,
  hosts,
  disabled,
  onSelect,
  onAddProject,
}: {
  project?: HostedProject;
  projects: HostedProject[];
  hosts: Host[];
  disabled: boolean;
  onSelect: (project: HostedProject) => void;
  onAddProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const hostName = (hostId: string) =>
    hosts.find((host) => host.id === hostId)?.name ?? hostId;
  const filtered = projects.filter((candidate) => {
    const term = query.trim().toLocaleLowerCase();
    return (
      !term ||
      `${candidate.name} ${candidate.path} ${hostName(candidate.hostId)}`
        .toLocaleLowerCase()
        .includes(term)
    );
  });
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  function choose(target: HostedProject) {
    onSelect(target);
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  }
  return (
    <div className="task-project-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="task-project-trigger"
        aria-label="选择任务项目"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => {
          setOpen((value) => !value);
          setQuery("");
          setActive(
            Math.max(
              0,
              projects.findIndex(
                (candidate) =>
                  candidate.hostId === project?.hostId &&
                  candidate.id === project?.id,
              ),
            ),
          );
        }}
      >
        <Folder size={15} />
        <strong>{project?.name ?? "选择项目"}</strong>
        {project && (
          <span className="task-project-host">
            {project.hostId === "local" ? (
              <Monitor size={13} />
            ) : (
              <Globe2 size={13} />
            )}
            {hostName(project.hostId)}
          </span>
        )}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="task-project-menu" aria-label="选择任务项目">
          <input
            ref={search}
            aria-label="搜索项目"
            placeholder="搜索项目"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) =>
                  filtered.length
                    ? (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        filtered.length) %
                      filtered.length
                    : 0,
                );
              } else if (event.key === "Enter" && filtered[active]) {
                event.preventDefault();
                choose(filtered[active]);
              }
            }}
          />
          <div className="task-project-list" id={id} role="listbox">
            {filtered.map((candidate, index) => (
              <button
                key={`${candidate.hostId}:${candidate.id}`}
                type="button"
                role="option"
                aria-selected={
                  candidate.hostId === project?.hostId &&
                  candidate.id === project?.id
                }
                className={active === index ? "active" : ""}
                title={candidate.path}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(candidate)}
              >
                <Folder size={15} />
                <span className="task-project-name">{candidate.name}</span>
                <small>
                  {candidate.hostId === "local" ? (
                    <Monitor size={12} />
                  ) : (
                    <Globe2 size={12} />
                  )}
                  {hostName(candidate.hostId)}
                </small>
                {candidate.hostId === project?.hostId &&
                  candidate.id === project?.id && <Check size={14} />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="task-project-empty">没有匹配的项目</div>
            )}
          </div>
          <button
            type="button"
            className="task-project-add"
            onClick={() => {
              setOpen(false);
              onAddProject();
            }}
          >
            <Plus size={15} /> 新建项目
          </button>
        </div>
      )}
    </div>
  );
}
