import { useMemo } from "react";
import { parseDiff, splitDiff } from "./gitDiff";
export function ReviewDiff({
  content,
  split,
  wrap = false,
}: {
  content: string;
  split: boolean;
  wrap?: boolean;
}) {
  const parsed = useMemo(() => parseDiff(content), [content]);
  const lines = useMemo(
    () =>
      parsed.lines.some((line) => line.kind === "hunk")
        ? parsed.lines.filter(
            (line) =>
              line.kind !== "meta" ||
              !/^(diff --git |index |--- |\+\+\+ )/.test(line.text),
          )
        : parsed.lines,
    [parsed.lines],
  );
  const rows = useMemo(() => splitDiff(lines), [lines]);
  return (
    <>
      {parsed.truncated && (
        <p className="panel-notice">仅显示前 4000 行差异，请缩小比较范围。</p>
      )}
      <div
        className={`review-diff${split ? " split" : ""}${wrap ? " wrap" : ""}`}
        role="region"
        aria-label={split ? "并排文件差异" : "统一文件差异"}
        tabIndex={0}
      >
        {split
          ? rows.map((row, i) =>
              row.heading ? (
                <div
                  className={`review-diff-heading ${row.heading.kind}`}
                  key={i}
                >
                  <code>{row.heading.text}</code>
                </div>
              ) : (
                <div className="review-split-row" key={i}>
                  <div
                    className={`review-diff-cell ${row.left?.kind ?? "blank"}`}
                  >
                    <span aria-hidden="true">{row.left?.old}</span>
                    <code>{row.left?.text || " "}</code>
                  </div>
                  <div
                    className={`review-diff-cell ${row.right?.kind ?? "blank"}`}
                  >
                    <span aria-hidden="true">{row.right?.next}</span>
                    <code>{row.right?.text || " "}</code>
                  </div>
                </div>
              ),
            )
          : lines.map((line, i) => (
              <div className={`review-unified-row ${line.kind}`} key={i}>
                <span aria-hidden="true">{line.old}</span>
                <span aria-hidden="true">{line.next}</span>
                <code>
                  {line.kind === "added"
                    ? "+"
                    : line.kind === "removed"
                      ? "−"
                      : " "}
                  {line.text || " "}
                </code>
              </div>
            ))}
      </div>
    </>
  );
}
