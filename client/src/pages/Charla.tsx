/**
 * @file Charla.tsx
 * @description Design mockup of the "Charla" page: Claude's and Codex's conversations side by
 * side on one shared timeline, with hand-offs drawn across both columns. Uses sample data only.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import "@fontsource/bangers/400.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "../components/muro/charla.css";
import { Mascot } from "../components/muro/Mascot";

type Side = "claude" | "codex";
type Item =
  | { kind: "user"; side: Side; at: string; text: string }
  | { kind: "text"; side: Side; at: string; text: string }
  | { kind: "tools"; side: Side; at: string; tools: string[] }
  | { kind: "think"; side: Side; at: string; text?: string }
  | { kind: "idea"; side: Side; at: string; idea: string; text: string }
  | { kind: "handoff"; from: Side; at: string; text: string }
  | { kind: "result"; side: Side; at: string; text: string };

const ITEMS: Item[] = [
  {
    kind: "user",
    side: "claude",
    at: "17:32",
    text: "bastante mejor, me gusta",
  },
  { kind: "think", side: "claude", at: "17:33" },
  {
    kind: "text",
    side: "claude",
    at: "17:33",
    text: "Martin aprueba la versión 2. Preparo el encargo para Codex.",
  },
  { kind: "tools", side: "claude", at: "17:34", tools: ["Write encargo.md", "Bash git fetch"] },
  {
    kind: "handoff",
    from: "claude",
    at: "17:36",
    text: "Integra el estilo manga: fuentes locales, CSS en sus ficheros, color por columna",
  },
  {
    kind: "think",
    side: "codex",
    at: "17:37",
    text: "Primero miro qué reglas de manga.css pisan a las de board.css",
  },
  {
    kind: "tools",
    side: "codex",
    at: "17:38",
    tools: ["read board.css", "read manga.css", "rg muro-note"],
  },
  {
    kind: "idea",
    side: "codex",
    at: "17:41",
    idea: "Giro",
    text: "Color por columna en paper(), no con :has()",
  },
  {
    kind: "text",
    side: "codex",
    at: "17:44",
    text: "CSS repartido en 4 ficheros y manga.css eliminado. Ahora los tests.",
  },
  { kind: "tools", side: "codex", at: "17:46", tools: ["apply_patch ×6", "vitest -u"] },
  {
    kind: "idea",
    side: "claude",
    at: "17:48",
    idea: "Riesgo",
    text: "El sandbox de Codex no puede escribir en .git",
  },
  {
    kind: "text",
    side: "claude",
    at: "17:49",
    text: "Hago yo el commit y el PR; el código es de Codex.",
  },
  {
    kind: "handoff",
    from: "codex",
    at: "17:52",
    text: "Listo: 582/582 tests en verde, sin scroll horizontal",
  },
  {
    kind: "result",
    side: "claude",
    at: "17:53",
    text: "PR #10 abierto",
  },
  { kind: "think", side: "codex", at: "ahora", text: "Repasando el contraste de las píldoras…" },
];

function Column({ side }: { side: Side }) {
  const claude = side === "claude";
  return (
    <header className={`charla-head ${side}`}>
      <Mascot agent={side} mode={claude ? "wait" : "work"} size={64} reducedMotion={claude} />
      <div>
        <h2>{claude ? "Claude" : "Codex"}</h2>
        <p>
          <span className={`charla-state ${claude ? "idle" : "busy"}`}>
            {claude ? "Esperando a Codex" : "Trabajando"}
          </span>
          <span className="charla-chip">⏱ {claude ? "21 min" : "16 min"}</span>
          <span className="charla-chip">⚡ {claude ? "312k" : "682k"}</span>
        </p>
      </div>
    </header>
  );
}

function Bubble({ item }: { item: Exclude<Item, { kind: "handoff" }> }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="charla-bubble user">
          <b>Martin</b>
          {item.text}
        </div>
      );
    case "text":
      return <div className="charla-bubble say">{item.text}</div>;
    case "tools":
      return (
        <div className="charla-tools">
          {item.tools.map((tool) => (
            <span key={tool}>🔧 {tool}</span>
          ))}
        </div>
      );
    case "think":
      return (
        <div className={`charla-think${item.at === "ahora" ? " live" : ""}`}>
          {item.text ? item.text : <i aria-label="pensando">• • •</i>}
        </div>
      );
    case "idea":
      return (
        <div className={`charla-idea ${item.idea.toLowerCase()}`}>
          <b>{item.idea}</b>
          {item.text}
        </div>
      );
    case "result":
      return <div className="charla-result">🎉 {item.text}</div>;
  }
}

export function Charla() {
  return (
    <div className="charla-page animate-fade-in">
      <div className="charla-top">
        <h1>Charla en directo</h1>
        <button type="button" className="charla-pick">
          ✈ Encargo: <b>Muro estilo manga</b> ▾
        </button>
        <label className="charla-toggle">
          <input type="checkbox" defaultChecked /> Herramientas
        </label>
      </div>
      <div className="charla-board">
        <div className="charla-grid">
          <Column side="claude" />
          <Column side="codex" />
          {ITEMS.map((item, index) =>
            item.kind === "handoff" ? (
              <div key={index} className={`charla-handoff from-${item.from}`}>
                <time>{item.at}</time>
                <span className="charla-plane">{item.from === "claude" ? "✈ ➜" : "⬅ ✈"}</span>
                <span>
                  <b>{item.from === "claude" ? "Claude → Codex" : "Codex → Claude"}</b>
                  {item.text}
                </span>
              </div>
            ) : (
              <div key={index} className={`charla-row ${item.side}`}>
                <time>{item.at}</time>
                <Bubble item={item} />
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
