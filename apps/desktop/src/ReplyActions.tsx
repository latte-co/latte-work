import { MessagesSquare } from "lucide-react";
import { CopyButton } from "./MessageContent";
import { MessageTimestamp } from "./MessageTimestamp";

export function ReplyActions({
  text,
  at,
  askInSideChat,
}: {
  text: string;
  at?: number;
  askInSideChat?: (quote: string) => void;
}) {
  return (
    <div className="final-reply-actions">
      <CopyButton text={text} label="复制回复" iconOnly />
      {askInSideChat && (
        <button
          className="icon-button"
          aria-label="在侧边聊天中追问"
          title="在侧边聊天中引用这条回复或选中文字"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const turn = e.currentTarget.closest(".conversation-turn");
            const range = window.getSelection();
            const inside = (node: Node | null) => {
              const element =
                node instanceof Element ? node : node?.parentElement;
              return element?.closest(".assistant-message");
            };
            const source = inside(range?.anchorNode ?? null);
            const selected =
              source &&
              turn?.contains(source) &&
              source === inside(range?.focusNode ?? null)
                ? range?.toString().trim()
                : "";
            askInSideChat(selected || text);
          }}
        >
          <MessagesSquare size={14} />
        </button>
      )}
      <MessageTimestamp at={at} label="回复时间" />
    </div>
  );
}
