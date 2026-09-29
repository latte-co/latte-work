import { useState } from "react";
import { Shield, Plus, ChevronDown } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { ComposerAction } from "./ComposerAction";
export function AppearancePreview() {
  const [mode, setMode] = useState<"empty" | "editing" | "running">("editing");
  const running = mode === "running";
  return (
    <div className="appearance-state-preview">
      <div className="preview-states" role="group" aria-label="预览状态">
        <button
          aria-pressed={mode === "empty"}
          onClick={() => setMode("empty")}
        >
          空输入
        </button>
        <button
          aria-pressed={mode === "editing"}
          onClick={() => setMode("editing")}
        >
          编辑
        </button>
        <button aria-pressed={running} onClick={() => setMode("running")}>
          运行中
        </button>
        <span>仅预览外观</span>
      </div>
      <div className="composer">
        <textarea
          readOnly
          placeholder="描述任务…"
          value={mode === "empty" ? "" : "帮我完善 README"}
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
            disabled={mode === "empty"}
            onClick={() => setMode(running ? "editing" : "running")}
          />
        </div>
      </div>
      <ApprovalCard
        request={{
          kind: "approval",
          request_id: "preview",
          tool: "Write",
          input: { file_path: "README.md", content: "# Latte Work" },
        }}
        resolved={!running}
        decision={!running ? "allowed" : undefined}
        disabled
        onDecision={() => {}}
      />
    </div>
  );
}
