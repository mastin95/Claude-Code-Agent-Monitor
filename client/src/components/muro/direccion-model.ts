/**
 * @file direccion-model.ts
 * @description Pure helpers that turn conductor orders, rounds and approvals into Dirección's score, stage and OK cards.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import type {
  ConductorAgentName,
  ConductorApproval,
  ConductorOrder,
  ConductorProject,
  ConductorRound,
} from "../../lib/types";

/** Kinds of rows in the Partitura, in story order. */
export type ScoreKind = "order" | "plan" | "handoff" | "reply" | "failed" | "ok" | "result";

export interface ScoreRow {
  key: string;
  kind: ScoreKind;
  who: ConductorAgentName | "martin";
  at: string;
  text: string;
  /** Round number for hand-offs and replies. */
  n?: number;
  /** Martin's answer for answered OK cards. */
  answer?: ConductorApproval["answer"];
}

/** What the stage shows for one agent. */
export interface StageAgent {
  agent: ConductorAgentName;
  lead: boolean;
  /** i18n key under `direccion:doing.*`, or null when `raw` should be shown as-is. */
  doingKey: string | null;
  raw: string;
  model: string | null;
  effort: string | null;
  tokens: number | null;
  sessionId: string | null;
}

const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Order → plan → hand-offs/replies → OK cards → result, sorted by time (stable). */
export function scoreRows(order: ConductorOrder | null): ScoreRow[] {
  if (!order) return [];
  const rows: ScoreRow[] = [
    { key: "order", kind: "order", who: "martin", at: order.created_at, text: order.text },
  ];
  const firstAsk = order.rounds[0]?.ask_at;
  if (order.plan) {
    rows.push({
      key: "plan",
      kind: "plan",
      who: "claude",
      at: firstAsk || order.created_at,
      text: order.plan,
    });
  }
  for (const round of order.rounds) {
    rows.push({
      key: `ask-${round.id}`,
      kind: "handoff",
      who: round.from,
      at: round.ask_at,
      text: round.ask,
      n: round.n,
    });
    if (round.status !== "pending") {
      rows.push({
        key: `reply-${round.id}`,
        kind: round.status === "error" ? "failed" : "reply",
        who: round.to,
        at: round.reply_at || round.ask_at,
        text: round.reply || "",
        n: round.n,
      });
    }
  }
  for (const approval of order.approvals) {
    rows.push({
      key: `ok-${approval.id}`,
      kind: "ok",
      who: approval.agent,
      at: approval.created_at,
      text: approval.summary,
      answer: approval.answer,
    });
  }
  if (order.result) {
    rows.push({
      key: "result",
      kind: "result",
      who: "claude",
      at: order.ended_at || order.rounds[order.rounds.length - 1]?.reply_at || order.created_at,
      text: order.result,
    });
  }
  // Plan is anchored to the first ask; keep it right before that ask on equal times.
  const rank: Record<ScoreKind, number> = {
    order: 0,
    plan: 1,
    handoff: 2,
    ok: 3,
    reply: 4,
    failed: 4,
    result: 5,
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        time(a.row.at) - time(b.row.at) || rank[a.row.kind] - rank[b.row.kind] || a.index - b.index
    )
    .map(({ row }) => row);
}

/** The hand-off currently travelling between the agents, if any. */
export function currentRound(order: ConductorOrder | null): ConductorRound | null {
  if (!order) return null;
  return [...order.rounds].reverse().find((round) => round.status === "pending") || null;
}

/** OK cards still waiting for Martin, oldest first. */
export function pendingApprovals(order: ConductorOrder | null): ConductorApproval[] {
  if (!order) return [];
  return order.approvals
    .filter((approval) => approval.status === "pending")
    .sort((a, b) => time(a.created_at) - time(b.created_at));
}

/** True while the order can still receive indications or be stopped. */
export function isOrderLive(order: ConductorOrder | null): boolean {
  return !!order && ["planning", "delegating", "waiting_ok"].includes(order.status);
}

const DOING: Array<[RegExp, string]> = [
  [/dashboard_handoff/, "handoff"],
  [/dashboard_(ask_user|permission)/, "waitingOk"],
  [/^(Bash|commandExecution|command_execution|exec_command)/i, "command"],
  [/^(Edit|Write|MultiEdit|NotebookEdit|fileChange|file_change|apply_patch)/i, "editing"],
  [/^(Read|Grep|Glob|LS)$/i, "reading"],
  [/^(WebSearch|WebFetch|webSearch|web_search)/i, "web"],
  [/^(pensando|reasoning|thinking)$/i, "thinking"],
  [/^(Task|Agent)$/, "subagent"],
];

/** Map a raw tool/item name from `conductor_agent.doing` to an i18n key. */
export function doingKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const [pattern, key] of DOING) if (pattern.test(raw)) return key;
  return null;
}

/** Best-effort total from Claude `usage` or Codex `tokenUsage` payloads. */
export function tokenCount(tokens: unknown): number | null {
  if (typeof tokens === "number" && Number.isFinite(tokens)) return tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const value = tokens as Record<string, unknown>;
  const total = value.total as Record<string, unknown> | undefined;
  for (const candidate of [total?.totalTokens, value.totalTokens, value.total_tokens]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  const parts = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]
    .map((key) => value[key])
    .filter((part): part is number => typeof part === "number" && Number.isFinite(part));
  return parts.length ? parts.reduce((sum, part) => sum + part, 0) : null;
}

/** "61k" style compact token label. */
export function compactTokens(value: number | null): string | null {
  if (value == null) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/** Stage card for one agent, merging live WS state, run snapshots and project defaults. */
export function stageAgent(
  agent: ConductorAgentName,
  project: ConductorProject | null,
  order: ConductorOrder | null
): StageAgent {
  const live = order?.agents?.[agent];
  const run = order?.runs?.[agent] || null;
  const lead = (project?.lead || "claude") === agent;
  let key: string | null;
  let raw = "";
  if (!order) key = "idle";
  else if (!isOrderLive(order)) key = order.status === "done" ? "done" : "stopped";
  // The collaborator only works while a hand-off is in flight.
  else if (!lead && !currentRound(order)) key = "waitingHandoff";
  else if (live?.doing) {
    raw = live.doing;
    key = doingKey(live.doing);
  } else key = "thinking";
  return {
    agent,
    lead,
    doingKey: key,
    raw,
    model: live?.model || run?.model || project?.[`${agent}_model`] || null,
    effort: live?.effort || run?.effort || project?.[`${agent}_effort`] || null,
    tokens: tokenCount(live?.tokens),
    sessionId: live?.sessionId || run?.sessionId || run?.session_id || null,
  };
}
