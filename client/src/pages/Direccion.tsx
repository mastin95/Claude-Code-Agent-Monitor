/**
 * @file Direccion.tsx
 * @description Mockup of the "Dirección" screen: the dashboard as conductor of Claude and Codex (two layout variants via ?v=).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useLocation } from "react-router";
import { Mascot } from "../components/muro/Mascot";
import "@fontsource/bangers/400.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "../components/muro/direccion.css";

type Agent = "claude" | "codex";

const LEAD: Agent = "claude";

const AGENTS: Record<Agent, { name: string; model: string; effort: string; doing: string; tokens: string }> =
  {
    claude: {
      name: "Claude",
      model: "claude-opus-5-5",
      effort: "alto",
      doing: "Revisando lo que ha hecho Codex",
      tokens: "61k",
    },
    codex: {
      name: "Codex",
      model: "gpt-6-astra",
      effort: "medio",
      doing: "Corrigiendo el test que falla",
      tokens: "38k",
    },
  };

const ENCARGO = {
  n: 3,
  from: "claude" as Agent,
  to: "codex" as Agent,
  text: "Que el papel no tape la burbuja de Codex en pantallas estrechas.",
  since: "hace 4 min",
};

const APROBACIONES = [
  { who: "codex" as Agent, what: "Quiere ejecutar `npm install`", why: "Falta una dependencia nueva." },
  { who: "claude" as Agent, what: "Propone un plan de 3 pasos", why: "Avión, burbuja y pruebas." },
];

const PARTITURA = [
  { t: "09:30", who: "martin", kind: "orden", text: "Añade el avión de papel entre los dos personajes mientras haya un encargo." },
  { t: "09:31", who: "claude", kind: "plan", text: "Plan: 1 avión, 2 burbuja, 3 pruebas." },
  { t: "09:33", who: "claude", kind: "encargo", text: "Encargo 1 → Codex: dibuja el avión." },
  { t: "09:41", who: "codex", kind: "hecho", text: "Hecho: avión con el título y «hace N min»." },
  { t: "09:42", who: "claude", kind: "encargo", text: "Encargo 2 → Codex: respeta el movimiento reducido." },
  { t: "09:50", who: "codex", kind: "hecho", text: "Hecho. 41 tests en verde." },
  { t: "09:52", who: "claude", kind: "encargo", text: "Encargo 3 → Codex: que no tape la burbuja." },
  { t: "09:56", who: "codex", kind: "ok", text: "Pide tu OK para `npm install`." },
];

function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className="dir-chip" data-tone={tone}>
      {children}
    </span>
  );
}

function LeadPicker() {
  return (
    <div className="dir-lead" role="radiogroup" aria-label="Jefe de proyecto">
      <span className="dir-label">Jefe</span>
      {(["claude", "codex"] as Agent[]).map((a) => (
        <button key={a} className="dir-lead-tile" data-agent={a} role="radio" aria-checked={a === LEAD}>
          <Mascot agent={a} mode="done" size={44} reducedMotion />
          <span>{AGENTS[a].name}</span>
          {a === LEAD && <b className="dir-baton">★ JEFE</b>}
        </button>
      ))}
    </div>
  );
}

function ProjectPicker() {
  return (
    <div className="dir-project">
      <span className="dir-label">Proyecto</span>
      <button className="dir-folder">📁 Card_Game ▾</button>
      <button className="dir-new">＋ Nuevo</button>
    </div>
  );
}

function OrderBox({ cta, placeholder }: { cta: string; placeholder: string }) {
  return (
    <div className="dir-order">
      <div className="dir-order-bubble">
        <textarea rows={3} placeholder={placeholder} />
      </div>
      <button className="dir-cta">{cta}</button>
    </div>
  );
}

function AgentCard({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const a = AGENTS[agent];
  return (
    <div className="dir-agent" data-agent={agent} data-compact={compact ? "1" : "0"}>
      <Mascot agent={agent} mode="work" size={compact ? 56 : 96} />
      <div className="dir-agent-body">
        <h3>
          {a.name} {agent === LEAD && <b className="dir-baton">★ JEFE</b>}
        </h3>
        <p className="dir-bubble">{a.doing}</p>
        <div className="dir-chips">
          <Chip>{a.model}</Chip>
          <Chip tone="effort">esfuerzo {a.effort}</Chip>
          <Chip tone="tok">{a.tokens} tokens</Chip>
        </div>
      </div>
    </div>
  );
}

function EncargoCard() {
  return (
    <div className="dir-encargo">
      <div className="dir-plane">✈️</div>
      <h4>
        Encargo {ENCARGO.n} · {AGENTS[ENCARGO.from].name} → {AGENTS[ENCARGO.to].name}
      </h4>
      <p>{ENCARGO.text}</p>
      <span className="dir-stamp">¡ZAS!</span>
      <small>{ENCARGO.since}</small>
    </div>
  );
}

function Approvals({ title }: { title: string }) {
  return (
    <section className="dir-ok">
      <h2 className="dir-title">{title}</h2>
      <div className="dir-ok-cards">
        {APROBACIONES.map((p, i) => (
          <article key={i} className="dir-ok-card" data-agent={p.who}>
            <Mascot agent={p.who} mode="done" size={48} reducedMotion />
            <div>
              <h4>
                {AGENTS[p.who].name} {p.what}
              </h4>
              <p>{p.why}</p>
            </div>
            <div className="dir-ok-actions">
              <button className="dir-yes">✅ Aprobar</button>
              <button className="dir-change">✏️ Cambiar</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Partitura() {
  return (
    <section className="dir-score">
      <h2 className="dir-title">Partitura</h2>
      <ol>
        {PARTITURA.map((row, i) => (
          <li key={i} data-kind={row.kind} data-who={row.who}>
            <time>{row.t}</time>
            <span className="dir-dot" />
            <div className="dir-score-text">
              <b>{row.kind === "orden" ? "Tu orden" : row.kind === "plan" ? "Plan" : row.kind === "encargo" ? "Encargo" : row.kind === "hecho" ? "¡Hecho!" : "Tu OK"}</b>
              <span>{row.text}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Vinetas() {
  const panels = [
    { n: 1, who: "martin", title: "Tu orden", text: "Añade el avión de papel entre los dos personajes." },
    { n: 2, who: "claude", title: "Plan", text: "1 avión · 2 burbuja · 3 pruebas" },
    { n: 3, who: "claude", title: "Encargo → Codex", text: "Dibuja el avión." },
    { n: 4, who: "codex", title: "Codex trabaja", text: "$ npx vitest run\n41 passed", mono: true },
    { n: 5, who: "claude", title: "Revisión", text: "«Que no tape la burbuja.»" },
    { n: 6, who: "codex", title: "¡HECHO!", text: "Avión listo, tests en verde.", done: true },
  ];
  return (
    <section className="dir-comic">
      <h2 className="dir-title">Capítulo 3 · El avión de papel</h2>
      <div className="dir-comic-grid">
        {panels.map((p) => (
          <article key={p.n} className="dir-panel" data-who={p.who} data-done={p.done ? "1" : "0"}>
            <span className="dir-panel-n">{p.n}</span>
            <h4>{p.title}</h4>
            {p.mono ? <pre>{p.text}</pre> : <p className="dir-bubble">{p.text}</p>}
            {p.who !== "martin" && (
              <div className="dir-panel-mascot">
                <Mascot agent={p.who as Agent} mode={p.done ? "done" : "work"} size={40} reducedMotion />
              </div>
            )}
            {p.done && <span className="dir-stamp big">¡HECHO!</span>}
          </article>
        ))}
      </div>
    </section>
  );
}

export function Direccion() {
  const v = new URLSearchParams(useLocation().search).get("v") === "vinetas" ? "vinetas" : "batuta";
  return (
    <main className="dir-page" data-v={v}>
      {v === "batuta" ? (
        <>
          <header className="dir-head">
            <h1 className="dir-h1">Dirección</h1>
            <ProjectPicker />
            <LeadPicker />
          </header>
          <section className="dir-atril">
            <h2 className="dir-title">Tu orden</h2>
            <OrderBox cta="¡A ESCENA!" placeholder="Dime qué quieres y lo reparto…" />
            <span className="dir-onoma">¡TACHÁN!</span>
          </section>
          <section className="dir-stage">
            <AgentCard agent="claude" />
            <EncargoCard />
            <AgentCard agent="codex" />
          </section>
          <Approvals title="Tu OK" />
          <Partitura />
          <footer className="dir-foot">
            <input placeholder="Nueva indicación para el jefe…" />
            <button className="dir-cta small">Enviar</button>
          </footer>
        </>
      ) : (
        <>
          <header className="dir-cover">
            <h1 className="dir-h1">Dirección</h1>
            <ProjectPicker />
            <LeadPicker />
            <button className="dir-cta">¡ACCIÓN!</button>
          </header>
          <section className="dir-scoreboard">
            <AgentCard agent="claude" compact />
            <AgentCard agent="codex" compact />
          </section>
          <section className="dir-alert">
            <h2 className="dir-title">¡ALTO! Tu OK</h2>
            <div className="dir-ok-cards">
              {APROBACIONES.map((p, i) => (
                <article key={i} className="dir-ok-card" data-agent={p.who}>
                  <Mascot agent={p.who} mode="done" size={44} reducedMotion />
                  <div>
                    <h4>
                      {AGENTS[p.who].name} {p.what}
                    </h4>
                  </div>
                  <div className="dir-ok-actions">
                    <button className="dir-yes">✅</button>
                    <button className="dir-change">✏️</button>
                  </div>
                </article>
              ))}
              <EncargoCard />
            </div>
          </section>
          <Vinetas />
          <footer className="dir-foot teal">
            <input placeholder="Tu bocadillo: orden o indicación…" />
            <button className="dir-cta small">Enviar</button>
          </footer>
        </>
      )}
    </main>
  );
}
