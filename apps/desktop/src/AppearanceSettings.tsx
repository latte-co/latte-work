import { copyText } from "./clipboard";
import { AppearancePreview } from "./AppearancePreview";
import { MessageContent } from "./MessageContent";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Copy, RotateCcw, Upload } from "lucide-react";
import { Select } from "./Select";
import { useAppearance } from "./AppearanceProvider";
import {
  contrastRatio,
  defaultTheme,
  isColor,
  MAX_THEME_BYTES,
  parseAppearance,
  presets,
  resolveTheme,
  themeTokens,
  type ThemeConfig,
  type ThemeKind,
  type ThemeMode,
} from "./appearance";
const modes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
const fontOptions = [
  { value: "system", label: "系统默认" },
  { value: "sans", label: "无衬线" },
  { value: "serif", label: "衬线" },
  { value: "mono", label: "等宽" },
];
const weights = [
  { value: "400", label: "常规" },
  { value: "500", label: "中等" },
  { value: "600", label: "半粗" },
];
function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = isColor(draft);
  return (
    <div className="appearance-color-field">
      <div className="appearance-color-control">
        <input
          type="color"
          aria-label={`${label}拾色器`}
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <input
          aria-label={label}
          value={draft}
          maxLength={7}
          spellCheck={false}
          aria-invalid={!valid}
          onBlur={() => {
            if (!valid) setDraft(value);
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            if (isColor(e.target.value)) onChange(e.target.value.toUpperCase());
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(value);
            }
          }}
        />
      </div>
      {!valid && <small role="status">请输入 #RRGGBB</small>}
    </div>
  );
}

