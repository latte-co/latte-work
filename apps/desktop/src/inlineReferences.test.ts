import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import {
  classifyInlineCode,
  classifyLinkHref,
  codeText,
} from "./inlineReferences";

describe("classifyInlineCode", () => {
  it("detects project paths including line hints and directories", () => {
    for (const [raw, path, line] of [
      [
        "apps/desktop/src/MessageContent.tsx",
        "apps/desktop/src/MessageContent.tsx",
        undefined,
      ],
      [
        "apps/desktop/src/MessageContent.tsx:62",
        "apps/desktop/src/MessageContent.tsx",
        "62",
      ],
      [
        "apps/desktop/src/MessageContent.tsx:62-70",
        "apps/desktop/src/MessageContent.tsx",
        "62-70",
      ],
      [
        "docs/validation/codex-agent-2026-11-02.md",
        "docs/validation/codex-agent-2026-11-02.md",
        undefined,
      ],
      ["target/release/bundle/dmg/", "target/release/bundle/dmg/", undefined],
      ["package.json", "package.json", undefined],
      [".gitignore", ".gitignore", undefined],
      ["./scripts/package-dmg.sh", "./scripts/package-dmg.sh", undefined],
    ] as const) {
      expect(classifyInlineCode(raw)).toEqual({
        kind: "projectPath",
        path,
        line,
      });
    }
  });

  it("detects external absolute and home-relative paths", () => {
    for (const [raw, path, line] of [
      [
        "/Users/bytedance/Downloads/Latte-Work-0.1.0-arm64.dmg",
        "/Users/bytedance/Downloads/Latte-Work-0.1.0-arm64.dmg",
        undefined,
      ],
      [
        "~/Downloads/Latte-Work-0.1.0-arm64.dmg",
        "~/Downloads/Latte-Work-0.1.0-arm64.dmg",
        undefined,
      ],
      ["/tmp/latte/state/control.sock:5", "/tmp/latte/state/control.sock", "5"],
    ] as const) {
      expect(classifyInlineCode(raw)).toEqual({
        kind: "externalPath",
        path,
        line,
      });
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
      "../secrets.env",
      "src/../../etc/passwd",
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

describe("classifyLinkHref", () => {
  it("unwraps file URLs to external paths", () => {
    expect(classifyLinkHref("file:///Users/ka/report.md")).toEqual({
      kind: "externalPath",
      path: "/Users/ka/report.md",
    });
  });
  it("accepts fragment and suffix line hints", () => {
    expect(classifyLinkHref("src/app.ts#L12")).toEqual({
      kind: "projectPath",
      path: "src/app.ts",
      line: "12",
    });
    expect(classifyLinkHref("src/app.ts:12-20")).toEqual({
      kind: "projectPath",
      path: "src/app.ts",
      line: "12-20",
    });
  });
  it("keeps anchors, unknown schemes and escapes inert", () => {
    expect(classifyLinkHref("#section")).toEqual({ kind: "text" });
    expect(classifyLinkHref("mailto:a@b")).toEqual({ kind: "text" });
    expect(classifyLinkHref("ftp://host/x")).toEqual({ kind: "text" });
    expect(classifyLinkHref("../outside.ts")).toEqual({ kind: "text" });
  });
  it("still classifies plain web urls", () => {
    expect(classifyLinkHref("https://example.com/x")).toEqual({
      kind: "url",
      url: "https://example.com/x",
    });
  });
});
