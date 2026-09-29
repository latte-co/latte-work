import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./api";

type Participant = {
  label: string;
  close: () => void | Promise<void>;
  resume?: () => void;
};
/** One awaited shutdown transaction for all mounted tabs, including hidden ones. */
export class CloseCoordinator {
  private participants = new Map<symbol, Participant>();
  private pending?: Promise<void>;
  register(participant: Participant) {
    const key = Symbol();
    this.participants.set(key, participant);
    return () => {
      this.participants.delete(key);
    };
  }
  run(): Promise<void> {
    if (this.pending) return this.pending;
    const participants = [...this.participants.values()];
    this.pending = Promise.allSettled(
      participants.map((p) => Promise.resolve().then(p.close)),
    )
      .then((results) => {
        const errors = results.flatMap((r, i) =>
          r.status === "rejected"
            ? [
                `${participants[i].label}：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
              ]
            : [],
        );
        if (errors.length) throw new Error(errors.join("\n"));
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  resume() {
    for (const p of this.participants.values()) p.resume?.();
  }
}
export const appClose = new CloseCoordinator();
export function useAppClose(
  label: string,
  close: Participant["close"],
  resume?: () => void,
) {
  const latest = useRef({ label, close, resume });
  latest.current = { label, close, resume };
  useEffect(
    () =>
      appClose.register({
        get label() {
          return latest.current.label;
        },
        close: () => latest.current.close(),
        resume: () => latest.current.resume?.(),
      }),
    [],
  );
}
export function useAppLifecycle() {
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const listeners = [
      listen<string>("app-close-requested", async ({ payload: requestId }) => {
        if (disposed) return;
        let error: string | null = null;
        try {
          await appClose.run();
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        if (!disposed)
          await invoke("app_close_ready", { requestId, error }).catch(() =>
            appClose.resume(),
          );
      }),
      listen("app-close-cancelled", () => {
        if (!disposed) appClose.resume();
      }),
    ];
    return () => {
      disposed = true;
      for (const listener of listeners)
        void listener.then((unlisten) => unlisten());
    };
  }, []);
}
