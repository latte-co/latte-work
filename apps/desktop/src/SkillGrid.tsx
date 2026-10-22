import { Box, Check } from "lucide-react";
import type { ManagedSkill, SkillScope, SkillState } from "./protocol";
export const skillScopes: { value: SkillScope; label: string }[] = [
  { value: "platform", label: "平台内置" },
  { value: "system", label: "系统" },
  { value: "project", label: "项目" },
];
export const skillStates: Record<SkillState, string> = {
  enabled: "已启用",
  disabled: "已禁用",
  uninstalled: "已卸载",
};

export function SkillGrid({
  skills,
  expanded,
  onExpand,
  query,
  loading,
  disabled,
  label,
  emptyMessage,
  onSelect,
}: {
  skills: ManagedSkill[];
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  query: string;
  loading: boolean;
  disabled: boolean;
  label: string;
  emptyMessage: string;
  onSelect: (skill: ManagedSkill, trigger: HTMLButtonElement) => void;
}) {
  return (
    <>
      <div className="skills-grid" aria-label={label}>
        {(expanded || query ? skills : skills.slice(0, 6)).map((skill) => (
          <button
            key={skill.id}
            className="skills-row"
            disabled={disabled}
            onClick={(event) => onSelect(skill, event.currentTarget)}
          >
            <span className="skills-icon">
              <Box size={22} />
            </span>
            <span className="skills-row-copy">
              <span>{skill.name}</span>
              <small title={skill.description || skill.origin}>
                {skill.description || skill.origin}
              </small>
            </span>
            <span
              className={`skills-state ${skill.state}`}
              title={skillStates[skill.state]}
              aria-label={skillStates[skill.state]}
            >
              {skill.state === "enabled" ? (
                <Check size={17} />
              ) : (
                skillStates[skill.state]
              )}
            </span>
          </button>
        ))}
      </div>
      {!skills.length && !loading && (
        <p className="skills-empty">
          {query ? "没有匹配的技能" : emptyMessage}
        </p>
      )}
      {skills.length > 6 && !query && (
        <button
          className="skills-expand"
          aria-expanded={expanded}
          onClick={() => onExpand(!expanded)}
        >
          {expanded ? "收起" : `查看全部，另有 ${skills.length - 6} 项`}
        </button>
      )}
    </>
  );
}
