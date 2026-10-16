import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  Copy,
  ExternalLink,
  Info,
  LockKeyhole,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { SiteIcon } from "./SiteIcon";
import { webLink } from "./browserLinks";
import { copyText } from "./clipboard";

export type SiteInfo = {
  url: string;
  title: string;
  connection: "secure" | "insecure" | "mixed" | "unknown";
  icon?: string;
};
export function BrowserSiteInfo({
  id,
  url,
  active,
  ready,
}: {
  id: string;
  url: string;
  active: boolean;
  ready: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const address = webLink(url);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  useEffect(() => {
    if (!open || !active) return;
    let disposed = false;
    setInfo(null);
    setError("");
    setCopied(false);
    void invoke<SiteInfo>("browser_site_info", { id, icon: false }).then(
      (value) => {
        if (!disposed && value && webLink(value.url) === address)
          setInfo(value);
        else if (!disposed) setError("页面已变化，请重新查看站点信息");
      },
      () => {
        if (!disposed) setError("暂时无法读取站点信息");
      },
    );
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      if (event.key === "Tab") {
        const buttons = [
          ...(panel.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        event.preventDefault();
        buttons[
          (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
        ]?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    return () => {
      disposed = true;
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      if (trigger.current?.isConnected && !trigger.current.closest("[hidden]"))
        trigger.current.focus();
    };
  }, [open, active, id, address]);
  const rect = trigger.current?.getBoundingClientRect();
  const connection = info?.connection;
  const ConnectionIcon =
    connection === "secure"
      ? LockKeyhole
      : connection === "unknown" || !connection
        ? Info
        : ShieldAlert;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button browser-site-trigger"
        title="站点信息"
        aria-label="站点信息"
        aria-haspopup="dialog"
        aria-expanded={open && active}
        disabled={!ready || !address}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open &&
        active &&
        address &&
        rect &&
        createPortal(
          <div
            ref={panel}
            className="browser-site-info"
            role="dialog"
            aria-label="站点信息"
            tabIndex={-1}
            style={{
              left: Math.max(
                8,
                Math.min(
                  rect.left,
                  window.innerWidth - Math.min(344, window.innerWidth - 16) - 8,
                ),
              ),
              top: Math.max(
                8,
                Math.min(rect.bottom + 8, window.innerHeight - 264),
              ),
            }}
          >
            <header>
              <SiteIcon url={url} />
              <strong title={new URL(address).host}>
                {new URL(address).host}
              </strong>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭站点信息"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            {info?.title && (
              <p className="browser-site-title" title={info.title}>
                {info.title}
              </p>
            )}
            <div className="browser-site-connection">
              <ConnectionIcon size={18} />
              <div>
                <span>
                  {error ||
                    (!info
                      ? "正在读取站点信息…"
                      : connection === "secure"
                        ? "连接是安全的"
                        : connection === "insecure"
                          ? "连接未加密"
                          : connection === "mixed"
                            ? "此页面包含不安全内容"
                            : "连接信息暂不可用")}
                </span>
                {connection === "secure" && (
                  <small>此页面使用 HTTPS，证书已通过系统验证。</small>
                )}
                {connection === "insecure" && (
                  <small>此页面使用 HTTP，请勿输入密码等敏感信息。</small>
                )}
              </div>
            </div>
            <footer>
              <button
                type="button"
                onClick={() =>
                  void copyText(address).then(
                    () => setCopied(true),
                    () => setError("复制未完成，请重试"),
                  )
                }
              >
                <Copy size={16} />
                {copied ? "已复制" : "复制网址"}
              </button>
              <button
                type="button"
                onClick={() =>
                  void invoke("open_external_url", { url: address }).then(
                    () => setOpen(false),
                    () => setError("未能打开系统浏览器"),
                  )
                }
              >
                <ExternalLink size={16} />
                在系统浏览器中打开
              </button>
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
