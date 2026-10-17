import type { SelectOption } from "./Select";

export function modelOptions(
  models: string[],
  labels?: Partial<Record<string, string>>,
  showAliases = true,
): SelectOption[] {
  return [
    { value: "", label: "default" },
    ...models.map((model) => ({
      value: model,
      label: labels?.[model] || model,
      description:
        showAliases && labels?.[model] && labels[model] !== model
          ? model.charAt(0).toUpperCase() + model.slice(1)
          : undefined,
    })),
  ];
}
