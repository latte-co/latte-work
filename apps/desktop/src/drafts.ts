import { useSyncExternalStore } from "react";
import type { ComposerReference } from "./pasteAttachments";

export interface Draft {
  text: string;
  skillCreator?: boolean;
  references: { scope: string; entries: ComposerReference[] };
}
const empty: Draft = { text: "", references: { scope: "", entries: [] } };
/** App-lifetime memory only. Never write prompts, attachment paths or secrets to storage. */
export class DraftStore {
  private drafts = new Map<string, Draft>();
  private versions = new WeakMap<Draft, object>();
  private listeners = new Set<() => void>();
  get = (key: string): Draft => this.drafts.get(key) ?? empty;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  update(key: string, patch: Partial<Draft>) {
    const previous = this.get(key);
    const next = { ...previous, ...patch };
    const sameReferences =
      previous.references.entries.length === next.references.entries.length &&
      next.references.entries.every(
        (entry, index) => entry === previous.references.entries[index],
      ) &&
      (next.references.scope === previous.references.scope ||
        (!next.references.entries.length &&
          (!previous.references.scope || !next.references.scope)));
    // Empty-reference scope alignment and duplicate input events do not edit the
    // submitted content. Real edits get a new version, including delete/retype.
    const sameContent =
      previous.text === next.text &&
      previous.skillCreator === next.skillCreator &&
      sameReferences;
    this.versions.set(
      next,
      sameContent ? (this.versions.get(previous) ?? previous) : next,
    );
    this.drafts.set(key, next);
    this.listeners.forEach((listener) => listener());
  }
  adopt(key: string, draft: Draft) {
    if (this.drafts.has(key)) return;
    this.drafts.set(key, draft);
    this.listeners.forEach((listener) => listener());
  }
  clear(key: string, submitted: Draft) {
    const current = this.get(key);
    if (
      (this.versions.get(current) ?? current) !==
      (this.versions.get(submitted) ?? submitted)
    )
      return;
    this.drafts.delete(key);
    this.listeners.forEach((listener) => listener());
  }
}
export function useDraft(store: DraftStore, key: string) {
  return useSyncExternalStore(store.subscribe, () => store.get(key));
}
