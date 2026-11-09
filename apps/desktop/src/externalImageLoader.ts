import { loadSource, type SourceData } from "./sourceLoader";

/**
 * Loader for absolute paths rendered inside a conversation. The dedicated
 * `preview_message_image` request is display-only: the server never consults
 * or writes the per-project reference grants, so a reply can neither gain
 * nor resurrect persisted access by rendering an image and no rollback
 * bookkeeping is needed. `valid` is forwarded into the chunked read so an
 * unmounted image or a switched-away session stops occupying the shared
 * reader queue after the chunk in flight.
 */
export function createExternalImageLoader(
  hostId: string,
  projectId: string,
): (path: string, valid: () => boolean) => Promise<SourceData> {
  return (path, valid) =>
    loadSource(
      hostId,
      projectId,
      undefined,
      path,
      valid,
      false,
      "preview_message_image",
    );
}