export function AppearanceSettings() {
  const { settings, kind, error, update } = useAppearance();
  const [editing, setEditing] = useState<ThemeKind>(kind);
  const [transferring, setTransferring] = useState(false);
  const [notice, setNotice] = useState("");
  const [importError, setImportError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const theme = settings[editing];
  const preset =
    Object.entries(presets[editing]).find(
      ([, p]) =>
        p.accent === theme.accent &&
        p.background === theme.background &&
        p.foreground === theme.foreground,
    )?.[0] ?? "custom";
  const patch = (value: Partial<ThemeConfig>) =>
    update({ ...settings, [editing]: { ...theme, ...value } });
  function importJson(text: string) {
    try {
      const next = parseAppearance(text);
      update(next);
      setImportError("");
      setEditing(
        resolveTheme(
          next.mode,
          window.matchMedia("(prefers-color-scheme: dark)").matches,
        ),
      );
      setNotice("已导入浅色、深色主题及主题模式。");
    } catch (e) {
      setImportError(String((e as Error).message));
    }
  }
  return (
    <div className="settings-panel-content appearance-settings">
      <h2>外观</h2>
      <p>让工作台适合你的阅读习惯。修改即时生效，并保存在此设备。</p>
      <h3>主题</h3>
      <div className="appearance-modes" role="group" aria-label="主题模式">
        {modes.map((mode) => (
          <button
            key={mode.value}
            className="appearance-mode"
            aria-pressed={settings.mode === mode.value}
            onClick={() => {
              update({ ...settings, mode: mode.value });
              setEditing(
                mode.value === "system"
                  ? window.matchMedia("(prefers-color-scheme: dark)").matches
                    ? "dark"
                    : "light"
                  : mode.value,
              );
            }}
          >
            <span
              className={`appearance-thumbnail ${mode.value}`}
              aria-hidden="true"
            >
              <span className="thumbnail-sidebar" />
              <span className="thumbnail-content">
                <i />
                <i />
                <span>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            </span>
            <span>
              {mode.label}
              {settings.mode === mode.value && <Check size={14} />}
            </span>
          </button>
        ))}
      </div>
      <div className="appearance-editor-heading">
        <div role="group" aria-label="编辑主题" className="appearance-segments">
          {(["light", "dark"] as const).map((k) => (
            <button
              key={k}
              aria-pressed={editing === k}
              onClick={() => setEditing(k)}
            >
              {k === "light" ? "浅色主题" : "深色主题"}
            </button>
          ))}
        </div>
        <span>{editing === kind ? "当前使用" : "切换主题模式后应用"}</span>
      </div>
      <div
        className="appearance-preview"
        style={themeTokens(theme) as CSSProperties}
        aria-label="主题预览"
      >
        <div className="appearance-preview-copy markdown">
          <MessageContent
            text={`### 让想法变成作品

这是聊天正文的预览。中文、English 和 \`inline code\` 保持清晰，**重点信息**稍作强调。

- 清晰的行距与段落留白，适合阅读较长的回复。
- [链接与强调色](#appearance-controls)与正文保持同一阅读节奏。`}
          />
        </div>
        <div className="appearance-preview-code">
          <div>
            <span>−</span>
            <code>const theme = "default";</code>
          </div>
          <div>
            <span>+</span>
            <code>const theme = "your style";</code>
          </div>
        </div>
      </div>
      <div
        className="appearance-preview"
        style={themeTokens(theme) as CSSProperties}
      >
        <AppearancePreview />
      </div>
      <div className="appearance-controls" id="appearance-controls">
        <div className="appearance-row">
          <strong>{editing === "dark" ? "深色主题" : "浅色主题"}</strong>
          <div className="appearance-actions">
            <button
              disabled={transferring}
              title="选择 JSON 文件，导入浅色、深色主题及主题模式"
              onClick={() => {
                setNotice("");
                setImportError("");
                fileInput.current?.click();
              }}
            >
              <Upload size={14} />
              导入
            </button>
            <button
              disabled={transferring}
              title="复制包含浅色、深色主题及主题模式的 JSON"
              onClick={async () => {
                setImportError("");
                setNotice("");
                setTransferring(true);
                try {
                  await copyText(JSON.stringify(settings, null, 2));
                  setNotice("已复制完整主题 JSON，可保存为 .json 文件后导入。");
                } catch {
                  setImportError(
                    "无法写入剪贴板，请重试或检查系统剪贴板权限。",
                  );
                } finally {
                  setTransferring(false);
                }
              }}
            >
              <Copy size={14} />
              复制主题
            </button>
            <Select
              label="主题预设"
              value={preset}
              compact
              options={[
                ...Object.keys(presets[editing]).map((value) => ({
                  value,
                  label: value,
                })),
                { value: "custom", label: "自定义" },
              ]}
              onChange={(v) => {
                if (presets[editing][v]) patch(presets[editing][v]);
              }}
            />
          </div>
        </div>
        {(
          [
            ["accent", "强调色"],
            ["background", "背景"],
            ["foreground", "前景"],
          ] as const
        ).map(([key, label]) => (
          <div className="appearance-row" key={key}>
            <span>{label}</span>
            <ColorControl
              label={label}
              value={theme[key]}
              onChange={(v) => patch({ [key]: v })}
            />
          </div>
        ))}
        {(
          [
            ["uiFont", "uiWeight", "UI 字体"],
            ["contentFont", "contentWeight", "内容字体"],
            ["codeFont", "codeWeight", "代码字体"],
          ] as const
        ).map(([font, weight, label]) => (
          <div className="appearance-row" key={font}>
            <span>{label}</span>
            <div className="appearance-font-controls">
              <Select
                label={label}
                value={theme[font]}
                compact
                options={
                  font === "codeFont"
                    ? [
                        { value: "system", label: "系统默认" },
                        { value: "menlo", label: "Menlo" },
                        { value: "consolas", label: "Consolas" },
                      ]
                    : font === "contentFont"
                      ? [
                          { value: "inherit", label: "与界面字体相同" },
                          ...fontOptions,
                        ]
                      : fontOptions
                }
                onChange={(v) => patch({ [font]: v })}
              />
              <Select
                label={`${label}字重`}
                value={theme[weight]}
                compact
                options={weights}
                onChange={(v) => patch({ [weight]: v })}
              />
            </div>
          </div>
        ))}
        <div className="appearance-row">
          <span>
            半透明侧边栏<small>应用内透明效果</small>
          </span>
          <button
            className="appearance-switch"
            role="switch"
            aria-label="半透明侧边栏"
            aria-checked={theme.translucentSidebar}
            onClick={() =>
              patch({ translucentSidebar: !theme.translucentSidebar })
            }
          >
            <span />
          </button>
        </div>
        <div className="appearance-row">
          <label htmlFor="appearance-contrast">对比度</label>
          <div className="appearance-slider">
            <input
              id="appearance-contrast"
              type="range"
              min="0"
              max="100"
              value={theme.contrast}
              onChange={(e) => patch({ contrast: Number(e.target.value) })}
            />
            <output htmlFor="appearance-contrast">{theme.contrast}</output>
          </div>
        </div>
      </div>
      {contrastRatio(theme.background, theme.foreground) < 4.5 && (
        <p className="appearance-warning" role="status">
          当前文字与背景对比度较低（
          {contrastRatio(theme.background, theme.foreground).toFixed(1)}
          :1），阅读可能吃力。可调整前景或背景颜色。
        </p>
      )}
      <div className="appearance-footer">
        <span>未安装的字体会自动使用备用字体。</span>
        <button
          onClick={() => {
            update({ ...settings, [editing]: defaultTheme(editing) });
            setNotice("已恢复当前编辑主题的默认设置。");
          }}
        >
          <RotateCcw size={14} />
          恢复此主题默认值
        </button>
      </div>
      <input
        ref={fileInput}
        className="appearance-file-input"
        hidden
        type="file"
        aria-label="导入主题 JSON 文件"
        accept=".json,application/json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setNotice("");
          setImportError("");
          if (file.size > MAX_THEME_BYTES) {
            setImportError("主题文件不能超过 32 KB。");
            return;
          }
          setTransferring(true);
          try {
            importJson(await file.text());
          } catch {
            setImportError("无法读取主题文件。");
          } finally {
            setTransferring(false);
          }
        }}
      />
      {importError && (
        <p role="alert" className="appearance-warning">
          {importError}
        </p>
      )}
      {error && (
        <p role="alert" className="appearance-warning">
          {error}
        </p>
      )}
      <p role="status" className="appearance-notice">
        {notice}
      </p>
    </div>
  );
}
