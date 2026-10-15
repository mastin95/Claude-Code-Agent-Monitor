/**
 * @file direccion-model.test.ts
 * @description Tests the pure Dirección model: score order, current hand-off, OK cards, agent stage and token totals.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { describe, expect, it } from "vitest";
import {
  compactTokens,
  currentRound,
  doingKey,
  isOrderLive,
  pendingApprovals,
  scoreRows,
  stageAgent,
  tokenCount,
} from "../direccion-model";
import type { ConductorOrder, ConductorProject } from "../../../lib/types";

const project: ConductorProject = {
  id: "p1",
  cwd: "/tmp/demo",
  name: "Demo",
  lead: "claude",
  claude_model: "opus",
  claude_effort: "high",
  codex_model: "gpt-6-astra",
  codex_effort: "medium",
  codex_sandbox: "workspace-write",
  created_at: "2026-10-15T09:00:00Z",
};

function order(overrides: Partial<ConductorOrder> = {}): ConductorOrder {
  return {
    id: "o1",
    project_id: "p1",
    text: "Crea un README",
    status: "delegating",
    lead_run_id: "run-claude",
    created_at: "2026-10-15T10:00:00Z",
    ended_at: null,
    plan: "1 README · 2 revisión",
    result: null,
    rounds: [
      {
        id: "r1",
        order_id: "o1",
        n: 1,
        from: "claude",
        to: "codex",
        ask: "Escribe el README",
        ask_at: "2026-10-15T10:01:00Z",
        reply: "Hecho",
        reply_at: "2026-10-15T10:05:00Z",
        run_id: "run-codex",
        status: "done",
      },
      {
        id: "r2",
        order_id: "o1",
        n: 2,
        from: "claude",
        to: "codex",
        ask: "Añade una frase",
        ask_at: "2026-10-15T10:06:00Z",
        reply: null,
        reply_at: null,
        run_id: "run-codex",
        status: "pending",
      },
    ],
    approvals: [
      {
        id: "a2",
        order_id: "o1",
        agent: "codex",
        kind: "permission",
        summary: "npm install",
        detail: null,
        options: null,
        status: "pending",
        created_at: "2026-10-15T10:07:00Z",
        answered_at: null,
        answer: null,
        note: null,
      },
      {
        id: "a1",
        order_id: "o1",
        agent: "claude",
        kind: "question",
        summary: "¿Inglés o español?",
        detail: null,
        options: ["es", "en"],
        status: "answered",
        created_at: "2026-10-15T10:02:00Z",
        answered_at: "2026-10-15T10:03:00Z",
        answer: "approve",
        note: null,
      },
    ],
    runs: {},
    agents: {},
    ...overrides,
  };
}

describe("direccion model", () => {
  it("tells the story order → plan → hand-offs → OKs → replies in time order", () => {
    const rows = scoreRows(order({ result: "Listo", ended_at: "2026-10-15T10:10:00Z" }));
    expect(rows.map((row) => row.key)).toEqual([
      "order",
      "plan",
      "ask-r1",
      "ok-a1",
      "reply-r1",
      "ask-r2",
      "ok-a2",
      "result",
    ]);
    expect(rows.find((row) => row.key === "ok-a1")?.answer).toBe("approve");
    expect(rows.find((row) => row.key === "reply-r1")).toMatchObject({ kind: "reply", n: 1 });
  });

  it("marks failed replies and skips the plan when the lead never wrote one", () => {
    const failed = order({
      plan: null,
      rounds: [{ ...order().rounds[0]!, status: "error", reply: "timeout" }],
    });
    const rows = scoreRows(failed);
    expect(rows.some((row) => row.kind === "plan")).toBe(false);
    expect(rows.find((row) => row.key === "reply-r1")?.kind).toBe("failed");
    expect(scoreRows(null)).toEqual([]);
  });

  it("finds the hand-off in flight and the OK cards still waiting", () => {
    expect(currentRound(order())?.id).toBe("r2");
    expect(currentRound(order({ rounds: order().rounds.slice(0, 1) }))).toBeNull();
    expect(pendingApprovals(order()).map((a) => a.id)).toEqual(["a2"]);
    expect(isOrderLive(order())).toBe(true);
    expect(isOrderLive(order({ status: "done" }))).toBe(false);
  });

  it("maps raw tool names to friendly doing keys", () => {
    expect(doingKey("mcp__ccam__dashboard_handoff")).toBe("handoff");
    expect(doingKey("mcp__ccam__dashboard_permission")).toBe("waitingOk");
    expect(doingKey("Bash")).toBe("command");
    expect(doingKey("commandExecution")).toBe("command");
    expect(doingKey("fileChange")).toBe("editing");
    expect(doingKey("pensando")).toBe("thinking");
    expect(doingKey("SomethingNew")).toBeNull();
  });

  it("builds stage cards from live state with project defaults as fallback", () => {
    const live = order({
      agents: {
        claude: {
          orderId: "o1",
          agent: "claude",
          runId: "run-claude",
          sessionId: "s-claude",
          doing: "mcp__ccam__dashboard_handoff",
          model: "claude-opus-5-5",
          effort: "high",
          tokens: { input_tokens: 40000, output_tokens: 21000 },
        },
      },
    });
    const claude = stageAgent("claude", project, live);
    expect(claude).toMatchObject({
      lead: true,
      doingKey: "handoff",
      model: "claude-opus-5-5",
      tokens: 61000,
      sessionId: "s-claude",
    });
    const codex = stageAgent("codex", project, live);
    expect(codex).toMatchObject({ lead: false, model: "gpt-6-astra", effort: "medium" });
    expect(stageAgent("codex", project, order({ rounds: [] })).doingKey).toBe("waitingHandoff");
    expect(stageAgent("claude", project, null).doingKey).toBe("idle");
    expect(stageAgent("claude", project, order({ status: "done" })).doingKey).toBe("done");
  });

  it("reads token totals from Claude and Codex payloads", () => {
    expect(tokenCount({ total: { totalTokens: 38000 } })).toBe(38000);
    expect(tokenCount({ total_tokens: 12 })).toBe(12);
    expect(tokenCount(null)).toBeNull();
    expect(compactTokens(61000)).toBe("61k");
    expect(compactTokens(1_500_000)).toBe("1.5M");
    expect(compactTokens(null)).toBeNull();
  });
});
