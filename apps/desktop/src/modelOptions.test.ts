import { describe, expect, it } from "vitest";
import { modelOptions } from "./modelOptions";

describe("native model names", () => {
  it("shows custom names while retaining native aliases as selection values", () => {
    expect(
      modelOptions(["sonnet", "haiku"], {
        sonnet: "alwaysday1",
        haiku: "deepseek-v4.1-flash",
      }).slice(1),
    ).toEqual([
      { value: "sonnet", label: "alwaysday1", description: "Sonnet" },
      { value: "haiku", label: "deepseek-v4.1-flash", description: "Haiku" },
    ]);
  });
  it("falls back for an old Host or a Provider without native labels", () => {
    expect(modelOptions(["sonnet", "provider-model"])).toEqual([
      { value: "", label: "default" },
      { value: "sonnet", label: "sonnet", description: undefined },
      {
        value: "provider-model",
        label: "provider-model",
        description: undefined,
      },
    ]);
  });
  it("keeps Traex display names without putting long native IDs beside them", () => {
    expect(
      modelOptions(
        ["Doubao-Seed-Evolving", "alwaysday1"],
        {
          "Doubao-Seed-Evolving": "Seed-Evolving",
          alwaysday1: "auto_model/alwaysday1",
        },
        false,
      ).slice(1),
    ).toEqual([
      {
        value: "Doubao-Seed-Evolving",
        label: "Seed-Evolving",
        description: undefined,
      },
      {
        value: "alwaysday1",
        label: "auto_model/alwaysday1",
        description: undefined,
      },
    ]);
  });
});
