// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorkingStatus } from "./WorkingStatus";
afterEach(cleanup);
it("keeps accessible text stable without duplicate dots or a spinner", () => {
  const view = render(<WorkingStatus label="正在思考…" animated />);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("正在思考");
  expect(status.querySelectorAll(".working-dots i")).toHaveLength(3);
  expect(status.querySelector("svg, .spin")).toBeNull();
  expect(status.getAttribute("data-animated")).toBe("true");
  view.rerender(<WorkingStatus label="等待你的确认" animated={false} />);
  expect(status.getAttribute("data-animated")).toBe("false");
});
