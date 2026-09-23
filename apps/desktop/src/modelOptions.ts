import type { SelectOption } from "./Select";

export function modelOptions(
  models: string[],
  labels?: Partial<Record<string, string>>,
): SelectOption[] {
  return [
    { value: "", label: "default" },
    ...models.map((model) => ({
      value: model,
      label: labels?.[model] || model,
      description:
        labels?.[model] && labels[model] !== model
          ? model.charAt(0).toUpperCase() + model.slice(1)
          : undefined,
    })),
  ];
}
