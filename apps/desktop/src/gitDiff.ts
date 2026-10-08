export interface DiffLine {
  kind: "context" | "added" | "removed" | "hunk" | "meta";
  text: string;
  old: number | null;
  next: number | null;
}
export function parseDiff(content: string, limit = 4000) {
  const lines: DiffLine[] = [];
  let old = 0,
    next = 0,
    inHunk = false;
  let truncated = false;
  for (const raw of content.split("\n")) {
    if (lines.length >= limit) {
      truncated = true;
      break;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw, old: null, next: null });
    } else if (inHunk && raw.startsWith("+")) {
      lines.push({
        kind: "added",
        text: raw.slice(1),
        old: null,
        next: next++,
      });
    } else if (inHunk && raw.startsWith("-")) {
      lines.push({
        kind: "removed",
        text: raw.slice(1),
        old: old++,
        next: null,
      });
    } else if (inHunk && raw.startsWith(" ")) {
      lines.push({
        kind: "context",
        text: raw.slice(1),
        old: old++,
        next: next++,
      });
    } else if (raw) {
      lines.push({ kind: "meta", text: raw, old: null, next: null });
    }
  }
  return { lines, truncated };
}
export function splitDiff(lines: DiffLine[]) {
  const rows: { left?: DiffLine; right?: DiffLine; heading?: DiffLine }[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.kind === "removed" || line.kind === "added") {
      const removed: DiffLine[] = [],
        added: DiffLine[] = [];
      while (i < lines.length && ["removed", "added"].includes(lines[i].kind)) {
        const item = lines[i++];
        (item.kind === "removed" ? removed : added).push(item);
      }
      for (let j = 0; j < Math.max(removed.length, added.length); j++)
        rows.push({ left: removed[j], right: added[j] });
    } else {
      rows.push(
        line.kind === "context"
          ? { left: line, right: line }
          : { heading: line },
      );
      i++;
    }
  }
  return rows;
}
