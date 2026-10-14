/**
 * @file KeyIdeas.tsx
 * @description Validated session ideas, colored bubbles, accessible dots and a live timeline with setup help.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { Session } from "../../lib/types";
import { getCurrentLocale, parseDate } from "../../lib/format";
import "./ideas.css";

export const IDEA_KINDS = ["approach", "pivot", "risk", "improvement"] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];
export type KeyIdea = { kind: IdeaKind; text: string; at: string };
const COLORS = {
  approach: ["#E4DCFF", "#5536D6", "#7B5CFF", "◆"],
  pivot: ["#FFE08A", "#9A5B00", "#E39B00", "↪"],
  risk: ["#FFC4BE", "#B42318", "#E5483F", "!"],
  improvement: ["#C9F2C3", "#1F7A35", "#2EA44F", "✓"],
} as const;
const theme = (kind: IdeaKind) =>
  ({
    "--idea-bg": COLORS[kind][0],
    "--idea-ink": COLORS[kind][1],
    "--idea-dot": COLORS[kind][2],
  }) as CSSProperties;

export function sessionIdeas(session?: Pick<Session, "metadata">): KeyIdea[] {
  try {
    const values: unknown = JSON.parse(session?.metadata || "{}").key_ideas;
    if (!Array.isArray(values)) return [];
    return values
      .filter(
        (idea): idea is KeyIdea =>
          idea &&
          IDEA_KINDS.includes(idea.kind) &&
          typeof idea.text === "string" &&
          idea.text.trim() &&
          typeof idea.at === "string" &&
          Number.isFinite(Date.parse(idea.at))
      )
      .slice(-12)
      .map((idea) => ({ ...idea, text: Array.from(idea.text).slice(0, 120).join("") }));
  } catch {
    return [];
  }
}

export function IdeaDots({ ideas, count = false }: { ideas: KeyIdea[]; count?: boolean }) {
  const { t } = useTranslation("muro");
  if (!ideas.length) return null;
  const number = new Intl.NumberFormat(getCurrentLocale());
  const details = IDEA_KINDS.filter((kind) => ideas.some((idea) => idea.kind === kind))
    .map(
      (kind) =>
        `${number.format(ideas.filter((idea) => idea.kind === kind).length)} ${t(`ideas.kinds.${kind}`)}`
    )
    .join(", ");
  return (
    <span className="muro-idea-count">
      <span className="sr-only">{t("ideas.summary", { count: ideas.length, details })}</span>
      <span className="muro-idea-dots" aria-hidden="true">
        {ideas.map((idea, index) => (
          <span
            key={`${idea.kind}:${idea.text}:${index}`}
            className={index === ideas.length - 1 ? "latest" : ""}
            style={theme(idea.kind)}
          />
        ))}
      </span>
      {count && <span aria-hidden="true">{t("ideas.count", { count: ideas.length })}</span>}
    </span>
  );
}

export function IdeaBubble({
  ideas,
  stage = false,
  reducedMotion = false,
}: {
  ideas: KeyIdea[];
  stage?: boolean;
  reducedMotion?: boolean;
}) {
  const { t } = useTranslation("muro");
  const latest = ideas[ideas.length - 1];
  if (!latest) return null;
  return (
    <span
      key={`${latest.kind}:${latest.at}:${latest.text}`}
      className={`muro-idea-bubble${stage ? " muro-idea-stage" : ""}${reducedMotion ? " muro-idea-still" : ""}`}
      style={theme(latest.kind)}
    >
      <span className="muro-idea-heading">
        <span className="muro-idea-kind">
          <span aria-hidden="true">{COLORS[latest.kind][3]}</span> {t(`ideas.kinds.${latest.kind}`)}
        </span>
        <IdeaDots ideas={ideas} />
      </span>
      <span className="muro-idea-text">{latest.text}</span>
    </span>
  );
}

export function IdeaLegend() {
  const { t } = useTranslation("muro");
  return (
    <div className="muro-idea-legend" aria-label={t("ideas.legend")}>
      {IDEA_KINDS.map((kind) => (
        <span key={kind} style={theme(kind)}>
          <i aria-hidden="true" />
          {t(`ideas.kinds.${kind}`)}
        </span>
      ))}
    </div>
  );
}

export function IdeaTimeline({ ideas }: { ideas: KeyIdea[] }) {
  const { t } = useTranslation("muro");
  const [copyState, setCopyState] = useState<"copy" | "copied" | "copyError">("copy");
  const time = new Intl.DateTimeFormat(getCurrentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return (
    <section className="muro-idea-section" aria-label={t("ideas.title")}>
      <h3>{t("ideas.title")}</h3>
      {ideas.length ? (
        <ol className="muro-idea-timeline">
          {ideas.map((idea) => (
            <li key={`${idea.kind}:${idea.text}:${idea.at}`} style={theme(idea.kind)}>
              <div className="muro-idea-heading">
                <span className="muro-idea-kind">
                  <span aria-hidden="true">{COLORS[idea.kind][3]}</span>{" "}
                  {t(`ideas.kinds.${idea.kind}`)}
                </span>
                <time dateTime={idea.at}>{time.format(parseDate(idea.at))}</time>
              </div>
              <p className="muro-idea-text">{idea.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <>
          <p>{t("ideas.empty")}</p>
          <details className="muro-idea-help">
            <summary>{t("ideas.enable")}</summary>
            <p>CLAUDE.md / AGENTS.md</p>
            <pre>{t("ideas.setup")}</pre>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(t("ideas.setup"));
                  setCopyState("copied");
                } catch {
                  setCopyState("copyError");
                }
              }}
            >
              {t("ideas.copy")}
            </button>
            <span role="status">{copyState !== "copy" ? t(`ideas.${copyState}`) : ""}</span>
          </details>
        </>
      )}
    </section>
  );
}
