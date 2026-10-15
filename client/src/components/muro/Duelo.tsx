/**
 * @file Duelo.tsx
 * @description «¡Duelo de propuestas!» for Dirección: Claude's and Codex's pitches side by side as idea cards (colours, sandboxed HTML mockups, features, plan), a «Me lo quedo» toggle per card and the mix tray that turns Martin's picks into the lead's order.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mascot } from "./Mascot";
import type {
  ConductorAgentName,
  ConductorPitch,
  ConductorPitchCard,
  ConductorPitchPick,
} from "../../lib/types";

const AGENTS: ConductorAgentName[] = ["claude", "codex"];
const NAMES: Record<ConductorAgentName, string> = { claude: "Claude", codex: "Codex" };

/** Mockups are agent-written HTML: no scripts (empty sandbox) and no network (CSP). */
export function mockupDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>html,body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${html}</body></html>`;
}

export const pickKey = (pick: ConductorPitchPick) => `${pick.agent}:${pick.index}`;

function Mockup({ label, html, onZoom }: { label: string; html: string; onZoom: () => void }) {
  const { t } = useTranslation("direccion");
  return (
    <figure className="duel-shot">
      <button
        type="button"
        className="duel-shot-frame"
        onClick={onZoom}
        aria-label={t("duel.zoom", { label })}
      >
        <iframe title={label} sandbox="" srcDoc={mockupDoc(html)} tabIndex={-1} loading="lazy" />
      </button>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function Card({
  card,
  agent,
  picked,
  onToggle,
  onZoom,
}: {
  card: ConductorPitchCard;
  agent: ConductorAgentName;
  picked: boolean;
  onToggle: () => void;
  onZoom: (label: string, html: string) => void;
}) {
  const { t } = useTranslation("direccion");
  return (
    <article
      className="duel-card"
      data-kind={card.kind}
      data-agent={agent}
      data-picked={picked ? "1" : "0"}
    >
      <header>
        <span className="duel-kind">{t(`duel.kind.${card.kind}`)}</span>
        <button type="button" className="duel-keep" aria-pressed={picked} onClick={onToggle}>
          {picked ? t("duel.kept") : t("duel.keep")}
        </button>
      </header>
      <h4>{card.title}</h4>
      {card.swatches?.length ? (
        <div className="duel-swatches" aria-label={card.swatches.join(", ")}>
          {card.swatches.map((color) => (
            <span key={color} style={{ background: color }} title={color} />
          ))}
        </div>
      ) : null}
      {card.body && <p>{card.body}</p>}
      {card.screens?.length ? (
        <div className="duel-shots">
          {card.screens.map((screen) => (
            <Mockup
              key={screen.label}
              label={screen.label}
              html={screen.html}
              onZoom={() => onZoom(screen.label, screen.html)}
            />
          ))}
        </div>
      ) : null}
      {card.items?.length ? (
        <ul className="duel-chips">
          {card.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {card.steps?.length ? (
        <ol className="duel-steps">
          {card.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}

export function Duelo({
  pitch,
  picks,
  onToggle,
  onOrder,
  onDiscard,
  busy,
  locked,
}: {
  pitch: ConductorPitch;
  picks: ConductorPitchPick[];
  onToggle: (pick: ConductorPitchPick) => void;
  onOrder: (note: string) => void;
  onDiscard: () => void;
  busy: boolean;
  locked: boolean;
}) {
  const { t } = useTranslation("direccion");
  const [note, setNote] = useState("");
  const [zoom, setZoom] = useState<{ label: string; html: string } | null>(null);
  const kept = new Set(picks.map(pickKey));
  const count = (agent: ConductorAgentName) => picks.filter((p) => p.agent === agent).length;
  const drafting = pitch.status === "drafting";

  return (
    <section className="duel" aria-label={t("duel.title")}>
      <header className="duel-head">
        <h2 className="dir-title">{t("duel.title")}</h2>
        <span className="duel-sub">{drafting ? t("duel.drafting") : t("duel.sub")}</span>
        <button type="button" className="dir-change" onClick={onDiscard}>
          {drafting ? t("duel.stop") : t("duel.discard")}
        </button>
      </header>
      <p className="duel-idea">{pitch.idea}</p>

      <div className="duel-sides">
        {AGENTS.map((agent) => {
          const side = pitch[agent];
          return (
            <div key={agent} className="duel-side" data-agent={agent}>
              <div className="duel-banner">
                <Mascot
                  agent={agent}
                  mode={
                    side.status === "drafting" ? "work" : side.status === "ready" ? "done" : "wait"
                  }
                  size={64}
                  reducedMotion={side.status !== "drafting"}
                />
                <div>
                  <small>{t("duel.of", { name: NAMES[agent] })}</small>
                  <b>
                    {side.pitch?.name ||
                      (side.status === "drafting" ? t("duel.thinking") : t("duel.failed"))}
                  </b>
                  {side.pitch?.tagline && <span>{side.pitch.tagline}</span>}
                </div>
              </div>
              {side.status === "drafting" && <p className="duel-wait">{t("duel.wait")}</p>}
              {side.status === "error" && (
                <p className="duel-error" role="status">
                  {side.error || t("duel.failed")}
                </p>
              )}
              {side.pitch?.cards.map((card, index) => (
                <Card
                  key={`${agent}-${index}`}
                  card={card}
                  agent={agent}
                  picked={kept.has(pickKey({ agent, index }))}
                  onToggle={() => onToggle({ agent, index })}
                  onZoom={(label, html) => setZoom({ label, html })}
                />
              ))}
            </div>
          );
        })}
        <span className="duel-vs" aria-hidden="true">
          VS
        </span>
      </div>

      {pitch.status === "ready" && (
        <form
          className="duel-tray"
          onSubmit={(event) => {
            event.preventDefault();
            if (picks.length) onOrder(note.trim());
          }}
        >
          <b className="duel-tray-title">{t("duel.mix")}</b>
          <span className="duel-count" data-agent="claude">
            {t("duel.count", { count: count("claude"), name: "Claude" })}
          </span>
          <span className="duel-count" data-agent="codex">
            {t("duel.count", { count: count("codex"), name: "Codex" })}
          </span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            aria-label={t("duel.note")}
            placeholder={t("duel.note")}
          />
          <span className="duel-lead">{t("duel.lead")}</span>
          <button className="dir-cta" disabled={busy || locked || !picks.length}>
            {t("order.cta")}
          </button>
          {!picks.length && <small>{t("duel.pickSome")}</small>}
          {locked && <small>{t("order.busy")}</small>}
        </form>
      )}

      {zoom && (
        <div className="duel-zoom" role="dialog" aria-modal="true" aria-label={zoom.label}>
          <div>
            <iframe title={zoom.label} sandbox="" srcDoc={mockupDoc(zoom.html)} />
            <button type="button" className="dir-cta small" onClick={() => setZoom(null)} autoFocus>
              {t("duel.close")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
