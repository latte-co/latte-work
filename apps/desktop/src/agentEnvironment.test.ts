import { expect, it } from "vitest";
import { formatEnvironment, parseEnvironment } from "./agentEnvironment";

it("preserves literal values, empty overrides, equals and CRLF without evaluating shell text", () => {
  expect(
    parseEnvironment(
      'HTTPS_PROXY=http://proxy:7890\r\nEMPTY=\r\nLITERAL= $(command)="quoted" \r\n',
    ),
  ).toEqual({
    HTTPS_PROXY: "http://proxy:7890",
    EMPTY: "",
    LITERAL: ' $(command)="quoted" ',
  });
  expect(formatEnvironment({ Z: "last", A: "first" })).toBe("A=first\nZ=last");
  expect(parseEnvironment("__proto__=literal")["__proto__"]).toBe("literal");
});

it.each([
  "export HTTP_PROXY=x",
  "1BAD=x",
  "A=x\nA=y",
  "HOME=/other",
  "LATTE_WORK_CODEX=other",
  "TOKEN=secret\0value",
  `VALUE=${"x".repeat(8193)}`,
  Array.from({ length: 65 }, (_, i) => `V_${i}=x`).join("\n"),
  Array.from({ length: 5 }, (_, i) => `V_${i}=${"x".repeat(8192)}`).join("\n"),
])("rejects invalid environment without echoing values", (input) => {
  expect(() => parseEnvironment(input)).toThrow();
  try {
    parseEnvironment(input);
  } catch (error) {
    expect(String(error)).not.toContain(input);
  }
});
