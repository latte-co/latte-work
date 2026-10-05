export function CodeView({
  content,
  diff = false,
}: {
  content: string;
  diff?: boolean;
}) {
  return (
    <div
      className="code-view"
      tabIndex={0}
      role="region"
      aria-label={diff ? "文件差异" : "文件内容"}
    >
      {content.split("\n").map((line, i) => (
        <div
          className={`code-line ${diff ? (line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : "") : ""}`}
          key={i}
        >
          <span className="line-number" aria-hidden="true">
            {i + 1}
          </span>
          <code>{line || " "}</code>
        </div>
      ))}
    </div>
  );
}
