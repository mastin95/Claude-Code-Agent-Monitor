/**
 * @file Handoffs.test.tsx
 * @description Verifies period ribbons, handoff status, stamps, parent links,
 * live conversations and reduced-motion paper-plane presentation.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { HandoffRibbon, HandoffPlane } from "../Handoffs";
import { handoffStatus, sessionHandoff } from "../handoff-model";
import { Board } from "../Board";
import type { MuroSession } from "../model";
import { api } from "../../../lib/api";
import i18n from "../../../i18n";
import companionFixture from "../../../../../server/__tests__/fixtures/codex-companion-0162-2-turn.json";
vi.mock("../../../lib/api", () => ({ api: { sessions: { stats: vi.fn() } } }));
const now = new Date(2026, 9, 14, 12);
const time = (day: number, hour = 10) => new Date(2026, 9, day, hour).toISOString();
const parent: MuroSession = {
  id: "claude",
  provider: "claude",
  name: "Parent work",
  status: "active",
  started_at: time(14, 9),
  ended_at: null,
  cwd: null,
  model: null,
  metadata: null,
};
function handoff(id = "codex", changes: Partial<MuroSession> = {}): MuroSession {
  return {
    ...parent,
    id,
    provider: "codex",
    name: `Work ${id}`,
    started_at: time(14),
    metadata: JSON.stringify({
      handoff: {
        from: "claude",
        parent_session_id: parent.id,
        rounds: [
          { ask: `Request ${id}\nSecond line`, ask_at: time(14), reply: null, reply_at: null },
        ],
      },
    }),
    ...changes,
  };
}
function answered(session = handoff()): MuroSession {
  return {
    ...session,
    status: "completed",
    ended_at: time(14, 11),
    metadata: JSON.stringify({
      handoff: {
        ...sessionHandoff(session),
        rounds: [
          { ask: "First ask", ask_at: time(14), reply: "First reply", reply_at: time(14, 11) },
          {
            ask: "Follow-up ask",
            ask_at: time(14, 11),
            reply: "Final reply\nDetails",
            reply_at: time(14, 11),
          },
        ],
      },
    }),
  };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now });
  await i18n.changeLanguage("en");
  vi.mocked(api.sessions.stats).mockResolvedValue({
    session_id: "codex",
    total_events: 0,
    events_by_type: [],
    tools_used: [],
    error_count: 0,
    first_event_at: null,
    last_event_at: null,
    agents: { total: 0, main: 0, subagent: 0, compaction: 0, by_status: {} },
    subagent_types: [],
    tokens: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Muro handoffs", () => {
  it("shows an accessible empty ribbon and follows calendar periods", () => {
    const old = handoff("old", { started_at: time(10) });
    const { rerender } = render(
      <HandoffRibbon sessions={[old, parent]} period="today" onOpen={vi.fn()} />
    );
    expect(
      screen.getByText("No handoffs yet. Claude passes them to Codex with /codex:rescue.")
    ).toBeVisible();
    rerender(<HandoffRibbon sessions={[old, parent]} period="7d" onOpen={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Handoffs · 7 days" })).toBeVisible();
    expect(screen.getByText("Request old")).toBeVisible();
    expect(screen.queryByText("Second line")).toBeNull();
  });
  it("caps at five newest rows while counting and averaging the whole period", () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      answered(handoff(String(index), { started_at: time(14, index + 1) }))
    );
    const open = vi.fn();
    render(<HandoffRibbon sessions={sessions} period="today" onOpen={open} />);
    const region = screen.getByRole("region");
    expect(within(region).getAllByRole("listitem")).toHaveLength(5);
    expect(within(region).getByText(/6 handoffs · Average round trip: 60 min/)).toBeVisible();
    expect(within(region).getAllByText(/2 rounds/)).toHaveLength(5);
    fireEvent.click(within(region).getAllByRole("button")[0]!);
    expect(open).toHaveBeenCalledWith(sessions[5]);
    expect(within(region).getAllByText("Final reply")).toHaveLength(5);
    expect(within(region).getAllByText("First ask")).toHaveLength(5);
    expect(within(region).queryByText("Follow-up ask")).toBeNull();
  });
  it("shows Entregado for the real 0.162 task_complete ingestion result", async () => {
    await i18n.changeLanguage("es");
    const { handoff: conversation, ...lifecycle } = companionFixture.expected;
    render(
      <HandoffRibbon
        sessions={[
          handoff("real", {
            ...lifecycle,
            metadata: JSON.stringify({ handoff: conversation }),
          }),
        ]}
        period="today"
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByText(/^Entregado/)).toBeVisible();
    expect(screen.getByText("Inspect the implementation.")).toBeVisible();
    expect(screen.getByText("The tests pass. Complete.")).toBeVisible();
    expect(screen.queryByText("Check the tests too.")).toBeNull();
  });
  it("shows pending, permission waiting and delivered states without stale replies", () => {
    const active = handoff();
    const permission = handoff("approval", {
      awaiting_input_since: time(14),
      awaiting_reason: "notification",
    });
    render(
      <HandoffRibbon
        sessions={[active, permission, answered(handoff("done"))]}
        period="today"
        onOpen={vi.fn()}
      />
    );
    expect(screen.getAllByText("Codex is working on it...")).toHaveLength(2);
    expect(screen.getByText(/^Working ·/)).toBeVisible();
    expect(screen.getByText(/^Waiting for my OK ·/)).toBeVisible();
    expect(screen.getByText(/^Delivered ·/)).toBeVisible();
    expect(
      handoffStatus({
        ...answered(),
        status: "active",
        awaiting_input_since: time(14),
        awaiting_reason: "stop",
      })
    ).toBe("delivered");
  });
  it("stamps Codex notes, labels the parent and navigates both live sheets", async () => {
    const active = handoff();
    const board = (session: MuroSession) => (
      <MemoryRouter>
        <Board sessions={[parent, session]} period="today" filterKey="today" />
      </MemoryRouter>
    );
    const { rerender } = render(board(active));
    expect(screen.getByText("From Claude")).toBeVisible();
    expect(screen.getByText("→ 1 handoff to Codex · in progress")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Work codex, Codex/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Round 1")).toBeVisible();
    expect(within(dialog).queryByText("What you asked:")).toBeNull();
    expect(within(dialog).getByLabelText(/Claude asks Codex:/)).toHaveTextContent("Request codex");
    rerender(board(answered(active)));
    expect(within(dialog).getByText("Round 2")).toBeVisible();
    expect(within(dialog).getByText(/Final reply/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: /View Claude's session/ }));
    expect(screen.getByRole("dialog", { name: "Parent work" })).toBeVisible();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Work codex →" })
    );
    expect(screen.getByRole("dialog", { name: "Work codex" })).toBeVisible();
    expect(screen.getByText("→ 1 handoff to Codex · delivered")).toBeVisible();
  });
  it("flies only for ongoing handoffs and disables animation for reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const open = vi.fn();
    const { rerender, container } = render(<HandoffPlane sessions={[handoff()]} onOpen={open} />);
    expect(screen.getByText("Claude → Codex · 120 min ago")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Claude asks Codex: Work codex/ }));
    expect(open).toHaveBeenCalled();
    expect(screen.getByRole("button")).toHaveStyle({ animation: "none" });
    rerender(<HandoffPlane sessions={[answered(), parent]} onOpen={open} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("ignores malformed or non-Codex handoff metadata", () => {
    expect(sessionHandoff({ ...parent, metadata: handoff().metadata })).toBeNull();
    expect(sessionHandoff(handoff("bad", { metadata: "{" }))).toBeNull();
    expect(
      sessionHandoff(handoff("bad", { metadata: '{"handoff":{"from":"claude","rounds":42}}' }))
    ).toBeNull();
  });
});
