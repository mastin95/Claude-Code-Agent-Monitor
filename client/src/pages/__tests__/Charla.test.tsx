/**
 * @file Charla.test.tsx
 * @description Tests transcript mapping, live cursor paging, filters, loading and recovery in Charla.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const nodeProcess = (
  globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
).process;
if (nodeProcess) nodeProcess.env.TZ = "UTC";
import { act, render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Charla } from "../Charla";
import { transcriptBlocks } from "../../components/muro/charla-model";
import { api } from "../../lib/api";
import { eventBus } from "../../lib/eventBus";
import { setScope } from "../../lib/dataScope";
import type { Session, TranscriptMessage } from "../../lib/types";
import i18n from "../../i18n";
vi.mock("../../lib/api", () => ({ api: { sessions: { list: vi.fn(), transcript: vi.fn() } } }));
const parent: Session = {
  id: "parent",
  provider: "claude",
  name: "Parent task",
  status: "active",
  model: "opus",
  cwd: null,
  started_at: "2026-10-15T10:00:00Z",
  ended_at: null,
  metadata: null,
  total_tokens: 1234,
};
const child: Session = {
  ...parent,
  id: "child",
  provider: "codex",
  name: "Child task",
  metadata: JSON.stringify({
    handoff: {
      from: "claude",
      parent_session_id: "parent",
      rounds: [
        {
          ask: "Build it",
          ask_at: "2026-10-15T10:00:00Z",
          reply: "Done",
          reply_at: "2026-10-15T10:01:00Z",
        },
      ],
    },
  }),
};
const messages: TranscriptMessage[] = [
  {
    type: "assistant",
    timestamp: null,
    content: [
      { type: "thinking", text: "A summary" },
      { type: "tool_use", name: "Bash", id: "call", input: { command: "npm test" } },
      {
        type: "tool_use",
        name: "Edit",
        input: { file_path: "a.ts", old_string: "old", new_string: "new" },
      },
      { type: "tool_use", name: "Read", input: { file_path: "b.ts" } },
    ],
  },
  {
    type: "user",
    sender: "tool",
    timestamp: null,
    content: [{ type: "tool_result", id: "call", output: "failed", is_error: true }],
  },
  { type: "user", timestamp: null, content: [{ type: "text", text: "Hello" }] },
  { type: "assistant", timestamp: null, content: [{ type: "text", text: "Reply" }] },
];
const page = (items = messages, line = 7, more = false) => ({
  messages: items,
  last_line: line,
  first_line: 1,
  total: items.length,
  has_more: more,
});
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  setScope({ mode: "all", selected: [], provider: "both" });
  vi.mocked(api.sessions.list).mockResolvedValue({
    sessions: [parent, child],
    total: 2,
    limit: 1000,
    offset: 0,
  });
  vi.mocked(api.sessions.transcript).mockResolvedValue(page());
});
afterEach(cleanup);
it("maps tool pairs without showing results as human messages", () => {
  const blocks = transcriptBlocks(messages);
  expect(blocks.map((b) => b.kind)).toEqual(["think", "cmd", "diff", "read", "user", "say"]);
  expect(blocks[1]).toMatchObject({ text: "npm test", output: "failed", error: true });
  expect(blocks[2]).toMatchObject({ text: "a.ts", output: "-old\n+new" });
  expect(
    transcriptBlocks([{ type: "assistant", timestamp: null, content: [{ type: "thinking" }] }])[0]!
      .text
  ).toBe("");
});
it("renders both columns and toggles actual reasoning, command and diff blocks", async () => {
  const { container } = render(<Charla />);
  await screen.findByText("Parent task · Child task");
  await waitFor(() => expect(container.querySelectorAll(".ch-cmd")).toHaveLength(2));
  expect(container.querySelectorAll(".ch-handoff")).toHaveLength(4);
  expect(container.querySelector(".claude .ch-say b")).toHaveTextContent("For you");
  expect(container.querySelector(".codex .ch-say b")).toHaveTextContent("For Claude");
  for (const [name, selector] of [
    ["Reasoning", ".ch-think"],
    ["Commands", ".ch-cmd"],
    ["Changes", ".ch-diff"],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(container.querySelector(selector)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(container.querySelectorAll(selector)).toHaveLength(2);
  }
});
it("loads additional pages and uses after for session events only", async () => {
  vi.mocked(api.sessions.transcript).mockImplementation(async (_id, params) =>
    params?.after === 0 ? page(messages, 7, true) : page([], 12)
  );
  render(<Charla />);
  await waitFor(() =>
    expect(api.sessions.transcript).toHaveBeenCalledWith("child", { after: 7, limit: 200 })
  );
  await act(async () => {
    eventBus.publish({ type: "session_updated", timestamp: "2026-10-15T10:00:00Z", data: child });
  });
  await waitFor(() =>
    expect(api.sessions.transcript).toHaveBeenCalledWith("child", { after: 12, limit: 200 })
  );
  const count = vi.mocked(api.sessions.transcript).mock.calls.length;
  await act(async () => {
    eventBus.publish({
      type: "session_updated",
      timestamp: "2026-10-15T10:00:00Z",
      data: { ...child, id: "other" },
    });
  });
  expect(vi.mocked(api.sessions.transcript).mock.calls.length).toBe(count);
});
it("shows loading, empty and recoverable failure states", async () => {
  vi.mocked(api.sessions.list).mockRejectedValueOnce(new Error("offline"));
  render(<Charla />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  await screen.findByRole("alert");
  vi.mocked(api.sessions.list).mockResolvedValue({
    sessions: [],
    total: 0,
    limit: 1000,
    offset: 0,
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No Claude assignments with Codex children in this scope.");
});
it("expands long output", async () => {
  vi.mocked(api.sessions.transcript).mockResolvedValue(
    page([
      {
        type: "assistant",
        timestamp: null,
        content: [
          { type: "tool_use", name: "Bash", id: "long", input: { command: "test" } },
          {
            type: "tool_result",
            id: "long",
            output: Array.from({ length: 15 }, (_, i) => `line-${i}`).join("\n"),
          },
        ],
      },
    ])
  );
  render(<Charla />);
  const buttons = await screen.findAllByRole("button", { name: "Show all" });
  expect(screen.queryByText(/line-14/)).toBeNull();
  fireEvent.click(buttons[0]!);
  expect(screen.getByText(/line-14/)).toBeInTheDocument();
});
it("Charla loaded screen", async () => {
  const { container } = render(<Charla />);
  await waitFor(() => expect(container.querySelectorAll(".ch-cmd")).toHaveLength(2));
  expect(container).toMatchSnapshot();
});

it("keeps the chosen child after completion and lets the user select another", async () => {
  const older = { ...child, id: "older", name: "Older child", started_at: "2026-10-14T10:00:00Z" };
  vi.mocked(api.sessions.list).mockResolvedValue({
    sessions: [parent, older, child],
    total: 3,
    limit: 1000,
    offset: 0,
  });
  render(<Charla />);
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("child"));
  vi.mocked(api.sessions.list).mockResolvedValue({
    sessions: [parent, older, { ...child, status: "completed" }],
    total: 3,
    limit: 1000,
    offset: 0,
  });
  await act(async () => {
    eventBus.publish({
      type: "session_updated",
      data: { ...child, status: "completed" },
      timestamp: "2026-10-15T10:00:00Z",
    });
  });
  expect(screen.getByRole("combobox")).toHaveValue("child");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "older" } });
  await waitFor(() =>
    expect(api.sessions.transcript).toHaveBeenCalledWith("older", { after: 0, limit: 200 })
  );
});
it("ignores stale transcripts after changing assignments", async () => {
  let resolveOld!: (value: ReturnType<typeof page>) => void;
  const oldRequest = new Promise<ReturnType<typeof page>>((resolve) => {
    resolveOld = resolve;
  });
  const other = { ...child, id: "other", name: "Other child" };
  vi.mocked(api.sessions.list).mockResolvedValue({
    sessions: [parent, child, other],
    total: 3,
    limit: 1000,
    offset: 0,
  });
  vi.mocked(api.sessions.transcript).mockImplementation(async (id) =>
    id === "child" ? oldRequest : page([])
  );
  render(<Charla />);
  await waitFor(() =>
    expect(api.sessions.transcript).toHaveBeenCalledWith("child", { after: 0, limit: 200 })
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "other" } });
  await act(async () => {
    resolveOld(
      page([
        { type: "assistant", timestamp: null, content: [{ type: "text", text: "Stale reply" }] },
      ])
    );
  });
  expect(screen.queryByText("Stale reply")).toBeNull();
});
it("maps raw Codex patches, writes and reads without losing diff signs", () => {
  const blocks = transcriptBlocks([
    {
      type: "assistant",
      timestamp: null,
      content: [
        {
          type: "tool_use",
          name: "functions.apply_patch",
          input: { code: "*** Begin Patch\n-old\n+new\n*** End Patch" },
        },
        { type: "tool_use", name: "Write", input: { file_path: "new.ts", content: "one\ntwo" } },
        { type: "tool_use", name: "functions.exec_command", id: "exec", input: { cmd: "ls" } },
      ],
    },
  ]);
  expect(blocks[0]).toMatchObject({
    kind: "diff",
    output: "*** Begin Patch\n-old\n+new\n*** End Patch",
  });
  expect(blocks[1]).toMatchObject({ kind: "diff", output: "+one\n+two" });
  expect(blocks[2]).toMatchObject({ kind: "cmd", text: "ls" });
});
