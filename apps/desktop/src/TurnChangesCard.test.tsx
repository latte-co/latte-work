// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventKind, TurnChanges } from "./protocol";
import { renderWithStatus as render } from "./test/renderWithStatus";
import { TurnChangesCard } from "./TurnChangesCard";
import { TurnTranscript, turnTranscript } from "./TurnTranscript";
import { openTurnChanges, readWorkspace } from "./workspaceState";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const changes: TurnChanges = {
  request_id: "r1",
  undo: "ready",
  interrupted: false,
  background_pending: false,
  summary: {
    entries: [{ path: "a.txt", status: "M", added: 2, removed: 1 }],
    added: 2,
    removed: 1,
    binary_files: 0,
    truncated: false,
    baseline_at: 1000,
    unavailable: null,
  },
};
const props = {
  changes,
  hostId: "local",
  sessionId: "s1",
  canUndo: true,
  open: vi.fn(),
};
it.each([
  { truncated: false, unavailable: null },
  { truncated: true, unavailable: null },
  { truncated: false, unavailable: "不是 Git 仓库" },
])(
  "does not split one process at an invisible empty snapshot (%j)",
  (patch) => {
    const snapshot: TurnChanges = {
      ...changes,
      background_pending: true,
      summary: { ...changes.summary, entries: [], ...patch },
    };
    const values: EventKind[] = [
      { kind: "user", text: "继续评审", request_id: "r1" },
      { kind: "text", text: "检查开始" },
      { kind: "tool", id: "first", name: "Read", input: {} },
      {
        kind: "tool_result",
        id: "first",
        content: "first output",
        is_error: false,
      },
      { kind: "text", text: "后台分支已启动" },
      { kind: "turn_changes", changes: snapshot },
      { kind: "state", status: "completed", message: null },
      { kind: "state", status: "running", message: null },
      { kind: "text", text: "分支返回，继续核对" },
      { kind: "tool", id: "second", name: "Read", input: {} },
      {
        kind: "tool_result",
        id: "second",
        content: "second output",
        is_error: false,
      },
      { kind: "text", text: "最终评审结论" },
      { kind: "turn_changes", changes: { ...snapshot, request_id: "late" } },
      { kind: "text", text: "交付补充说明" },
      { kind: "state", status: "completed", message: null },
    ];
    const rows = values.map((event, seq) => ({
      event,
      seq,
      at: seq,
      session_id: "s1",
    }));
    const body = (events: typeof rows) => (
      <TurnTranscript events={events}>
        {(item) =>
          item.type === "event" && item.value.kind === "turn_changes" ? (
            <TurnChangesCard {...props} changes={item.value.changes} />
          ) : (
            <p>
              {item.type === "assistant" || item.type === "user"
                ? item.text
                : "工具记录"}
            </p>
          )
        }
      </TurnTranscript>
    );
    const view = render(body(rows));
    const turn = turnTranscript(rows)[0];
    expect(turn.processCount).toBe(1);
    expect(turn.finalText).toBe("最终评审结论\n\n交付补充说明");
    expect(
      view.container.querySelectorAll("details.turn-process"),
    ).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "本轮文件变更" })).toBeNull();
    expect(screen.getByText("最终评审结论").closest("details")).toBeNull();
    expect(screen.getByText("交付补充说明").closest("details")).toBeNull();
    const process = view.container.querySelector<HTMLDetailsElement>(
      "details.turn-process",
    )!;
    process.open = true;
    fireEvent(process, new window.Event("toggle"));
    expect(screen.getByText("后台分支已启动").closest("details")).toBe(process);
    expect(screen.getByText("分支返回，继续核对").closest("details")).toBe(
      process,
    );
    view.rerender(body([...rows, { ...rows[5], seq: rows.length }]));
    expect(view.container.querySelector("details.turn-process")).toBe(process);
    expect(process.open).toBe(true);
  },
);
it("keeps a real file-change card between independent process sections", () => {
  const values: EventKind[] = [
    { kind: "user", text: "修改并检查", request_id: "r1" },
    { kind: "text", text: "修改说明" },
    { kind: "tool", id: "first", name: "Edit", input: {} },
    { kind: "tool_result", id: "first", content: "changed", is_error: false },
    { kind: "turn_changes", changes },
    { kind: "text", text: "继续检查" },
    { kind: "tool", id: "second", name: "Read", input: {} },
    { kind: "tool_result", id: "second", content: "checked", is_error: false },
    { kind: "text", text: "最终答复" },
    { kind: "state", status: "completed", message: null },
  ];
  const rows = values.map((event, seq) => ({
    event,
    seq,
    at: seq,
    session_id: "s1",
  }));
  const view = render(
    <TurnTranscript events={rows}>
      {(item) =>
        item.type === "event" && item.value.kind === "turn_changes" ? (
          <TurnChangesCard {...props} changes={item.value.changes} />
        ) : (
          <p>
            {item.type === "assistant" || item.type === "user"
              ? item.text
              : "工具记录"}
          </p>
        )
      }
    </TurnTranscript>,
  );
  const sections = view.container.querySelectorAll("details.turn-process");
  expect(sections).toHaveLength(2);
  const card = screen.getByRole("region", { name: "本轮文件变更" });
  expect(card.closest("details")).toBeNull();
  expect(
    sections[0].compareDocumentPosition(card) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    card.compareDocumentPosition(sections[1]) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
const manyChanges: TurnChanges = {
  ...changes,
  summary: {
    ...changes.summary,
    entries: Array.from({ length: 10 }, (_, index) => ({
      path: `src/nested/file-${index + 1}.tsx`,
      status: "M",
      added: index + 1,
      removed: 1,
    })),
    added: 55,
    removed: 10,
  },
};
it("previews three files and expands all remaining files in place without requests", () => {
  render(<TurnChangesCard {...props} changes={manyChanges} />);
  expect(screen.getByText("已编辑 10 个文件")).toBeTruthy();
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(3);
  const more = screen.getByRole("button", { name: "再显示 7 个文件" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  more.focus();
  fireEvent.click(more);
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(10);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(more);
  expect(
    document.getElementById(more.getAttribute("aria-controls")!),
  ).toBeTruthy();
  expect(props.open).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /file-10.tsx/ }));
  expect(props.open).toHaveBeenCalledExactlyOnceWith("src/nested/file-10.tsx");
  fireEvent.click(screen.getByRole("button", { name: "收起文件列表" }));
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "再显示 7 个文件" })).toBe(more);
});
it("retains expansion on snapshot refresh but does not apply it to a different host, session or turn", () => {
  const view = render(<TurnChangesCard {...props} changes={manyChanges} />);
  fireEvent.click(screen.getByRole("button", { name: "再显示 7 个文件" }));
  view.rerender(
    <TurnChangesCard
      {...props}
      changes={{ ...manyChanges, undo: "reverted" }}
    />,
  );
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(10);
  for (const patch of [
    { hostId: "remote" },
    { sessionId: "another" },
    { changes: { ...manyChanges, request_id: "another" } },
    {
      changes: {
        ...manyChanges,
        summary: { ...manyChanges.summary, baseline_at: 2000 },
      },
    },
  ]) {
    view.rerender(
      <TurnChangesCard {...props} changes={manyChanges} {...patch} />,
    );
    expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(3);
    expect(
      screen
        .getByRole("button", { name: "再显示 7 个文件" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  }
});
it.each([
  { interrupted: true },
  { background_pending: true },
  { summary: { ...manyChanges.summary, truncated: true } },
  { summary: { ...manyChanges.summary, unavailable: "读取失败" } },
])("omits the footer while preserving unavailable undo (%j)", (patch) => {
  render(
    <TurnChangesCard
      {...props}
      canUndo={false}
      changes={{
        ...manyChanges,
        ...patch,
      }}
    />,
  );
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(3);
  expect(document.querySelector(".turn-changes-note")).toBeNull();
  expect(screen.queryByText(/部分文件超出采集范围|本轮中断/)).toBeNull();
  if (patch.summary?.unavailable) return;
  expect(
    (screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it.each([1, 3])("does not show a disclosure for %i files", (count) => {
  render(
    <TurnChangesCard
      {...props}
      changes={{
        ...manyChanges,
        summary: {
          ...manyChanges.summary,
          entries: manyChanges.summary.entries.slice(0, count),
        },
      }}
    />,
  );
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(count);
  expect(
    screen.queryByRole("button", { name: /再显示|收起文件列表/ }),
  ).toBeNull();
});
it("shows per-turn counts and opens exact-file diffs without launching an agent", () => {
  render(<TurnChangesCard {...props} />);
  expect(screen.getByText("已编辑 1 个文件")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /a.txt/ }));
  expect(props.open).toHaveBeenCalledWith("a.txt");
  fireEvent.click(screen.getByRole("button", { name: "查看变更" }));
  expect(props.open).toHaveBeenLastCalledWith();
  expect(mocks.request).not.toHaveBeenCalled();
  openTurnChanges("turn-tabs", "s1", "r1", 1000, "a.txt");
  openTurnChanges("turn-tabs", "s1", "r2", 2000);
  openTurnChanges("turn-tabs", "s1", "r1", 1000);
  expect(readWorkspace("turn-tabs").tabs).toHaveLength(1);
  expect(readWorkspace("turn-tabs").current).toBe("diff");
});
it("sends undo once, records its result, and never retries a conflict", async () => {
  let finish!: (value: unknown) => void;
  mocks.request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<TurnChangesCard {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(
    (screen.getByRole("button", { name: "撤销中…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("local", {
    method: "undo_turn_changes",
    session_id: "s1",
    request_id: "r1",
  });
  finish({ kind: "turn_changes", changes: { ...changes, undo: "reverted" } });
  await screen.findByRole("button", { name: "已撤销" });
  cleanup();
  mocks.request.mockRejectedValue(new Error("文件在本轮结束后已改变，未撤销"));
  render(<TurnChangesCard {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  fireEvent.click(await screen.findByRole("button", { name: /^状态提示（/ }));
  expect(
    screen.getByRole("dialog", { name: "状态提示" }).textContent,
  ).toContain("文件在本轮结束后已改变，未撤销");
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
});
it("blocks undo for old, incomplete, background or unconfirmed turns", () => {
  for (const patch of [
    { canUndo: false },
    { changes: { ...changes, background_pending: true } },
    { changes: { ...changes, undo: "unknown" as const } },
    {
      changes: { ...changes, summary: { ...changes.summary, truncated: true } },
    },
  ]) {
    render(<TurnChangesCard {...props} {...patch} />);
    expect(
      (
        screen.getByRole("button", {
          name: /撤销|状态待核对/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();
  }
});
it("keeps the changes card outside folded execution and replaces undo updates in place", () => {
  const turns = turnTranscript([
    {
      session_id: "s1",
      seq: 1,
      at: 1,
      event: { kind: "user", text: "edit", request_id: "r1" },
    },
    { session_id: "s1", seq: 2, at: 2, event: { kind: "text", text: "done" } },
    {
      session_id: "s1",
      seq: 3,
      at: 3,
      event: { kind: "turn_changes", changes },
    },
    {
      session_id: "s1",
      seq: 4,
      at: 4,
      event: { kind: "state", status: "completed", message: null },
    },
    {
      session_id: "s1",
      seq: 5,
      at: 5,
      event: {
        kind: "turn_changes",
        changes: { ...changes, undo: "reverted" },
      },
    },
  ]);
  const cards = turns[0].visible.filter(
    (item) => item.type === "event" && item.value.kind === "turn_changes",
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    key: 3,
    value: { changes: { undo: "reverted" } },
  });
});

it.each([
  { truncated: false, unavailable: null },
  { truncated: true, unavailable: null },
  { truncated: false, unavailable: "无法读取 Git 状态，请确认项目是 Git 仓库" },
])(
  "hides empty snapshots regardless of collection limits or Git availability (%j)",
  (patch) => {
    render(
      <TurnChangesCard
        {...props}
        changes={{
          ...changes,
          background_pending: true,
          summary: {
            ...changes.summary,
            entries: [],
            added: 0,
            removed: 0,
            ...patch,
          },
        }}
      />,
    );
    expect(screen.queryByRole("region", { name: "本轮文件变更" })).toBeNull();
    expect(screen.queryByText(/已编辑|本轮变更未能记录/)).toBeNull();
  },
);

it("pages a twenty-thousand-file turn without mounting its complete list", async () => {
  const entry = (n: number) => ({
    path: `src/file-${n}.tsx`,
    status: "A",
    added: 1,
    removed: 0,
  });
  const first = {
    ...changes,
    summary: {
      ...changes.summary,
      entries: Array.from({ length: 64 }, (_, n) => entry(n)),
      total_files: 20000,
      offset: 0,
      next_offset: 64,
    },
  };
  mocks.request.mockResolvedValue({
    kind: "turn_changes",
    changes: {
      ...first,
      summary: {
        ...first.summary,
        entries: Array.from({ length: 64 }, (_, n) => entry(n + 64)),
        offset: 64,
        next_offset: 128,
      },
    },
  });
  render(<TurnChangesCard {...props} changes={first} />);
  expect(screen.getByText("已编辑 20000 个文件")).toBeTruthy();
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(3);
  fireEvent.click(
    screen.getByRole("button", { name: "展开文件列表（共 20000 个）" }),
  );
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(64);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: /file-127.tsx/ });
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(64);
  expect(screen.queryByRole("button", { name: /file-0.tsx/ })).toBeNull();
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("local", {
    method: "turn_change_summary",
    session_id: "s1",
    request_id: "r1",
    offset: 64,
  });
  fireEvent.click(screen.getByRole("button", { name: /file-127.tsx/ }));
  expect(props.open).toHaveBeenLastCalledWith("src/file-127.tsx");
  mocks.request.mockResolvedValue({ kind: "turn_changes", changes: first });
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByRole("button", { name: /file-0.tsx/ });
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(64);
  fireEvent.click(screen.getByRole("button", { name: "收起文件列表" }));
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(3);
});
it("bounds legacy list DOM locally and ignores a late page from another session", async () => {
  const entries = Array.from({ length: 10000 }, (_, n) => ({
    path: `legacy-${n}.txt`,
    status: "M",
    added: 1,
    removed: 0,
  }));
  const local = { ...changes, summary: { ...changes.summary, entries } };
  const view = render(<TurnChangesCard {...props} changes={local} />);
  fireEvent.click(
    screen.getByRole("button", { name: "展开文件列表（共 10000 个）" }),
  );
  expect(document.querySelectorAll(".turn-changes-file")).toHaveLength(64);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("button", { name: /legacy-127.txt/ });
  expect(mocks.request).not.toHaveBeenCalled();
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const paged = {
    ...changes,
    summary: {
      ...changes.summary,
      entries: entries.slice(0, 64),
      total_files: 10000,
      offset: 0,
      next_offset: 64,
    },
  };
  view.rerender(
    <TurnChangesCard {...props} sessionId="another" changes={paged} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "展开文件列表（共 10000 个）" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  view.rerender(
    <TurnChangesCard {...props} sessionId="third" changes={changes} />,
  );
  await waitFor(() => expect(screen.getByText("已编辑 1 个文件")).toBeTruthy());
  finish({
    kind: "turn_changes",
    changes: {
      ...paged,
      summary: {
        ...paged.summary,
        entries: [
          { path: "STALE_PAGE.txt", status: "A", added: 1, removed: 0 },
        ],
      },
    },
  });
  await waitFor(() => expect(screen.queryByText("STALE_PAGE.txt")).toBeNull());
});
