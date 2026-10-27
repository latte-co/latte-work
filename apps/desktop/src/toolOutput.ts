import type { JsonValue, ToolOutputBlock } from "./protocol";
export type ToolImage = Extract<ToolOutputBlock, { type: "image" }>;
export function toolOutput(value: JsonValue) {
  const images: ToolImage[] = [];
  if (!Array.isArray(value)) return { content: value, images };
  const content = value.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block))
      return block;
    if (block.type === "image" && "data_base64" in block) {
      if (
        typeof block.mime_type === "string" &&
        typeof block.data_base64 === "string" &&
        images.length < 4 &&
        block.data_base64.length <= 384 * 1024
      ) {
        images.push(block as ToolImage);
      }
      return { type: "text", text: "[图片]" };
    }
    return block;
  });
  return { content, images };
}
export function imageBytes(image: ToolImage) {
  const bytes = Uint8Array.from(atob(image.data_base64), (c) =>
    c.charCodeAt(0),
  );
  const magic =
    image.mime_type === "image/png"
      ? bytes.slice(0, 8).join() === "137,80,78,71,13,10,26,10"
      : image.mime_type === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : image.mime_type === "image/gif"
          ? ["GIF87a", "GIF89a"].includes(
              String.fromCharCode(...bytes.slice(0, 6)),
            )
          : image.mime_type === "image/webp"
            ? String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
              String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
            : false;
  if (!magic) throw new Error("图片格式无效，无法预览");
  return bytes;
}
