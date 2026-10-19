// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  pinnedOrderKey as key,
  orderPinnedSessions,
  movePinnedOrder,
  readPinnedOrder,
  writePinnedOrder,
} from "./pinnedOrder";
const pins = [
  { hostId: "local", id: "same", title: "A" },
  { hostId: "remote", id: "same", title: "A" },
  { hostId: "remote", id: "third", title: "C" },
];
beforeEach(() => localStorage.clear());
it("persists mixed-host pins independently of project ordering and refreshed timestamps or titles", () => {
  localStorage.setItem(
    "latte-work.project-order.v1",
    JSON.stringify(["project-order"]),
  );
  writePinnedOrder(
    movePinnedOrder([], pins, key(pins[1]), key(pins[0]), false),
  );
  const refreshed = pins
    .map((pin) => ({ ...pin, title: "renamed", pinned_at: 999 }))
    .reverse();
  expect(orderPinnedSessions(refreshed, readPinnedOrder()).map(key)).toEqual([
    key(pins[1]),
    key(pins[0]),
    key(pins[2]),
  ]);
  expect(localStorage.getItem("latte-work.project-order.v1")).toBe(
    JSON.stringify(["project-order"]),
  );
});
it("retains absent pin slots, appends new pins, and ignores a stale move", () => {
  const previous = pins.map(key);
  const visible = [pins[0], pins[2]];
  const next = movePinnedOrder(
    previous,
    visible,
    key(pins[2]),
    key(pins[0]),
    false,
  );
  expect(next).toEqual([key(pins[2]), key(pins[1]), key(pins[0])]);
  expect(
    orderPinnedSessions(
      [...pins, { hostId: "new", id: "fourth", title: "D" }],
      next,
    ).map(key),
  ).toEqual([...next, JSON.stringify(["new", "fourth"])]);
  expect(
    movePinnedOrder(next, visible, key(pins[2]), key(pins[1]), false),
  ).toBe(next);
});
it("ignores malformed or duplicate saved pin order", () => {
  localStorage.setItem("latte-work.pinned-order.v1", "broken");
  expect(readPinnedOrder()).toEqual([]);
  localStorage.setItem(
    "latte-work.pinned-order.v1",
    JSON.stringify([key(pins[0]), true, key(pins[0])]),
  );
  expect(readPinnedOrder()).toEqual([key(pins[0])]);
});
