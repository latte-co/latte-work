import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { StatusCenter } from "../StatusCenter";

export function renderWithStatus(ui: ReactElement) {
  const wrap = (content: ReactElement) => (
    <>
      <StatusCenter />
      {content}
    </>
  );
  const result = render(wrap(ui));
  return {
    ...result,
    rerender: (next: ReactElement) => result.rerender(wrap(next)),
  };
}
