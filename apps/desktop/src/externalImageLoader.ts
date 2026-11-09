import { request } from "./api";
import { isPreviewableImage } from "./MessageImage";
import { loadSource, type SourceData } from "./sourceLoader";

/**
 * Loader for absolute paths outside the project: each read performs the
 * server-side reference grant first, and any failure revokes that grant so a
 * path that can never render leaves no persisted access behind. The session
 * id is passed through so session sources also satisfy the server-side allow
 * check — agent-generated images are commonly session artifacts.
 */
export function createExternalImageLoader(
  hostId: string,
  projectId: string,
  sessionId: string | undefined,
): (path: string) => Promise<SourceData> {
  return (path) =>
    request(hostId, {
      method: "resolve_reference",
      project_id: projectId,
      path,
    })
      .then((response) => {
        if (response.kind !== "file_reference")
          throw new Error("无法解析引用，请更新项目所在主机的 Server");
        return loadSource(hostId, projectId, sessionId, path, () => true, true);
      })
      .then((data) => {
        if (!isPreviewableImage(data))
          throw new Error("此文件不能作为图片预览");
        return data;
      })
      .catch((cause) => {
        void request(hostId, {
          method: "revoke_reference_access",
          project_id: projectId,
          path,
        }).catch(() => undefined);
        throw cause;
      });
}
