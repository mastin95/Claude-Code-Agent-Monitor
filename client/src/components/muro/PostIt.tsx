/**
 * @file PostIt.tsx
 * @description Illustrated session post-it with lifecycle label, real progress and usage.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import type { CSSProperties, Ref } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration, formatTime, getCurrentLocale } from "../../lib/format";
import { AWAITING_REASON_CONFIG, sessionAwaitingReason } from "../../lib/types";
import { Mascot } from "./Mascot";
import { modeFor, paper, rotation, sessionTitle, type Lane, type MuroSession } from "./model";

export function PostIt({
  session,
  lane,
  reducedMotion,
  onOpen,
  buttonRef,
}: {
  session: MuroSession;
  lane: Lane;
  reducedMotion: boolean;
  onOpen: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useTranslation("muro");
  const reason = sessionAwaitingReason(session) || "stop";
  const title = sessionTitle(session, t("stage.untitled"));
  const agent = session.provider === "claude" ? "Claude" : "Codex";
  const label =
    lane === "working"
      ? t(`note.${session.provider}`)
      : lane === "waiting"
        ? t(`note.reason.${reason}`)
        : t("note.done", { time: formatTime(session.ended_at!) });
  const progress = lane === "working" && session.todo_summary?.total ? session.todo_summary : null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className="muro-note muro-mascot-hover"
      style={
        {
          "--paper": paper(session.provider, lane),
          "--rotation": `${rotation(session.id)}deg`,
        } as CSSProperties
      }
      aria-label={t("note.open", { title, agent, state: label })}
      onClick={onOpen}
    >
      <span className="muro-scene">
        <span
          className={`muro-tag ${lane === "waiting" && AWAITING_REASON_CONFIG[reason].urgent ? "muro-urgent" : ""}`}
        >
          {label}
        </span>
        <Mascot
          agent={session.provider}
          mode={modeFor(lane)}
          size={98}
          reducedMotion={reducedMotion}
        />
      </span>
      <span className="muro-note-title">{title}</span>
      {progress && (
        <span
          className="muro-progress"
          role="progressbar"
          aria-label={t("note.progress")}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
        >
          <span
            style={{
              width: `${Math.min(100, Math.max(0, (progress.completed / progress.total) * 100))}%`,
            }}
          />
        </span>
      )}
      <span className="muro-meta">
        <span>{agent}</span>
        <span>
          {formatDuration(session.started_at, session.ended_at || new Date().toISOString())}
        </span>
        <span>
          {t("stage.tokens", {
            formatted: new Intl.NumberFormat(getCurrentLocale(), {
              notation: "compact",
              maximumFractionDigits: 1,
            }).format(session.total_tokens ?? 0),
          })}
        </span>
        {progress && (
          <span>{t("note.steps", { completed: progress.completed, total: progress.total })}</span>
        )}
      </span>
    </button>
  );
}
