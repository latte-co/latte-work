export function MessageTimestamp({
  at,
  label,
}: {
  at?: number;
  label: "发送时间" | "回复时间";
}) {
  if (at === undefined) return null;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const text =
    new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(date) +
    new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString("zh-CN", { hour12: false })}
      aria-label={`${label}：${text}`}
    >
      {text}
    </time>
  );
}
