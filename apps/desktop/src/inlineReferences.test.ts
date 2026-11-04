import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { classifyInlineCode, codeText } from "./inlineReferences";

describe("classifyInlineCode", () => {
  it("detects project paths including line hints and directories", () => {
    for (const [raw, path] of [
      [
        "apps/desktop/src/MessageContent.tsx",
        "apps/desktop/src/MessageContent.tsx",
      ],
      [
        "apps/desktop/src/MessageContent.tsx:62",
        "apps/desktop/src/MessageContent.tsx",
      ],
      [
        "apps/desktop/src/MessageContent.tsx:62-70",
        "apps/desktop/src/MessageContent.tsx",
      ],
      [
        "docs/validation/codex-agent-2026-11-02.md",
        "docs/validation/codex-agent-2026-11-02.md",
      ],
      ["target/release/bundle/dmg/", "target/release/bundle/dmg/"],
      ["package.json", "package.json"],
      [".gitignore", ".gitignore"],
      ["./scripts/package-dmg.sh", "./scripts/package-dmg.sh"],
    ] as const) {
      expect(classifyInlineCode(raw)).toEqual({ kind: "projectPath", path });
    }
  });

  it("detects external absolute and home-relative paths", () => {
    for (const [raw, path] of [
      [
        "/Users/bytedance/Downloads/Latte-Work-0.1.0-arm64.dmg",
        "/Users/bytedance/Downloads/Latte-Work-0.1.0-arm64.dmg",
      ],
      [
        "~/Downloads/Latte-Work-0.1.0-arm64.dmg",
        "~/Downloads/Latte-Work-0.1.0-arm64.dmg",
      ],
      ["/tmp/latte/state/control.sock:5", "/tmp/latte/state/control.sock"],
    ] as const) {
      expect(classifyInlineCode(raw)).toEqual({ kind: "externalPath", path });
    }
  });

  it("detects bare http(s) urls", () => {
    expect(
      classifyInlineCode("https://github.com/latte-co/latte-work/pull/19"),
    ).toEqual({
      kind: "url",
      url: "https://github.com/latte-co/latte-work/pull/19",
    });
    expect(classifyInlineCode("http://localhost:8000/v1")).toEqual({
      kind: "url",
      url: "http://localhost:8000/v1",
    });
  });

  it("keeps ordinary code, branch names, hashes and commands as text", () => {
    for (const raw of [
      "npm run build",
      "codex/codex-integration",
      "fe3b7db",
      "ff9b6e500b32c8291",
      "make clean",
      "Makefile",
      "latte-work-server",
      "...",
      "a.b/c",
      "C:/Users/bytedance",
      'format!("{}")',
      "model_providers.{id}={{{}}}",
      "ftp://example.com/file",
      "",
    ]) {
      expect(classifyInlineCode(raw)).toEqual({ kind: "text" });
    }
  });

  it("bounds reference detection to single short spans", () => {
    expect(classifyInlineCode(`a/${"b".repeat(600)}`)).toEqual({
      kind: "text",
    });
    expect(classifyInlineCode("  src/tokens.css  ")).toEqual({
      kind: "projectPath",
      path: "src/tokens.css",
    });
    expect(classifyInlineCode("multi\nline/path.ts")).toEqual({ kind: "text" });
  });
});

describe("codeText", () => {
  it("flattens strings, numbers and element children", () => {
    expect(codeText("plain")).toBe("plain");
    expect(codeText(["a", 1, "b"])).toBe("a1b");
    expect(
      codeText({
        props: { children: ["x", { props: { children: "y" } }] },
      } as unknown as ReactElement),
    ).toBe("xy");
    expect(codeText(null)).toBe("");
    expect(codeText(undefined)).toBe("");
    expect(codeText(true)).toBe("");
  });
});
