import { Modal } from "./Modal";
import type { SkillChange } from "./useSkills";
type Shared = {
  hostName?: string;
  busy: boolean;
  connected: boolean;
  error: string;
  onClose: () => void;
};
export function SkillChangeDialog({
  confirm,
  hostName,
  busy,
  connected,
  error,
  onClose,
  onConfirm,
}: Shared & { confirm: SkillChange; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop skill-confirm-backdrop">
      <Modal
        className="modal"
        aria-labelledby="skill-confirm-title"
        aria-describedby="skill-confirm-description"
      >
        <h2 id="skill-confirm-title">
          {confirm.next === "uninstalled"
            ? "卸载"
            : confirm.next === "disabled"
              ? "禁用"
              : confirm.skill.state === "uninstalled"
                ? "安装"
                : "启用"}{" "}
          {confirm.skill.name}？
        </h2>
        <div id="skill-confirm-description">
          <p>主机：{hostName}</p>
          <p className="skill-detail-path">
            {confirm.skill.directory ?? "Latte Work 平台内置技能"}
          </p>
          <p>
            {confirm.skill.scope === "platform"
              ? "仅影响此主机上由 Latte Work 启动的 Agent。"
              : confirm.skill.state === "uninstalled"
                ? "会恢复到此主机的全局技能目录，影响使用该目录的其他 Agent。"
                : "会移动当前安装目录，影响这台主机上使用此目录的其他 Agent。"}
            {confirm.next === "uninstalled"
              ? "卸载后保留恢复副本，可在分类中重新安装。"
              : "可以随时在此恢复。"}{" "}
            已运行的会话及历史上下文保持原样，对后续新建的 Agent 会话生效。
          </p>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions">
          <button disabled={busy} onClick={() => onClose()}>
            取消
          </button>
          <button
            className={confirm.next === "uninstalled" ? "danger" : "primary"}
            disabled={busy || !connected}
            onClick={() => onConfirm()}
          >
            {busy ? "正在保存…" : "确认"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
export { SkillImportDialog } from "./SkillImportDialog";
