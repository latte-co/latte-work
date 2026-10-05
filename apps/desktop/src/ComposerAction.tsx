import { ArrowUp, LoaderCircle, Square } from "lucide-react";
export function ComposerAction({
  active = false,
  sending = false,
  disabled = false,
  onClick,
}: {
  active?: boolean;
  sending?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`send${active ? " stop" : ""}`}
      aria-label={active ? "停止任务" : "发送任务"}
      title={active ? "停止任务" : "发送任务"}
      disabled={disabled}
      onClick={onClick}
    >
      {active ? (
        <Square size={14} fill="currentColor" />
      ) : sending ? (
        <LoaderCircle size={17} className="spin" />
      ) : (
        <ArrowUp size={19} />
      )}
    </button>
  );
}
