/**
 * @file handoff-model.ts
 * @description Validates handoff metadata and derives period, status and duration for Muro.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import {
  isSessionAwaitingInput,
  sessionAwaitingReason,
  type Session,
  type MuroPeriod,
} from "../../lib/types";
import { parseDate } from "../../lib/format";

export type HandoffRound = {
  ask: string;
  ask_at: string | null;
  reply: string | null;
  reply_at: string | null;
};
export type Handoff = { from: "claude"; parent_session_id: string | null; rounds: HandoffRound[] };
export function lastRound(handoff: Handoff | null): HandoffRound | undefined {
  return handoff?.rounds[handoff.rounds.length - 1];
}
export function sessionHandoff(session: Pick<Session, "metadata" | "provider">): Handoff | null {
  if (session.provider !== "codex") return null;
  try {
    const value = JSON.parse(session.metadata || "{}").handoff;
    if (value?.from !== "claude" || !Array.isArray(value.rounds)) return null;
    const timestamp = (at: unknown): string | null =>
      typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
    return {
      from: "claude",
      parent_session_id:
        typeof value.parent_session_id === "string" ? value.parent_session_id : null,
      rounds: value.rounds
        .filter((round: HandoffRound) => round && typeof round.ask === "string")
        .map((round: HandoffRound) => ({
          ask: Array.from(round.ask).slice(0, 2000).join(""),
          ask_at: timestamp(round.ask_at),
          reply:
            typeof round.reply === "string"
              ? Array.from(round.reply).slice(0, 2000).join("")
              : null,
          reply_at: timestamp(round.reply_at),
        })),
    };
  } catch {
    return null;
  }
}
export function handoffStatus(session: Session): "working" | "waiting" | "delivered" {
  if (session.status === "completed") return "delivered";
  if (isSessionAwaitingInput(session)) {
    return sessionAwaitingReason(session) === "stop" &&
      lastRound(sessionHandoff(session))?.reply != null
      ? "delivered"
      : "waiting";
  }
  return "working";
}
export function handoffsInPeriod<T extends Session>(
  sessions: T[],
  period: MuroPeriod,
  now = new Date()
): T[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (period === "7d" ? 6 : period === "30d" ? 29 : 0));
  return sessions
    .filter(
      (session) =>
        sessionHandoff(session) &&
        parseDate(session.started_at) >= start &&
        parseDate(session.started_at) <= now
    )
    .sort(
      (a, b) =>
        parseDate(b.started_at).getTime() - parseDate(a.started_at).getTime() ||
        a.id.localeCompare(b.id)
    );
}
export function childHandoffs<T extends Session>(session: Session, sessions: T[]): T[] {
  return session.provider === "claude"
    ? sessions.filter((candidate) => sessionHandoff(candidate)?.parent_session_id === session.id)
    : [];
}
export function handoffElapsed(session: Session, now = Date.now()): number {
  const rounds = sessionHandoff(session)?.rounds || [];
  const start = parseDate(rounds[0]?.ask_at || session.started_at).getTime();
  const end =
    handoffStatus(session) === "delivered"
      ? parseDate(
          rounds[rounds.length - 1]?.reply_at || session.ended_at || session.started_at
        ).getTime()
      : now;
  return Math.max(0, end - start);
}
