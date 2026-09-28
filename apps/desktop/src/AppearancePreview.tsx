import { useState } from "react";
import { Shield, ShieldCheck, Plus, ChevronDown } from "lucide-react";
import { ComposerAction } from "./ComposerAction";
export function AppearancePreview() {
  const [running, setRunning] = useState(false);
  return (
    <div className="appearance-state-preview">
      <div className="preview-states" role="group" aria-label="预览状态">
        <button aria-pressed={!running} onClick={() => setRunning(false)}>
          编辑
        </button>
        <button aria-pressed={running} onClick={() => setRunning(true)}>
          运行中
        </button>
        <span>仅预览外观</span>
      </div>
      <div className="composer">
        <textarea
          readOnly
          placeholder="描述任务…"
          aria-label="输入区外观预览"
          rows={1}
        />
        <div className="composer-toolbar">
          <button disabled aria-label="添加引用预览">
            <Plus size={17} />
          </button>
          <div className="permission-picker">
            <Shield size={15} />
            <button className="select-trigger" disabled title="跟随 Agent">
              <span>跟随 Agent</span>
              <ChevronDown size={15} />
            </button>
          </div>
          <div className="model-picker">
            <button className="select-trigger" disabled>
              <span>default</span>
              <ChevronDown size={15} />
            </button>
          </div>
          <ComposerAction
            active={running}
            onClick={() => setRunning(!running)}
          />
          <ComposerAction disabled />
        </div>
      </div>
      <div className="approval-card" data-resolved={!running}>
        <div>
          <ShieldCheck size={16} />
          <strong>{running ? "需要你的确认" : "已允许此次操作"}</strong>
        </div>
        <p className="approval-summary">写入 README.md</p>
      </div>
    </div>
  );
}
