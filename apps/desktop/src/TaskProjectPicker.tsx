import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Folder, Plus } from "lucide-react";
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
  const hostLabel = (hostId: string) =>
    hostId === "local" ? "本机" : `SSH · ${hostName(hostId)}`;
  const projectDescription = (value: HostedProject) =>
    `${hostLabel(value.hostId)} · ${value.path}`;
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
        aria-description={project ? projectDescription(project) : undefined}
        title={project ? projectDescription(project) : undefined}
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
        {project && project.hostId !== "local" && (
          <span className="task-project-host">
            <span>SSH ·</span>
            <span className="task-project-host-name">
              {hostName(project.hostId)}
            </span>
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
                title={projectDescription(candidate)}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(candidate)}
              >
                <Folder size={15} />
                <span className="task-project-name">{candidate.name}</span>
                <small>{hostLabel(candidate.hostId)}</small>
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
              trigger.current?.focus();
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
