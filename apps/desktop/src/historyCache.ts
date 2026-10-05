import type { Event } from "./protocol";

/** Bounded history windows; live status still comes from the host on every poll. */
export class HistoryCache {
  private entries = new Map<
    string,
    {
      events: Event[];
      size: number;
      hasEarlier: boolean;
      before: number | null;
    }
  >();
  private size = 0;
  constructor(
    private maxEntries = 12,
    private maxSize = 64 * 1024 * 1024,
  ) {}
  get(scope: string) {
    const entry = this.entries.get(scope);
    if (!entry) return undefined;
    this.entries.delete(scope);
    this.entries.set(scope, entry);
    return entry.events;
  }
  hasEarlier(scope: string) {
    return this.entries.get(scope)?.hasEarlier ?? false;
  }
  before(scope: string) {
    return this.entries.get(scope)?.before ?? null;
  }
  set(
    scope: string,
    events: Event[],
    hasEarlier = false,
    before: number | null = hasEarlier ? (events[0]?.seq ?? null) : null,
  ) {
    const previous = this.entries.get(scope);
    if (
      previous?.events === events &&
      previous.hasEarlier === hasEarlier &&
      previous.before === before
    )
      return;
    this.size -= previous?.size ?? 0;
    this.entries.delete(scope);
    // UTF-16 storage estimate, including event metadata; oversized histories
    // remain viewable but are not retained for another conversation.
    const size = JSON.stringify(events).length * 2;
    if (size > this.maxSize) return;
    this.entries.set(scope, { events, size, hasEarlier, before });
    this.size += size;
    while (this.entries.size > this.maxEntries || this.size > this.maxSize) {
      const oldest = this.entries.keys().next().value!;
      this.size -= this.entries.get(oldest)!.size;
      this.entries.delete(oldest);
    }
  }
  clearHost(host: string) {
    for (const [scope, entry] of this.entries) {
      if (JSON.parse(scope)[0] === host) {
        this.size -= entry.size;
        this.entries.delete(scope);
      }
    }
  }
}
