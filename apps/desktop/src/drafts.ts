import { useSyncExternalStore } from "react";
import type { ComposerReference } from "./pasteAttachments";

export interface Draft {
  text: string;
  references: { scope: string; entries: ComposerReference[] };
}
const empty: Draft = { text: "", references: { scope: "", entries: [] } };
/** App-lifetime memory only. Never write prompts, attachment paths or secrets to storage. */
export class DraftStore {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  get = (key: string): Draft => this.drafts.get(key) ?? empty;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  update(key: string, patch: Partial<Draft>) {
    this.drafts.set(key, { ...this.get(key), ...patch });
    this.listeners.forEach((listener) => listener());
  }
  adopt(key: string, draft: Draft) {
    if (this.drafts.has(key)) return;
    this.drafts.set(key, draft);
    this.listeners.forEach((listener) => listener());
  }
  clear(key: string, submitted: Draft) {
    if (this.get(key) !== submitted) return;
    this.drafts.delete(key);
    this.listeners.forEach((listener) => listener());
  }
}
export function useDraft(store: DraftStore, key: string) {
  return useSyncExternalStore(store.subscribe, () => store.get(key));
}
