import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ContextUsage, Event, TurnUsage } from "./protocol";

export function usageSnapshot(events: Event[], sessionId?: string) {
  let context: ContextUsage | null = null;
  let totals: TurnUsage | null = null;
  for (const { event } of events.filter((e) => e.session_id === sessionId)) {
    if (event.kind === "user") totals = null;
    if (event.kind === "usage") {
      context = event.context;
      totals = event.totals;
    }
  }
  return { context, totals };
}
const number = (value: number | null | undefined) =>
  value == null ? "未提供" : value.toLocaleString("zh-CN");
export function cacheRate(totals: TurnUsage | null) {
  if (
    !totals ||
    totals.input_tokens == null ||
    totals.cache_read_tokens == null ||
    totals.cache_write_tokens == null
  )
    return null;
  const input =
    totals.input_tokens + totals.cache_read_tokens + totals.cache_write_tokens;
  return input > 0 ? (totals.cache_read_tokens / input) * 100 : null;
}

export function UsageIndicator({
  events,
  sessionId,
  hidden = false,
}: {
  events: Event[];
  sessionId?: string;
  hidden?: boolean;
}) {
  const { context, totals } = usageSnapshot(events, sessionId);
  const percent = context?.window_tokens
    ? (context.used_tokens / context.window_tokens) * 100
    : null;
  const hit = cacheRate(totals);
  const tokenCounts = [
    totals?.input_tokens,
    totals?.cache_read_tokens,
    totals?.cache_write_tokens,
    totals?.output_tokens,
  ];
  const totalTokens = tokenCounts.every((v) => v != null)
    ? tokenCounts.reduce<number>((sum, v) => sum + (v ?? 0), 0)
    : null;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    left: 8,
    top: 8,
    width: 320,
    maxHeight: 480,
  });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    setOpen(false);
  }, [sessionId, hidden]);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const place = () => {
      if (!button.current) return;
      const box = button.current.getBoundingClientRect();
      const width = Math.min(336, window.innerWidth - 16);
      const maxHeight = window.innerHeight - 24;
      const height = Math.min(
        (panel.current?.scrollHeight ?? 480) + 2,
        maxHeight,
      );
      setPosition({
        width,
        maxHeight,
        left: Math.max(
          8,
          Math.min(box.right - width, window.innerWidth - width - 8),
        ),
        top: Math.max(8, box.top - height - 8),
      });
    };
    place();
    window.addEventListener("resize", place);
    close.current?.focus();
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !button.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div className="usage-indicator">
      <button
        ref={button}
        type="button"
        className="usage-trigger"
        aria-label="上下文与用量统计"
        title="上下文与用量统计"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            opacity="0.25"
          />
          {percent != null && (
            <circle
              cx="10"
              cy="10"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              pathLength="100"
              strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`}
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
      </button>
      {open &&
        !hidden &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label="上下文与用量统计"
            className="usage-panel"
            style={position}
          >
            <header>
              <strong>上下文与用量</strong>
              <button
                type="button"
                ref={close}
                aria-label="关闭用量统计"
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            </header>
            <section>
              <h3>
                上下文{" "}
                <span>
                  {percent == null
                    ? "占比未知"
                    : `${Math.round(percent)}% 已用`}
                </span>
              </h3>
              <dl>
                <dt>已用 / 总容量</dt>
                <dd>
                  {number(context?.used_tokens)} /{" "}
                  {number(context?.window_tokens)}
                </dd>
              </dl>
              <div className="usage-track" aria-hidden="true">
                <i
                  style={{
                    width: `${Math.min(100, Math.max(0, percent ?? 0))}%`,
                  }}
                />
              </div>
            </section>
            <section>
              <h3>
                Token 用量{" "}
                <span>
                  {totalTokens == null
                    ? "本轮"
                    : `${number(totalTokens)} tok · 本轮`}
                </span>
              </h3>
              <dl>
                <dt>缓存命中</dt>
                <dd>{hit == null ? "未提供" : `${Math.round(hit)}%`}</dd>
                <dt>未缓存输入</dt>
                <dd>{number(totals?.input_tokens)}</dd>
                <dt>缓存读取</dt>
                <dd>{number(totals?.cache_read_tokens)}</dd>
                <dt>缓存写入</dt>
                <dd>{number(totals?.cache_write_tokens)}</dd>
                <dt>输出</dt>
                <dd>{number(totals?.output_tokens)}</dd>
              </dl>
            </section>
            <section>
              <h3>
                执行统计 <span>本轮</span>
              </h3>
              <dl>
                <dt>模型用时</dt>
                <dd>
                  {totals?.model_time_ms == null
                    ? "未提供"
                    : `${(totals.model_time_ms / 1000).toFixed(1)} 秒`}
                </dd>
                <dt>模型调用步数</dt>
                <dd>{number(totals?.steps)}</dd>
                <dt>工具用时 / TTFT / TPS</dt>
                <dd>未提供</dd>
              </dl>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
