import type { JsonValue } from "./protocol";
/** A bounded, readable preview; full redacted parameters remain available below it. */
export function ApprovalOperation({ input }: { input: JsonValue }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const fields = [
    ["command", "命令"],
    ["old_string", "替换前"],
    ["new_string", "替换后"],
    ["content", "写入内容"],
  ].filter(([key]) => typeof input[key] === "string");
  return (
    <div className="approval-operation">
      {fields.map(([key, label]) => {
        const text = input[key] as string;
        return (
          <div key={key}>
            <small>{label}</small>
            <pre>
              {text.slice(0, 4000)}
              {text.length > 4000 ? "\n…预览已截断，请展开完整参数" : ""}
            </pre>
          </div>
        );
      })}
    </div>
  );
}
