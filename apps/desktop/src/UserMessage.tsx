import { CopyButton } from "./MessageContent";

export function UserMessage({ text, at }: { text: string; at: number }) {
  const sent = new Date(at);
  const valid = Number.isFinite(sent.getTime());
  const label = valid
    ? new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(sent) +
      new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(sent)
    : null;
  return (
    <div className="user-message-group">
      <div className="user-message">{text}</div>
      <div className="user-message-meta">
        {valid && (
          <time
            dateTime={sent.toISOString()}
            title={sent.toLocaleString("zh-CN", { hour12: false })}
            aria-label={`发送时间：${label}`}
          >
            {label}
          </time>
        )}
        <CopyButton text={text} label="复制消息" iconOnly />
      </div>
    </div>
  );
}
