import { useContext, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, ImageOff, LoaderCircle } from "lucide-react";
import { message } from "./api";
import { imageRead } from "./AttachmentImage";
import { classifyLinkHref } from "./inlineReferences";
import { MessageActionsContext } from "./messageActions";
import type { SourceData } from "./sourceLoader";

// Same allowlist as attachment thumbnails: server MIME sniffing never offers
// SVG as image/*, so markup-based images cannot reach the img element.
const IMAGE_MIME = /^(image\/(png|jpeg|gif|webp|bmp|tiff|avif|heic|heif))$/;
/** Shared payload gate for message images and the external-image loader. */
export function isPreviewableImage(data: SourceData): boolean {
  return IMAGE_MIME.test(data.mime) && !data.truncated;
}

type LoadState = { url?: string; error?: string; loading?: boolean };

/** A path that can never render as an image; explain instead of offering a grant. */
function UnavailableImage({ path, hint }: { path: string; hint: string }) {
  return (
    <span className="message-image-placeholder" title={path}>
      <ImageOff size={16} aria-hidden="true" />
      <span>{path}</span>
      <span className="message-image-hint">{hint}</span>
    </span>
  );
}

/** A local file image that renders automatically through its scoped reader. */
function MessageLocalImage({
  path,
  alt,
  granted,
}: {
  path: string;
  alt: string;
  granted: boolean;
}) {
  const actions = useContext(MessageActionsContext);
  // Project paths read through the existing bounded project reader; absolute
  // paths outside the project go through the reference-granted reader.
  const loader = granted ? actions.readProjectFile : actions.loadExternalImage;
  // The provider rebuilds its callback identity on every conversation render;
  // reads key off the path, so the newest callback rides along in a ref
  // instead of retriggering the load effect. The boolean form also re-arms
  // the effect if a reader appears later, so loading cannot stall forever.
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const hasLoader = loader !== undefined;
  const [revision, retry] = useState(0);
  const [state, setState] = useState<LoadState>({});
  const resource = useRef<{ url: string } | undefined>(undefined);
  const target = useRef<HTMLSpanElement>(null);
  // Images load lazily once they approach the viewport: the async read and
  // its in-place loading state never delay the rest of the message flow, and
  // off-screen images in a long reply cost no reads at all.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!hasLoader || !target.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    let disposed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!disposed)
          setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "120px" },
    );
    observer.observe(target.current);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [hasLoader]);
  function release() {
    if (resource.current) URL.revokeObjectURL(resource.current.url);
    resource.current = undefined;
  }
  useEffect(() => release, []);
  const enabled = hasLoader && visible;
  useEffect(() => {
    if (!enabled || !loaderRef.current) return;
    let disposed = false;
    const valid = () => !disposed;
    release();
    setState({ loading: true });
    void imageRead(() => loaderRef.current!(path), valid)
      .then((data: SourceData) => {
        if (disposed) return;
        if (!isPreviewableImage(data))
          throw new Error("此文件不能作为图片预览");
        const url = URL.createObjectURL(
          new Blob([data.bytes as BlobPart], { type: data.mime }),
        );
        resource.current = { url };
        setState({ url });
      })
      .catch((error) => {
        if (!disposed) {
          release();
          setState({ error: message(error) });
        }
      });
    return () => {
      disposed = true;
    };
  }, [path, enabled, revision]);
  if (state.url) {
    return (
      <img
        className="message-image"
        src={state.url}
        alt={alt}
        title={path}
        onError={() => {
          release();
          setState({ error: "图片格式无法解码" });
        }}
      />
    );
  }
  const error = state.error;
  const loading = !error && state.loading;
  return (
    <span
      ref={target}
      className="message-image-placeholder"
      role={error ? "alert" : loading ? "status" : undefined}
      title={path}
    >
      {error ? (
        <ImageOff size={16} aria-hidden="true" />
      ) : loading ? (
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
      ) : (
        <ImageIcon size={16} aria-hidden="true" />
      )}
      <span>{path}</span>
      {error ? (
        <>
          <span className="message-image-hint">{error}</span>
          <button
            type="button"
            className="secondary small"
            onClick={() => retry((value) => value + 1)}
          >
            重试
          </button>
        </>
      ) : loading ? (
        <span className="message-image-hint">正在读取图片…</span>
      ) : (
        !hasLoader && (
          <span className="message-image-hint">当前视图无法加载图片</span>
        )
      )}
    </span>
  );
}

/**
 * Markdown image targets: http(s) and other non-path targets keep the default
 * img element (the CSP only admits favicon hosts, so remote images keep the
 * pre-existing broken rendering — unchanged here); local paths auto-load in
 * place — project paths through the bounded project reader, absolute paths
 * through the reference-granted reader with rollback on failure.
 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const reference = src ? classifyLinkHref(src) : ({ kind: "text" } as const);
  if (reference.kind !== "projectPath" && reference.kind !== "externalPath")
    return <img src={src} alt={alt} />;
  if (reference.kind === "externalPath") {
    // Granting access is only offered for paths the server can actually read:
    // home-relative paths never resolve (absolute paths only) and directories
    // would persist a whole-subtree grant for a payload that can never render.
    if (!reference.path.startsWith("/"))
      return (
        <UnavailableImage
          path={reference.path}
          hint="需要使用绝对路径才能加载"
        />
      );
    if (reference.path.endsWith("/"))
      return (
        <UnavailableImage path={reference.path} hint="目录不能作为图片预览" />
      );
  }
  return (
    <MessageLocalImage
      path={reference.path}
      alt={alt ?? ""}
      granted={reference.kind === "projectPath"}
    />
  );
}
