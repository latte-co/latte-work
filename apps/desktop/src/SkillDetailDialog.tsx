import { useState } from "react";
import { Box, Copy, Folder, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { message } from "./api";
import { copyText } from "./clipboard";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { skillScopes as scopes, skillStates as states } from "./SkillGrid";
import type { ManagedSkill, Response, SkillState } from "./protocol";
import type { Workbench } from "./useWorkbench";
export function SkillDetailDialog({
  detail,
  skill,
  error,
  busy,
  connected,
  hostName,
  projects,
  projectId,
  defaultTrialProject,
  onClose,
  onChange,
  onError,
  onRefresh,
  onTry,
}: {
  detail?: Extract<Response, { kind: "skill_detail" }>;
  skill?: ManagedSkill;
  error: string;
  busy: boolean;
  connected: boolean;
  hostName?: string;
  projects: Workbench["projects"];
  projectId?: string;
  defaultTrialProject: string;
  onClose: () => void;
  onChange: (skill: ManagedSkill, next: SkillState) => void;
  onError: (error: string) => void;
  onRefresh: () => void;
  onTry?: (projectId: string, skill: ManagedSkill) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [trialProject, setTrialProject] = useState(defaultTrialProject);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <Modal
        className="modal skill-detail"
        aria-labelledby="skill-detail-title"
      >
        <div className="skill-detail-top">
          <span className="skills-icon">
            <Box size={23} />
          </span>
          <div>
            {skill && (
              <button
                className="skill-toggle"
                role="switch"
                aria-label="启用技能"
                aria-checked={skill.state === "enabled"}
                disabled={busy || !connected || skill.state === "uninstalled"}
                onClick={() =>
                  onChange(
                    skill,
                    skill.state === "enabled" ? "disabled" : "enabled",
                  )
                }
              >
                <span />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="关闭技能详情"
              disabled={busy}
              onClick={() => {
                onClose();
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <h2 id="skill-detail-title">{skill?.name ?? "技能详情"}</h2>
        {!detail && (
          <p role="status">{error ? "技能详情暂不可用" : "正在读取…"}</p>
        )}
        {detail && (
          <>
            <p>{skill?.description}</p>
            <div className="skill-detail-meta">
              <span>
                {scopes.find((s) => s.value === skill?.scope)?.label} ·{" "}
                {skill && states[skill.state]}
              </span>
              <span>{hostName}</span>
            </div>
            {skill?.directory && (
              <div className="skill-detail-path" title={skill.directory}>
                <Folder size={14} />
                <span>{skill.directory}</span>
              </div>
            )}
            <div className="skill-markdown markdown" tabIndex={0}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ children, href }) => (
                    <span title={href}>{children}</span>
                  ),
                  img: ({ alt }) => <span>{alt || "图片"}</span>,
                }}
              >
                {detail.markdown.replace(
                  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                  "",
                )}
              </ReactMarkdown>
            </div>
            {onTry && (
              <div className="skill-trial-project">
                <Select
                  label="试用技能的项目"
                  compact
                  value={trialProject}
                  disabled={busy}
                  options={[
                    { value: "", label: "选择试用项目" },
                    ...projects
                      .filter(
                        (p) => skill?.scope !== "project" || p.id === projectId,
                      )
                      .map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={setTrialProject}
                />
              </div>
            )}
            <footer className="skill-detail-actions">
              <button
                className={skill?.state !== "uninstalled" ? "danger" : ""}
                disabled={busy || !connected}
                onClick={() =>
                  skill &&
                  onChange(
                    skill,
                    skill.state === "uninstalled" ? "enabled" : "uninstalled",
                  )
                }
              >
                {skill?.state === "uninstalled" ? "重新安装" : "卸载"}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  void copyText(detail.markdown)
                    .then(() => setCopied(true))
                    .catch((e) => onError(message(e)));
                }}
              >
                <Copy size={15} />
                {copied ? "已复制" : "复制 Markdown"}
              </button>
              {onTry && (
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !connected ||
                    skill?.state !== "enabled" ||
                    !trialProject
                  }
                  onClick={() => {
                    if (skill) void onTry?.(trialProject, skill);
                  }}
                >
                  立即试用
                </button>
              )}
            </footer>
          </>
        )}
        {error && (
          <p role="alert">
            {error}
            <button
              disabled={busy}
              onClick={() => {
                onRefresh();
              }}
            >
              刷新核对
            </button>
          </p>
        )}
      </Modal>
    </div>
  );
}
