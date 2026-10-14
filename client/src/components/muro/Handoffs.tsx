/**
 * @file Handoffs.tsx
 * @description Accessible handoff ribbon, paper-plane stage cue and round-by-round conversation.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { formatTime, getCurrentLocale, parseDate } from "../../lib/format";
import type { MuroPeriod } from "../../lib/types";
import { sessionTitle, type MuroSession } from "./model";
import { useReducedMotion } from "./motion";
import {
  handoffsInPeriod,
  handoffStatus,
  handoffElapsed,
  sessionHandoff,
  lastRound,
  type Handoff,
} from "./handoff-model";
import "./handoffs.css";

const firstLine = (text: string) => text.split(/\r?\n/)[0];
const duration = (ms: number) =>
  new Intl.NumberFormat(getCurrentLocale(), {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(ms / 60000);
export function HandoffRibbon({
  sessions,
  period,
  onOpen,
}: {
  sessions: MuroSession[];
  period: MuroPeriod;
  onOpen: (session: MuroSession) => void;
}) {
  const { t } = useTranslation("muro");
  const list = handoffsInPeriod(sessions, period);
  const delivered = list.filter(
    (session) =>
      handoffStatus(session) === "delivered" && lastRound(sessionHandoff(session))?.reply_at
  );
  const average = delivered.length
    ? duration(
        delivered.reduce((sum, session) => sum + handoffElapsed(session), 0) / delivered.length
      )
    : "—";
  return (
    <section className="muro-handoffs" aria-label={t(`handoffs.heading.${period}`)}>
      <header>
        <h2>{t(`handoffs.heading.${period}`)}</h2>
        <span>
          {`${t("handoffs.count", { count: list.length })} · ${t("handoffs.average", { duration: average })}`}
        </span>
      </header>
      {!list.length ? (
        <p className="muro-handoff-empty">{t("handoffs.empty")}</p>
      ) : (
        <ol>
          {list.slice(0, 5).map((session) => {
            const rounds = sessionHandoff(session)!.rounds;
            const round = rounds[rounds.length - 1];
            const ask = firstLine(rounds[0]?.ask || sessionTitle(session, t("stage.untitled")));
            const state = handoffStatus(session);
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className="muro-handoff-row"
                  onClick={() => onOpen(session)}
                  aria-label={t("handoffs.open", { ask, state: t(`handoffs.status.${state}`) })}
                >
                  <b>Claude</b>
                  <span className="muro-handoff-ask">{ask}</span>
                  <span className="muro-handoff-times">
                    <span>
                      {t("handoffs.sent", {
                        time: formatTime(rounds[0]?.ask_at || session.started_at),
                      })}
                    </span>
                    {round?.reply_at && (
                      <span>{t("handoffs.returned", { time: formatTime(round.reply_at) })}</span>
                    )}
                  </span>
                  <span className={`muro-handoff-reply${round?.reply == null ? " pending" : ""}`}>
                    {round?.reply == null ? t("handoffs.pending") : firstLine(round.reply)}
                  </span>
                  <span className={`muro-handoff-status ${state}`}>
                    {t(`handoffs.status.${state}`)} · {duration(handoffElapsed(session))}
                    {rounds.length > 1 && <> · {t("handoffs.rounds", { count: rounds.length })}</>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
export function HandoffPlane({
  sessions,
  onOpen,
}: {
  sessions: MuroSession[];
  onOpen: (session: MuroSession) => void;
}) {
  const { t } = useTranslation("muro");
  const reducedMotion = useReducedMotion();
  const session = sessions
    .filter((candidate) => sessionHandoff(candidate) && handoffStatus(candidate) !== "delivered")
    .sort((a, b) => parseDate(b.started_at).getTime() - parseDate(a.started_at).getTime())[0];
  if (!session) return null;
  const title = sessionTitle(session, t("stage.untitled"));
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - parseDate(session.started_at).getTime()) / 60000)
  );
  return (
    <button
      type="button"
      className="muro-handoff-plane"
      style={reducedMotion ? { animation: "none" } : undefined}
      onClick={() => onOpen(session)}
      aria-label={t("handoffs.open", {
        ask: title,
        state: t(`handoffs.status.${handoffStatus(session)}`),
      })}
    >
      <Send aria-hidden="true" size={22} />
      <span>
        <b>{title}</b>
        <small>{t("handoffs.flight", { count: minutes })}</small>
      </span>
    </button>
  );
}
export function HandoffConversation({
  handoff,
  onNavigate,
}: {
  handoff: Handoff;
  onNavigate?: (id: string) => void;
}) {
  const { t } = useTranslation("muro");
  return (
    <section className="muro-conversation" aria-label={t("handoffs.conversation")}>
      {handoff.rounds.map((round, index) => (
        <div className="muro-round" key={index}>
          <h3>{t("handoffs.round", { count: index + 1 })}</h3>
          <div className="muro-message ask" aria-label={t("handoffs.askLabel", { ask: round.ask })}>
            <b>Claude</b>
            {round.ask_at && <time dateTime={round.ask_at}>{formatTime(round.ask_at)}</time>}
            <p>{round.ask}</p>
          </div>
          <div className="muro-message reply" aria-label={t("handoffs.replyLabel")}>
            <b>Codex</b>
            {round.reply_at && <time dateTime={round.reply_at}>{formatTime(round.reply_at)}</time>}
            <p>{round.reply ?? t("handoffs.pending")}</p>
          </div>
        </div>
      ))}
      {handoff.parent_session_id && onNavigate && (
        <button
          type="button"
          className="muro-session-link"
          onClick={() => onNavigate(handoff.parent_session_id!)}
        >
          {t("handoffs.parent")} →
        </button>
      )}
    </section>
  );
}
