import { expect, it } from "vitest";
import { commandTitle } from "./composerActions";
const command = {
  name: "lark-calendar",
  description: "飞书日历：管理日历与会议",
  argument_hint: "",
};
it("prefers agent display metadata, then short skill titles and readable fallback names", () => {
  expect(commandTitle({ ...command, display_name: "日程助手" }, "claude")).toBe(
    "日程助手",
  );
  expect(commandTitle(command, "claude")).toBe("飞书日历");
  expect(commandTitle({ ...command, name: "compact" }, "claude")).toBe(
    "压缩上下文",
  );
  expect(
    commandTitle(
      {
        ...command,
        name: "compact",
        description: "Other agent's own description",
      },
      "another",
    ),
  ).toBe("Compact");
  expect(
    commandTitle(
      { ...command, description: "A long description without a short title" },
      "claude",
    ),
  ).toBe("Lark Calendar");
});
