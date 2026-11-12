import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImagePreview, useImagePreview } from "./ImageGallery";

export function RasterImage({
  bytes,
  mime,
  name,
  imageKey,
  active: enabled = true,
}: {
  bytes: Uint8Array;
  mime: string;
  name: string;
  imageKey?: string;
  active?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  const identity = useMemo(() => ({ bytes, mime }), [bytes, mime]);
  const preview = useImagePreview(identity, enabled, trigger, imageKey);
  const { open, active } = preview;
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
        onClick={preview.show}
      >
        {url && !failed ? (
          <img src={url} alt={name} onError={() => setFailed(true)} />
        ) : (
          <span>{failed ? "图片无法解码" : name}</span>
        )}
      </button>
      <ImagePreview preview={preview} name={name}>
        {url && !failed ? (
          <img src={url} alt={name} onError={() => setFailed(true)} />
        ) : (
          <p role="status">{failed ? "图片无法解码" : "正在读取图片…"}</p>
        )}
      </ImagePreview>
    </>
  );
}
