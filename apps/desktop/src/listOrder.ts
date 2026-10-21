export type HostedItem = { hostId: string; id: string };

export const itemOrderKey = (item: HostedItem) =>
  JSON.stringify([item.hostId, item.id]);

export function readOrder(storageKey: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter((key): key is string => typeof key === "string"),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}
export function writeOrder(storageKey: string, order: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(order));
  } catch {
    /* The in-memory layout remains usable when preferences cannot be saved. */
  }
}
export function orderItems<T extends HostedItem>(items: T[], order: string[]) {
  const remaining = new Map(items.map((p) => [itemOrderKey(p), p]));
  const result: T[] = [];
  for (const key of order) {
    const item = remaining.get(key);
    if (item) {
      result.push(item);
      remaining.delete(key);
    }
  }
  return [...result, ...remaining.values()];
}

/** Shared insertion rule for drag previews, keyboard moves and saved ordering. */
export function moveItemKeys(
  keys: string[],
  source: string,
  target: string,
  after: boolean,
) {
  if (source === target || !keys.includes(source) || !keys.includes(target))
    return keys;
  const next = keys.filter((key) => key !== source);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
  return next.every((key, i) => key === keys[i]) ? keys : next;
}

/** Replace visible slots, retaining preferences for hosts not currently loaded. */
export function moveItemOrder<T extends HostedItem>(
  previous: string[],
  items: T[],
  source: string,
  target: string,
  after: boolean,
): string[] {
  const keys = orderItems(items, previous).map(itemOrderKey);
  const next = moveItemKeys(keys, source, target, after);
  if (next === keys) return previous;
  const visible = new Set(keys);
  const result = previous.map((key) =>
    visible.has(key) ? next.shift()! : key,
  );
  return [...result, ...next];
}
