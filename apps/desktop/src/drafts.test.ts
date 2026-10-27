import { expect, it } from "vitest";
import { DraftStore } from "./drafts";

it("clears an acknowledged message after duplicate input and empty-reference initialization", () => {
  const store = new DraftStore();
  store.update("task", { text: "sent" });
  const submitted = store.get("task");
  store.update("task", { text: "sent" });
  store.update("task", {
    references: { scope: "local:p:claude", entries: [] },
  });
  store.clear("task", submitted);
  expect(store.get("task").text).toBe("");
});
it("keeps a real edit even if it eventually has the same text as the acknowledged message", () => {
  const store = new DraftStore();
  store.update("task", { text: "repeat" });
  const submitted = store.get("task");
  store.update("task", { text: "" });
  store.update("task", { text: "repeat" });
  store.clear("task", submitted);
  expect(store.get("task").text).toBe("repeat");
});
it("preserves a draft retargeted to another host even when it has no references", () => {
  const store = new DraftStore();
  store.update("new-task", {
    text: "message",
    references: { scope: "local:p:claude", entries: [] },
  });
  const submitted = store.get("new-task");
  store.update("new-task", {
    references: { scope: "remote:q:claude", entries: [] },
  });
  store.clear("new-task", submitted);
  expect(store.get("new-task").text).toBe("message");
});
it("retains newly selected references when a prior message is accepted", () => {
  const store = new DraftStore();
  store.update("task", { text: "message" });
  const submitted = store.get("task");
  store.update("task", {
    references: {
      scope: "local:p:claude",
      entries: [{ path: "new.md", name: "new.md", directory: false }],
    },
  });
  store.clear("task", submitted);
  expect(store.get("task").references.entries[0].path).toBe("new.md");
});
