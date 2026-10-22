import { CodeView } from "./CodeView";
import { MessageContent } from "./MessageContent";

export function isMarkdownFile(path: string) {
  return /\.(md|markdown)$/i.test(path);
}

export function FileTextView({
  content,
  wrap = false,
  markdown = false,
}: {
  content: string;
  wrap?: boolean;
  markdown?: boolean;
}) {
  return markdown ? (
    <div
      className="workspace-markdown-preview markdown"
      role="region"
      aria-label="Markdown 预览"
      tabIndex={0}
    >
      <MessageContent text={content} />
    </div>
  ) : (
    <CodeView content={content} wrap={wrap} />
  );
}
