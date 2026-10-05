export const HOST_DISCONNECTED_EVENT = "latte-work:host-disconnected";
export const HOST_CONNECTION_PREFIX = "HOST_CONNECTION_LOST:";

/** Native transport failures are distinct from Server/application errors. */
export class HostConnectionError extends Error {
  constructor(
    public readonly hostId: string,
    detail: string,
  ) {
    super(detail);
    this.name = "HostConnectionError";
  }
}
