// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import exampleTheme from "../../../docs/themes/latte-default.json";
import { AppearanceProvider } from "./AppearanceProvider";
import { AppearanceSettings } from "./AppearanceSettings";
import {
  APPEARANCE_KEY,
  applyAppearance,
  contrastRatio,
  defaultAppearance,
  parseAppearance,
  readAppearance,
  resolveTheme,
  saveAppearance,
  themeTokens,
} from "./appearance";
let media: {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  localStorage.clear();
  media = {
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => media);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
  delete (document as Partial<Document>).execCommand;
  Reflect.deleteProperty(navigator, "clipboard");
});
it("round-trips both palettes and font preferences through durable storage", () => {
  const settings = defaultAppearance();
  settings.mode = "light";
  settings.dark.uiFont = "serif";
  settings.light.contrast = 80;
  expect(saveAppearance(settings)).toBe("");
  expect(readAppearance().settings).toEqual(settings);
  expect(parseAppearance(JSON.stringify(settings))).toEqual(settings);
});
it("falls back on corrupt or future storage without overwriting the original", () => {
  localStorage.setItem(APPEARANCE_KEY, '{"version":2}');
  expect(readAppearance().error).not.toBe("");
  expect(readAppearance().settings).toEqual(defaultAppearance());
  expect(localStorage.getItem(APPEARANCE_KEY)).toBe('{"version":2}');
});
it("reports storage failure while leaving the requested appearance usable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(saveAppearance(defaultAppearance())).toContain("无法保存");
});
it.each([
  ["background", "url(https://example.com)"],
  ["accent", "#123"],
  ["contrast", 101],
  ["contrast", null],
  ["uiFont", "__proto__"],
  ["uiFont", ["system"]],
  ["codeWeight", "900"],
  ["translucentSidebar", "false"],
])("rejects malformed imported %s atomically", (key, value) => {
  const settings = defaultAppearance();
  const input = { ...settings, dark: { ...settings.dark, [key]: value } };
  expect(() => parseAppearance(JSON.stringify(input))).toThrow();
  expect(readAppearance().settings).toEqual(settings);
});
it("bounds imports and strips unexpected fields", () => {
  expect(() => parseAppearance(" ".repeat(32769))).toThrow("32 KB");
  const settings = defaultAppearance();
  const parsed = parseAppearance(
    JSON.stringify({
      ...settings,
      dark: { ...settings.dark, css: "injected" },
    }),
  );
  expect(parsed).toEqual(settings);
});
it("resolves system and explicit modes independently and derives valid colors", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
  for (const kind of ["light", "dark"] as const) {
    const theme = defaultAppearance()[kind];
    const tokens = themeTokens(theme);
    expect(contrastRatio(theme.background, theme.foreground)).toBeGreaterThan(
      10,
    );
    expect(
      contrastRatio(tokens["--color-primary"], tokens["--color-on-primary"]),
    ).toBeGreaterThan(4.5);
    for (const [key, value] of Object.entries(tokens))
      if (key.startsWith("--color"))
        expect(value).toMatch(/^#[\da-f]{6}([\da-f]{2})?$/i);
  }
});
it("updates live on system changes and removes its subscription on unmount", () => {
  const view = render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  expect(document.documentElement.dataset.theme).toBe("dark");
  const listener = media.addEventListener.mock.calls[0][1];
  act(() => {
    media.matches = false;
    listener();
  });
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "深色" }));
  act(() => {
    media.matches = false;
    listener();
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  view.unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
});
it("edits, persists, restores and resets only the selected palette", () => {
  const view = render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "强调色" }), {
    target: { value: "#FF0000" },
  });
  expect(
    document.documentElement.style.getPropertyValue("--color-primary"),
  ).toBe("#FF0000");
  fireEvent.click(screen.getByRole("switch", { name: "半透明侧边栏" }));
  expect(
    document.documentElement.style.getPropertyValue("--color-sidebar"),
  ).toMatch(/c7$/);
  view.unmount();
  render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "强调色",
      }) as HTMLInputElement
    ).value,
  ).toBe("#FF0000");
  fireEvent.click(screen.getByRole("button", { name: "浅色主题" }));
  fireEvent.change(screen.getByRole("textbox", { name: "强调色" }), {
    target: { value: "#336699" },
  });
  fireEvent.click(screen.getByRole("button", { name: "恢复此主题默认值" }));
  expect(readAppearance().settings.dark.accent).toBe("#FF0000");
  expect(readAppearance().settings.light).toEqual(defaultAppearance().light);
});
it("shows invalid color and import feedback without applying invalid values", async () => {
  render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "背景" }), {
    target: { value: "#xx" },
  });
  expect(screen.getByText("请输入 #RRGGBB")).toBeTruthy();
  expect(
    document.documentElement.style.getPropertyValue("--color-canvas"),
  ).toBe(defaultAppearance().dark.background);
  fireEvent.click(screen.getByRole("button", { name: "导入" }));
  const input = screen.getByLabelText("导入主题 JSON 文件");
  await act(async () =>
    fireEvent.change(input, {
      target: { files: [{ size: 2, text: async () => "{}" }] },
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("不支持");
  expect(localStorage.getItem(APPEARANCE_KEY)).toBeNull();
  const imported = defaultAppearance();
  imported.mode = "light";
  await act(async () =>
    fireEvent.change(input, {
      target: {
        files: [{ size: 1000, text: async () => JSON.stringify(imported) }],
      },
    }),
  );
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(readAppearance().settings).toEqual(imported);
});
it("uses user fonts across UI, content and code", () => {
  const settings = defaultAppearance();
  settings.dark.uiFont = "serif";
  settings.dark.contentFont = "inherit";
  settings.dark.codeFont = "menlo";
  applyAppearance(settings, true);
  const css = document.documentElement.style;
  expect(css.getPropertyValue("--font-ui")).toContain("Georgia");
  expect(css.getPropertyValue("--font-content")).toBe(
    css.getPropertyValue("--font-ui"),
  );
  expect(css.getPropertyValue("--font-code")).toContain("Menlo");
});

it("keeps default text and actions readable across every surface in both modes", () => {
  for (const kind of ["light", "dark"] as const) {
    const tokens = themeTokens(defaultAppearance()[kind]);
    for (const surface of [
      "canvas",
      "sidebar",
      "surface",
      "elevated",
      "input",
      "composer",
    ]) {
      const background = tokens[`--color-${surface}`];
      // Default surfaces are neutral; custom palettes remain user controlled.
      expect(background.slice(1, 3)).toBe(background.slice(3, 5));
      expect(background.slice(3, 5)).toBe(background.slice(5, 7));
      for (const text of [
        "text",
        "text-secondary",
        "text-muted",
        "placeholder",
      ]) {
        expect(
          contrastRatio(tokens[`--color-${text}`], background),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const background of ["primary", "primary-hover"]) {
      expect(
        contrastRatio(
          tokens[`--color-${background}`],
          tokens["--color-on-primary"],
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

it("opens one file picker and applies the documented JSON without a second import panel", async () => {
  const view = render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  const file = screen.getByLabelText("导入主题 JSON 文件") as HTMLInputElement;
  const open = vi.spyOn(file, "click").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "导入" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.queryByText("导入并应用")).toBeNull();
  expect(screen.queryByText("选择 JSON 文件")).toBeNull();
  expect(view.container.querySelector("textarea")).toBeNull();
  expect(file.hidden).toBe(true);
  expect(parseAppearance(JSON.stringify(exampleTheme))).toEqual(
    defaultAppearance(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "强调色" }), {
    target: { value: "#123456" },
  });
  await act(async () =>
    fireEvent.change(file, {
      target: {
        files: [{ size: 1000, text: async () => JSON.stringify(exampleTheme) }],
      },
    }),
  );
  expect(readAppearance().settings).toEqual(defaultAppearance());
  expect(file.value).toBe("");
  // Selecting the same file again remains possible after its input value is reset.
  await act(async () =>
    fireEvent.change(file, {
      target: {
        files: [{ size: 1000, text: async () => JSON.stringify(exampleTheme) }],
      },
    }),
  );
  expect(readAppearance().settings).toEqual(defaultAppearance());
});

it("keeps the current theme on cancellation, oversized files and read failure", async () => {
  const original = defaultAppearance();
  original.dark.accent = "#123456";
  saveAppearance(original);
  render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  const input = screen.getByLabelText("导入主题 JSON 文件");
  const read = vi.fn();
  await act(async () => fireEvent.change(input, { target: { files: [] } }));
  expect(readAppearance().settings).toEqual(original);
  await act(async () =>
    fireEvent.change(input, {
      target: { files: [{ size: 32769, text: read }] },
    }),
  );
  expect(read).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("32 KB");
  await act(async () =>
    fireEvent.change(input, {
      target: {
        files: [
          {
            size: 20,
            text: async () => {
              throw new Error("unreadable");
            },
          },
        ],
      },
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("无法读取");
  expect(readAppearance().settings).toEqual(original);
});

it("copies a complete importable theme in WebKit and restores focus without exposing another editor", async () => {
  render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  let copied = "";
  const copy = vi.fn(() => {
    copied = (document.activeElement as HTMLTextAreaElement).value;
    return true;
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: copy,
  });
  const button = screen.getByRole("button", { name: "复制主题" });
  button.focus();
  await act(async () => fireEvent.click(button));
  expect(copy).toHaveBeenCalledWith("copy");
  expect(parseAppearance(copied)).toEqual(defaultAppearance());
  expect(document.activeElement).toBe(button);
  expect(document.querySelector("textarea")).toBeNull();
  expect(screen.getByText(/已复制完整主题 JSON/)).toBeTruthy();
});

it("uses the modern clipboard fallback and reports failure without claiming a successful copy", async () => {
  render(
    <AppearanceProvider>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "复制主题" })),
  );
  expect(parseAppearance(write.mock.calls[0][0])).toEqual(defaultAppearance());
  write.mockRejectedValue(new Error("denied"));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "复制主题" })),
  );
  expect(screen.getByRole("alert").textContent).toContain("无法写入剪贴板");
  expect(screen.queryByText(/已复制完整主题 JSON/)).toBeNull();
  expect(document.querySelector("textarea")).toBeNull();
});
