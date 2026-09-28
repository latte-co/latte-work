import type { ITheme } from "@xterm/xterm";
import { contrastRatio } from "./appearance";
export function terminalTheme(styles: CSSStyleDeclaration): ITheme {
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const background = token("--color-canvas");
  const dark =
    contrastRatio(background || "#111111", "#ffffff") >
    contrastRatio(background || "#111111", "#111111");
  const colors = dark
    ? [
        "#8c919b",
        "#ed9595",
        "#87c99a",
        "#dfbc79",
        "#91b3ed",
        "#c5a2e3",
        "#7cc8cb",
        "#d5d8dd",
        "#a4a9b1",
        "#ffb0ad",
        "#a4dfb3",
        "#f0d096",
        "#accbff",
        "#dcbcff",
        "#9ee0e1",
        "#f1f2f4",
      ]
    : [
        "#373d48",
        "#a83236",
        "#21683c",
        "#795900",
        "#285caf",
        "#75429d",
        "#176776",
        "#5d6370",
        "#535b69",
        "#b23740",
        "#28713f",
        "#826000",
        "#345fba",
        "#8550a3",
        "#1c7180",
        "#686e78",
      ];
  const names = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ];
  return {
    ...Object.fromEntries(names.map((name, i) => [name, colors[i]])),
    background,
    foreground: token("--color-text"),
    cursor: token("--color-text"),
    selectionBackground: token("--color-selection"),
  };
}
