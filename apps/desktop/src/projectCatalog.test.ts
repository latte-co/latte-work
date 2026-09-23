import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedProjects, readCatalog, writeCatalog } from "./projectCatalog";

afterEach(() => vi.unstubAllGlobals());
describe("host-scoped project catalog", () => {
  it("keeps identical project ids on different hosts separate and omits removed hosts", () => {
    const project = { id: "same-id", name: "workspace", path: "/workspace" };
    const catalog = { local: [project], remote: [project], removed: [project] };
    const rows = hostedProjects(catalog, ["local", "remote"]);
    expect(rows.map((p) => `${p.hostId}:${p.id}`)).toEqual([
      "local:same-id",
      "remote:same-id",
    ]);
    expect(rows[1].path).toBe("/workspace");
  });
  it("retains offline project names and ignores malformed cached host entries", () => {
    vi.stubGlobal("localStorage", {
      getItem: () =>
        JSON.stringify({
          local: [{ id: "1", name: "saved", path: "/saved" }],
          broken: [{ name: "missing-id" }],
        }),
    });
    expect(readCatalog()).toEqual({
      local: [{ id: "1", name: "saved", path: "/saved" }],
    });
  });
  it("does not block the workbench when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw Error("denied");
      },
      setItem: () => {
        throw Error("full");
      },
    });
    expect(readCatalog()).toEqual({});
    expect(() => writeCatalog({ local: [] })).not.toThrow();
  });
});
