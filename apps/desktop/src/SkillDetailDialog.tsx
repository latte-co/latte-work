import { useState } from "react";
import { Box, Copy, Folder, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { message } from "./api";
import { copyText } from "./clipboard";
import { Modal } from "./Modal";
import { skillScopes as scopes, skillStates as states } from "./SkillGrid";
import type { ManagedSkill, Response, SkillState } from "./protocol";
export function SkillDetailDialog({
  detail,
  skill,
  error,
  busy,
  connected,
  hostName,
  onClose,
  onChange,
  onError,
  onRefresh,
}: {
  detail?: Extract<Response, { kind: "skill_detail" }>;
  skill?: ManagedSkill;
  error: string;
  busy: boolean;
  connected: boolean;
  hostName?: string;
  onClose: () => void;
  onChange: (skill: ManagedSkill, next: SkillState) => void;
  onError: (error: string) => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
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
            <footer className="skill-detail-actions">
              {skill && skill.state !== "uninstalled" && (
                <button
                  className="danger"
                  disabled={busy || !connected}
                  onClick={() => onChange(skill, "uninstalled")}
                >
                  卸载
                </button>
              )}
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
              <button
                className="primary"
                disabled={busy || !connected || skill?.state !== "uninstalled"}
                onClick={() => {
                  if (skill) onChange(skill, "enabled");
                }}
              >
                {skill?.state === "uninstalled" ? "安装" : "已安装"}
              </button>
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
