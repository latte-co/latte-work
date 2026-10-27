import { useMemo } from "react";
import { imageBytes, type ToolImage } from "./toolOutput";
import { RasterImage } from "./RasterImage";
function ToolImagePreview({
  image,
  name,
  active,
}: {
  image: ToolImage;
  name: string;
  active: boolean;
}) {
  const content = useMemo(() => {
    try {
      return imageBytes(image);
    } catch {
      return undefined;
    }
  }, [image]);
  return content ? (
    <RasterImage
      bytes={content}
      mime={image.mime_type}
      name={name}
      active={active}
    />
  ) : (
    <p className="panel-notice">图片格式无效，无法预览</p>
  );
}
export function ToolImages({
  images,
  active = true,
}: {
  images: ToolImage[];
  active?: boolean;
}) {
  return (
    <div className="tool-images">
      {images.map((image, i) => (
        <ToolImagePreview
          key={i}
          image={image}
          name={`工具输出图片 ${i + 1}`}
          active={active}
        />
      ))}
    </div>
  );
}
