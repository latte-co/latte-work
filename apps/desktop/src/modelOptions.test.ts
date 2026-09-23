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
});
