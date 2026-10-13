import { CopyButton } from "./MessageContent";
import { MessageTimestamp } from "./MessageTimestamp";

export function UserMessage({ text, at }: { text: string; at: number }) {
  return (
    <div className="user-message-group">
      <div className="user-message">{text}</div>
      <div className="user-message-meta">
        <MessageTimestamp at={at} label="发送时间" />
        <CopyButton text={text} label="复制消息" iconOnly />
      </div>
    </div>
  );
}
