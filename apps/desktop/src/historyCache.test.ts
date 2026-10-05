import { expect, it } from "vitest";
import { HistoryCache } from "./historyCache";
import type { Event } from "./protocol";

const events = [
  { seq: 1, at: 1, session_id: "s", event: { kind: "text", text: "History" } },
] as Event[];
it("bounds retained history and evicts the least recently viewed conversation", () => {
  const cache = new HistoryCache(2);
  cache.set('["local","a"]', events);
  cache.set('["remote","a"]', events);
  expect(cache.get('["local","a"]')).toBe(events);
  cache.set('["local","b"]', events);
  expect(cache.get('["remote","a"]')).toBeUndefined();
  cache.clearHost("local");
  expect(cache.get('["local","a"]')).toBeUndefined();
  expect(cache.get('["local","b"]')).toBeUndefined();
});
it("does not retain oversized histories or keep an outdated shorter version", () => {
  const cache = new HistoryCache(2, JSON.stringify(events).length * 2);
  cache.set('["local","a"]', events);
  cache.set('["local","b"]', events);
  expect(cache.get('["local","a"]')).toBeUndefined();
  cache.set('["local","b"]', [...events, { ...events[0], seq: 2 }]);
  expect(cache.get('["local","b"]')).toBeUndefined();
});
it("retains the raw cursor of compacted windows independently of their event IDs", () => {
  const cache = new HistoryCache();
  cache.set('["remote","s"]', events, true, 0.5);
  expect(cache.get('["remote","s"]')).toBe(events);
  expect(cache.hasEarlier('["remote","s"]')).toBe(true);
  expect(cache.before('["remote","s"]')).toBe(0.5);
  cache.clearHost("remote");
  expect(cache.hasEarlier('["remote","s"]')).toBe(false);
  expect(cache.before('["remote","s"]')).toBeNull();
});
