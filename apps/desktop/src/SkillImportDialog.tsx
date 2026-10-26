import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, Upload } from "lucide-react";
import { message } from "./api";
import { Modal } from "./Modal";
import {
  droppedSkillFiles,
  selectedSkillFiles,
  type SkillUpload,
} from "./skillImport";
export function SkillImportDialog({
  hostName,
  busy,
  connected,
  supported,
  error,
  onClose,
  onImport,
}: {
  hostName?: string;
  busy: boolean;
  connected: boolean;
  supported: boolean;
  error: string;
  onClose: () => void;
  onImport: (upload: SkillUpload) => void;
}) {
  const [upload, setUpload] = useState<SkillUpload>();
  const [selectionError, setSelectionError] = useState("");
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const revision = useRef(0);
  const locked = busy || reading || !connected || !supported;
  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );
  async function select(selection: Promise<SkillUpload>) {
    const version = ++revision.current;
    setReading(true);
    setSelectionError("");
    setUpload(undefined);
    try {
      const result = await selection;
      if (version === revision.current) setUpload(result);
    } catch (cause) {
      if (version === revision.current) setSelectionError(message(cause));
    } finally {
      if (version === revision.current) {
        setReading(false);
        requestAnimationFrame(() => {
          if (version === revision.current)
            (nameInput.current ?? chooseButton.current)?.focus();
        });
      }
    }
  }
  return (
    <div className="modal-backdrop">
      <Modal
        className="modal skill-import"
        aria-labelledby="skill-add-title"
        aria-describedby="skill-add-description skill-add-limits"
      >
        <h2 id="skill-add-title">添加技能</h2>
        <p id="skill-add-description">
          从此电脑选择技能，安装到 {hostName} 的全局技能目录。
        </p>
        <input
          hidden
          type="file"
          accept=".md,text/markdown"
          aria-label="选择 SKILL.md"
          ref={filePicker}
          disabled={locked}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (!locked && files.length) void select(selectedSkillFiles(files));
          }}
        />
        <input
          hidden
          type="file"
          multiple
          aria-label="选择技能文件夹"
          ref={(element) => {
            folderPicker.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          disabled={locked}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (!locked && files.length) void select(selectedSkillFiles(files));
          }}
        />
        <div
          className={`skill-import-drop${dragging ? " dragging" : ""}`}
          aria-label="拖入技能文件或文件夹"
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = locked ? "none" : "copy";
            if (!locked) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(false);
            if (!locked) void select(droppedSkillFiles(event.dataTransfer));
          }}
        >
          <Upload size={24} />
          <strong>
            {dragging ? "松开以选择技能" : "拖入 SKILL.md 或技能文件夹"}
          </strong>
          <span>文件夹内的脚本、模板和参考资料会一起导入</span>
          <div className="skill-import-choose">
            <button
              disabled={locked}
              ref={chooseButton}
              onClick={() => filePicker.current?.click()}
            >
              <FileText size={16} />
              选择文件
            </button>
            <button
              disabled={locked}
              onClick={() => folderPicker.current?.click()}
            >
              <FolderOpen size={16} />
              选择文件夹
            </button>
          </div>
        </div>
        {reading && <p role="status">正在读取技能…</p>}
        {upload && (
          <div className="skill-import-selection">
            <label>
              技能名称
              <input
                ref={nameInput}
                aria-label="技能名称"
                aria-describedby="skill-name-help"
                value={upload.name}
                disabled={busy}
                onChange={(e) => setUpload({ ...upload, name: e.target.value })}
              />
            </label>
            <p id="skill-name-help">使用英文字母、数字、连字符或下划线。</p>
            <p>已选择 {upload.files.length} 个文件</p>
            <ul aria-label="已选择的技能文件" tabIndex={0}>
              {upload.files.map((item) => (
                <li key={item.path}>{item.path}</li>
              ))}
            </ul>
          </div>
        )}
        <p id="skill-add-limits">
          安装到 {hostName} 的 ~/.agents/skills，原文件保留。最多 512 项、16
          MiB。
        </p>
        {!supported && (
          <p role="alert">
            此主机的 Server 尚不支持文件导入，请更新并重新连接。
          </p>
        )}
        {(selectionError || error) && (
          <p role="alert">{selectionError || error}</p>
        )}
        <div className="modal-actions">
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={
              locked ||
              !upload ||
              !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(upload.name)
            }
            onClick={() => {
              if (upload) onImport(upload);
            }}
          >
            {busy ? "正在安装…" : "安装"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
