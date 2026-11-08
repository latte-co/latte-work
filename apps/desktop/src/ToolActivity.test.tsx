// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRow } from "./ToolActivity";
import type { ToolActivity } from "./activity";
import type { ContentEncoding } from "./protocol";

const streamEventContent = vi.fn();
vi.mock("./eventContent", () => ({
  streamEventContent: (...args: unknown[]) => streamEventContent(...args),
  reassembleFullContent: (encoding: ContentEncoding, content: string) =>
    encoding === "text"
      ? content
      : JSON.stringify(JSON.parse(content), null, 2),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const previewed: ToolActivity = {
  key: 2,
  type: "tool",
  name: "Bash",
  input: { command: "python3 dump.py" },
  output: "预览头部…（内容过大，已截断）",
  load: { seq: 2, size: 679_286 },
  status: "completed",
};

describe("ToolRow load-full streaming", () => {
  it("offers the full payload for previewed results and streams chunks into the output", async () => {
    streamEventContent.mockImplementation(
      async (
        _target: unknown,
        onChunk: (p: {
          accumulated: string;
          received: number;
          total: number;
        }) => void,
      ) => {
        onChunk({
          accumulated: "前 512KiB",
          received: 524_288,
          total: 679_286,
        });
        onChunk({
          accumulated: "前 512KiB·尾部",
          received: 679_286,
          total: 679_286,
        });
        return { encoding: "text", content: "前 512KiB·尾部" };
      },
    );
    render(
      <ToolRow
        tool={previewed}
        loadContext={{ hostId: "h", sessionId: "s" }}
      />,
    );
    const button = screen.getByText(/加载完整内容/);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/100%/)).toBeTruthy());
    expect(streamEventContent).toHaveBeenCalledWith(
      { hostId: "h", sessionId: "s", seq: 2 },
      expect.any(Function),
    );
    expect(screen.getByText("前 512KiB·尾部")).toBeTruthy();
    expect(screen.queryByText(/加载完整内容/)).toBeNull();
  });

  it("keeps the preview and surfaces an error when streaming fails", async () => {
    streamEventContent.mockRejectedValue(new Error("事件内容游标无效"));
    render(
      <ToolRow
        tool={previewed}
        loadContext={{ hostId: "h", sessionId: "s" }}
      />,
    );
    fireEvent.click(screen.getByText(/加载完整内容/));
    await waitFor(() =>
      expect(screen.getByText(/加载失败：事件内容游标无效/)).toBeTruthy(),
    );
    expect(screen.getByText(/预览头部/)).toBeTruthy();
    expect(screen.getByText(/加载完整内容/)).toBeTruthy();
  });

  it("renders no affordance without load identity or context", () => {
    const { rerender } = render(<ToolRow tool={previewed} />);
    expect(screen.queryByText(/加载完整内容/)).toBeNull();
    rerender(
      <ToolRow
        tool={{ ...previewed, load: undefined }}
        loadContext={{ hostId: "h", sessionId: "s" }}
      />,
    );
    expect(screen.queryByText(/加载完整内容/)).toBeNull();
  });
});
