// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourcePreview } from "./SourcePreview";
const mocks = vi.hoisted(() => ({ request: vi.fn(), invoke: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const source = {
  path: "/external/image.png",
  name: "image.png",
  directory: false,
};
const props = {
  hostId: "ssh",
  projectId: "p",
  sessionId: "s",
  source,
  active: true,
  open: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:fixture");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
it("previews explicitly added external images and sends a bounded local copy to system preview", async () => {
  mocks.request.mockResolvedValue({
    kind: "source_preview",
    data: [137, 80, 78, 71],
    next: 4,
    size: 4,
    has_more: false,
    mime_type: "image/png",
  });
  const view = render(<SourcePreview {...props} />);
  expect(
    (await screen.findByRole("img", { name: "image.png" })).getAttribute("src"),
  ).toBe("blob:fixture");
  fireEvent.click(screen.getByRole("button", { name: "系统预览" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("system_preview", {
      name: "image.png",
      data: [137, 80, 78, 71],
    }),
  );
  expect(mocks.request.mock.calls[0][1]).toMatchObject({
    method: "preview_source",
    path: source.path,
    session_id: "s",
  });
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
});
it("shows only actual connector metadata and never executes a tool", () => {
  render(
    <SourcePreview
      {...props}
      source={{
        ...source,
        name: "Fixture docs",
        path: "connector:fixture",
        sourceKind: "connector",
        tools: ["mcp__fixture__read"],
        uses: 2,
      }}
    />,
  );
  expect(screen.getByText("mcp__fixture__read")).toBeTruthy();
  expect(screen.getByText(/已调用 2 次/)).toBeTruthy();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it("keeps HTML as text and fences stale responses after changing hosts", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({
      kind: "source_preview",
      data: Array.from(new TextEncoder().encode("<script>test</script>")),
      next: 21,
      size: 21,
      has_more: false,
      mime_type: "text/plain",
    });
  const view = render(<SourcePreview {...props} />);
  view.rerender(<SourcePreview {...props} hostId="local" />);
  await screen.findByText("<script>test</script>");
  resolve({
    kind: "source_preview",
    data: [1],
    next: 1,
    size: 1,
    has_more: false,
    mime_type: "image/png",
  });
  await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("renders a native PDF first-page image and keeps full preview available after a renderer failure", async () => {
  mocks.request.mockResolvedValue({
    kind: "source_preview",
    data: [37, 80, 68, 70, 45],
    next: 5,
    size: 5,
    has_more: false,
    mime_type: "application/pdf",
  });
  mocks.invoke.mockResolvedValueOnce([137, 80, 78, 71]);
  const pdf = { ...source, name: "preview.pdf" };
  const view = render(<SourcePreview {...props} source={pdf} />);
  await screen.findByRole("img", { name: "preview.pdf 首页" });
  expect(mocks.invoke).toHaveBeenCalledWith("preview_pdf", {
    name: "preview.pdf",
    data: [37, 80, 68, 70, 45],
  });
  view.unmount();
  mocks.invoke.mockRejectedValueOnce(new Error("无法生成 PDF 预览"));
  render(<SourcePreview {...props} source={pdf} />);
  await screen.findByText(/无法生成 PDF 预览/);
  expect(screen.getByRole("button", { name: "系统预览" })).toBeTruthy();
});
