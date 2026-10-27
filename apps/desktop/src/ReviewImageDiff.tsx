import { useEffect, useState } from "react";
import type { ChangeImage, ChangeImageLoader } from "./changeImageLoader";
import { imageRead } from "./AttachmentImage";
import { RasterImage } from "./RasterImage";
import { message } from "./api";

export function ReviewImageDiff({
  path,
  load,
  active,
}: {
  path: string;
  load: ChangeImageLoader;
  active: boolean;
}) {
  const [revision, retry] = useState(0);
  const [state, setState] = useState<{
    load: ChangeImageLoader;
    path: string;
    sides?: { image?: ChangeImage | null; error?: string }[];
    error?: string;
  }>();
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const valid = () => !disposed;
    setState(undefined);
    void imageRead(async () => {
      const sides = [];
      for (const before of [true, false]) {
        if (!valid()) throw new Error("图片预览已取消");
        try {
          sides.push({ image: await load(path, before, valid) });
        } catch (error) {
          sides.push({ error: message(error) });
        }
      }
      return sides;
    }, valid)
      .then((sides) => {
        if (valid()) setState({ load, path, sides });
      })
      .catch((error) => {
        if (valid()) setState({ load, path, error: message(error) });
      });
    return () => {
      disposed = true;
    };
  }, [path, load, active, revision]);
  const current =
    state?.load === load && state.path === path ? state : undefined;
  const retryButton = (
    <button
      className="secondary small"
      disabled={!active}
      onClick={() => retry((v) => v + 1)}
    >
      重试图片预览
    </button>
  );
  return (
    <div className="review-image-diff">
      {current?.sides ? (
        current.sides.map(({ image, error }, i) => (
          <figure key={i}>
            <figcaption>{i ? "修改后" : "修改前"}</figcaption>
            {error ? (
              <div role="alert">
                <p>{error}</p>
                {retryButton}
              </div>
            ) : image ? (
              <RasterImage
                bytes={image.bytes}
                mime={image.mime}
                name={`${path} · ${i ? "修改后" : "修改前"}`}
                active={active}
              />
            ) : (
              <p className="panel-notice">此版本没有文件</p>
            )}
          </figure>
        ))
      ) : current?.error ? (
        <div role="alert">
          <p>{current.error}</p>
          <button
            className="secondary small"
            disabled={!active}
            onClick={() => retry((v) => v + 1)}
          >
            重试图片预览
          </button>
        </div>
      ) : (
        <p role="status">正在读取图片…</p>
      )}
    </div>
  );
}
