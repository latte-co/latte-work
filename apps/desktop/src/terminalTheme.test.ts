// @vitest-environment jsdom
import { expect, it } from "vitest";
import { contrastRatio, defaultAppearance, themeTokens } from "./appearance";
import { terminalTheme } from "./terminalTheme";
it.each(["light", "dark"] as const)(
  "keeps ANSI normal and bright colors readable on %s backgrounds",
  (mode) => {
    const theme = defaultAppearance()[mode];
    const element = document.createElement("div");
    Object.entries(themeTokens(theme)).forEach(([key, value]) =>
      element.style.setProperty(key, value),
    );
    const palette = terminalTheme(element.style);
    const colors = Object.entries(palette).filter(
      ([key]) =>
        !["background", "foreground", "cursor", "selectionBackground"].includes(
          key,
        ),
    );
    expect(colors).toHaveLength(16);
    for (const [, color] of colors)
      expect(
        contrastRatio(color as string, theme.background),
      ).toBeGreaterThanOrEqual(4.5);
    const tokens = themeTokens(theme);
    expect(tokens["--color-hover"]).not.toBe(tokens["--color-selected"]);
    expect(
      contrastRatio(tokens["--color-placeholder"], tokens["--color-composer"]),
    ).toBeGreaterThanOrEqual(4.5);
  },
);
