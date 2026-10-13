/**
 * @file Board.test.tsx
 * @description Covers calendar lanes, real progress, detail loading/retry/focus and motion guards.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "../Board";
import { sessionLane, type MuroSession } from "../model";
import { api } from "../../../lib/api";
import type { Session, SessionStats } from "../../../lib/types";

vi.mock("../../../lib/api", () => ({ api: { sessions: { stats: vi.fn() } } }));
const now = new Date(2026, 9, 13, 12);
const row: MuroSession = {
  id: "one",
  provider: "claude",
  status: "active",
  name: "Review design",
  started_at: new Date(2026, 9, 13, 10).toISOString(),
  ended_at: null,
  cwd: null,
  model: null,
  metadata: null,
  prompt_preview: "Please review the design",
  total_tokens: 12345,
};
const stats: SessionStats = {
  session_id: "one",
  total_events: 2,
  events_by_type: [],
  tools_used: [
    { tool_name: "Edit", count: 2 },
    { tool_name: "Read", count: 5 },
  ],
  files_touched: ["src/App.tsx"],
  error_count: 0,
  first_event_at: row.started_at,
  last_event_at: new Date(2026, 9, 13, 11).toISOString(),
  agents: { total: 1, main: 1, subagent: 0, compaction: 0, by_status: {} },
  subagent_types: [],
  tokens: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 3, cache_write_tokens: 4 },
};
function board(sessions: MuroSession[], period: "today" | "7d" | "30d" = "today") {
  return (
    <MemoryRouter>
      <Board sessions={sessions} period={period} filterKey={period} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now });
  vi.mocked(api.sessions.stats).mockReset().mockResolvedValue(stats);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Muro column rules", () => {
  it("excludes Cursor and terminal failures, and waiting requires an active session", () => {
    expect(sessionLane(row, "today", now)).toBe("working");
    expect(sessionLane({ ...row, awaiting_input_since: row.started_at }, "today", now)).toBe(
      "waiting"
    );
    for (const status of ["error", "abandoned"] as const)
      expect(
        sessionLane({ ...row, status, awaiting_input_since: row.started_at }, "today", now)
      ).toBeNull();
    expect(sessionLane({ ...row, provider: "cursor" }, "today", now)).toBeNull();
  });
  it.each([
    ["today", 0],
    ["7d", 6],
    ["30d", 29],
  ] as const)("uses inclusive local midnight and an exclusive next day for %s", (period, days) => {
    const start = new Date(2026, 9, 13 - days);
    const done: Session = {
      ...row,
      status: "completed",
      awaiting_input_since: row.started_at,
      ended_at: start.toISOString(),
    };
    expect(sessionLane(done, period, now)).toBe("done");
    expect(
      sessionLane({ ...done, ended_at: new Date(+start - 1).toISOString() }, period, now)
    ).toBeNull();
    expect(
      sessionLane({ ...done, ended_at: new Date(2026, 9, 14).toISOString() }, period, now)
    ).toBeNull();
    expect(sessionLane({ ...done, ended_at: "invalid" }, period, now)).toBeNull();
  });
  it("renders the three lanes, permission urgency, and only real progress", () => {
    render(
      board([
        {
          ...row,
          todo_summary: {
            total: 4,
            completed: 2,
            inProgress: 1,
            pending: 1,
            cancelled: 0,
            unknown: 0,
            percentComplete: 50,
            activeText: null,
            sourceTool: null,
            updatedAt: null,
            previewItems: [],
            overflowCount: 0,
            ownerBreakdown: [],
          },
        },
        {
          ...row,
          id: "waiting",
          provider: "codex",
          awaiting_input_since: row.started_at,
          awaiting_reason: "notification",
        },
        { ...row, id: "done", status: "completed", ended_at: now.toISOString() },
      ])
    );
    for (const lane of ["Working", "Waiting for my OK", "Done"])
      expect(
        within(screen.getByRole("region", { name: lane })).getAllByRole("button")
      ).toHaveLength(1);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByText("Permission needed")).toHaveClass("muro-urgent");
  });
  it("reassigns a session on live updates and removes old completions when the period narrows", () => {
    const { rerender } = render(board([row]));
    rerender(board([{ ...row, awaiting_input_since: row.started_at }]));
    expect(
      within(screen.getByRole("region", { name: "Working" })).queryByRole("button")
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Waiting for my OK" })).getByRole("button")
    ).toBeVisible();
    const done = {
      ...row,
      status: "completed" as const,
      ended_at: new Date(2026, 9, 10).toISOString(),
    };
    rerender(board([done], "7d"));
    expect(within(screen.getByRole("region", { name: "Done" })).getByRole("button")).toBeVisible();
    rerender(board([done], "today"));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("session sheet", () => {
  it("loads stats only on open, traps focus, and restores the post-it on Escape", async () => {
    const user = userEvent.setup();
    render(board([row]));
    const note = screen.getByRole("button", { name: /Review design/ });
    expect(api.sessions.stats).not.toHaveBeenCalled();
    await user.click(note);
    const dialog = await screen.findByRole("dialog", { name: "Review design" });
    expect(api.sessions.stats).toHaveBeenCalledWith("one");
    expect(within(dialog).getByText("Please review the design")).toBeVisible();
    expect(within(dialog).getByText("127")).toBeVisible();
    // The event range ends an hour earlier; sheet and post-it still show the same elapsed time.
    expect(within(note).getByText("2h 0m")).toBeVisible();
    expect(within(dialog).getByText("2h 0m")).toBeVisible();
    expect(within(dialog).getByText("src/App.tsx")).toBeVisible();
    expect(within(dialog).getByRole("link")).toHaveAttribute("href", "/sessions/one");
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByRole("link")).toHaveFocus();
    await user.keyboard("{Tab}{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(note).toHaveFocus();
  });
  it("uses the completed session duration even when events cover a shorter interval", async () => {
    const user = userEvent.setup();
    render(
      board([
        { ...row, status: "completed", ended_at: new Date(2026, 9, 13, 11, 30).toISOString() },
      ])
    );
    const note = screen.getByRole("button", { name: /Review design/ });
    await user.click(note);
    const dialog = await screen.findByRole("dialog");
    expect(within(note).getByText("1h 30m")).toBeVisible();
    expect(within(dialog).getByText("1h 30m")).toBeVisible();
  });
  it("shows a skeleton, handles failure/retry, and closes from X and the backdrop", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(api.sessions.stats).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      })
    );
    const user = userEvent.setup();
    render(board([row]));
    const note = screen.getByRole("button", { name: /Review design/ });
    await user.click(note);
    expect(screen.getByRole("status", { name: "Loading session summary…" })).toBeVisible();
    await act(async () => reject(new Error("offline")));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("src/App.tsx")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(note).toHaveFocus();
    await user.click(note);
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(note).toHaveFocus();
  });
});

it("suppresses FLIP and completion confetti with reduced motion", async () => {
  const animate = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
  vi.stubGlobal("Animation", class {});
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  const { rerender, unmount } = render(board([row]));
  rerender(board([{ ...row, status: "completed", ended_at: now.toISOString() }]));
  expect(animate).not.toHaveBeenCalled();
  expect(document.querySelector(".muro-confetti")).toBeNull();
  unmount();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

it("FLIPs a moved note and celebrates only its transition to done", async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ now });
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(this.closest('[aria-label="Done"]') ? 500 : 0, 100, 200, 250);
  });
  try {
    const { rerender, unmount } = render(board([row]));
    expect(animate).not.toHaveBeenCalled();
    const completed = { ...row, status: "completed" as const, ended_at: now.toISOString() };
    rerender(board([completed]));
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translate(-500px,0px)" }, { transform: "none" }],
      { duration: 550, easing: "cubic-bezier(.2,.8,.2,1)" }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });
    expect(document.querySelectorAll(".muro-confetti")).toHaveLength(32);
    const count = animate.mock.calls.length;
    rerender(board([completed]));
    expect(animate).toHaveBeenCalledTimes(count);
    unmount();
    expect(document.querySelectorAll(".muro-confetti")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(document.querySelectorAll(".muro-confetti")).toHaveLength(0);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "animate", original);
    else delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  }
});
