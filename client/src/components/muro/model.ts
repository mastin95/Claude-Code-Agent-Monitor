/**
 * @file model.ts
 * @description Shared session-to-post-it rules, local calendar windows and paper colours.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { isSessionAwaitingInput, type MuroPeriod, type Session } from "../../lib/types";
import type { MuroAgent } from "./Mascot";

export type MuroSession = Session & { provider: MuroAgent };
export type Lane = "working" | "waiting" | "done";
export const LANES: Lane[] = ["working", "waiting", "done"];
export function isMuroSession(session: Session): session is MuroSession {
  return session.provider === "claude" || session.provider === "codex";
}
/** Active/waiting sessions span periods; completed sessions use local calendar days. */
export function sessionLane(session: Session, period: MuroPeriod, now = new Date()): Lane | null {
  if (!isMuroSession(session)) return null;
  if (isSessionAwaitingInput(session)) return "waiting";
  if (session.status === "active") return "working";
  if (session.status !== "completed" || !session.ended_at) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  start.setDate(start.getDate() - (period === "7d" ? 6 : period === "30d" ? 29 : 0));
  const ended = new Date(session.ended_at).getTime();
  return ended >= start.getTime() && ended < end.getTime() ? "done" : null;
}
export function sessionTitle(session: Session, fallback: string): string {
  return (
    session.name?.trim() ||
    Array.from(session.prompt_preview?.trim() || "")
      .slice(0, 40)
      .join("") ||
    fallback
  );
}
export function paper(agent: MuroAgent, lane: Lane): string {
  return lane === "waiting" ? "#F6E7A6" : agent === "claude" ? "#FFCFB0" : "#AEE8DE";
}
export function rotation(id: string): number {
  return ((Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 7) - 3) * 0.8;
}
export function modeFor(lane: Lane) {
  return lane === "working" ? "work" : lane === "waiting" ? "wait" : "done";
}
