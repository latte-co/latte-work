import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Modal } from "./Modal";

export function RasterImage({
  bytes,
  mime,
  name,
  active = true,
}: {
  bytes: Uint8Array;
  mime: string;
  name: string;
  active?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  const [open, setOpen] = useState(false);
  const [resource, setResource] = useState<{
    bytes: Uint8Array;
    mime: string;
    url: string;
  }>();
  const url =
    active && resource?.bytes === bytes && resource.mime === mime
      ? resource.url
      : "";
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active || !trigger.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { rootMargin: "120px" },
    );
    observer.observe(trigger.current);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    setOpen(false);
    setFailed(false);
  }, [bytes, mime, active]);
  useEffect(() => {
    if (!active || (!near && !open)) {
      setResource(undefined);
      return;
    }
    const next = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: mime }),
    );
    setResource({ bytes, mime, url: next });
    return () => URL.revokeObjectURL(next);
  }, [bytes, mime, active, near, open]);
  return (
    <>
      <button
        ref={trigger}
        className="raster-image"
        aria-label={`放大图片 ${name}`}
        onClick={() => setOpen(true)}
      >
        {url && !failed ? (
          <img src={url} alt={name} onError={() => setFailed(true)} />
        ) : (
          <span>{failed ? "图片无法解码" : name}</span>
        )}
      </button>
      {open &&
        active &&
        createPortal(
          <div
            className="modal-backdrop attachment-image-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <Modal
              className="modal attachment-image-dialog"
              aria-label={`图片预览 ${name}`}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !e.defaultPrevented) {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
            >
              <header>
                <span>{name}</span>
                <button
                  className="icon-button"
                  aria-label="关闭图片预览"
                  onClick={() => setOpen(false)}
                >
                  <X size={18} />
                </button>
              </header>
              <div className="attachment-image-stage">
                {url && !failed ? (
                  <img src={url} alt={name} onError={() => setFailed(true)} />
                ) : (
                  <p role="status">
                    {failed ? "图片无法解码" : "正在读取图片…"}
                  </p>
                )}
              </div>
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}
