/**
 * @file Charla.tsx
 * @description Design mockup of the "Charla" page: Claude's and Codex's full conversations side by
 * side, each column read like its own app (reasoning, messages, commands with output, file diffs),
 * with hand-offs marked in both columns. Uses sample data only.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import "@fontsource/bangers/400.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "../components/muro/charla.css";
import "../components/muro/charla-fx.css";
import "../components/muro/charla-pro.css";
import { Mascot } from "../components/muro/Mascot";

type Side = "claude" | "codex";
type Entry =
  | { kind: "user"; at: string; who: string; text: string }
  | { kind: "think"; at: string; secs: number; text?: string; open?: boolean }
  | { kind: "say"; at: string; text: string[] }
  | { kind: "cmd"; at: string; cmd: string; out: string[]; ok?: boolean }
  | { kind: "diff"; at: string; file: string; add: number; del: number; lines: string[] }
  | { kind: "read"; at: string; files: string[] }
  | { kind: "handoff"; at: string; dir: "out" | "in"; text: string }
  | { kind: "live"; text: string };

const CLAUDE: Entry[] = [
  { kind: "user", at: "17:32", who: "Martin", text: "bastante mejor, me gusta" },
  { kind: "think", at: "17:32", secs: 6 },
  {
    kind: "say",
    at: "17:33",
    text: [
      "Martin aprueba la **versión 2**. Toca pasarla a código de verdad, y eso lo hace Codex.",
      "Antes de encargarlo dejo por escrito qué hay que cambiar para que no tenga que adivinar:",
      "• fuentes locales en vez de Google Fonts\n• repartir manga.css en sus ficheros\n• color del post-it según la columna",
    ],
  },
  {
    kind: "diff",
    at: "17:34",
    file: "colaboracion/encargo-muro-manga.md",
    add: 48,
    del: 0,
    lines: [
      "+# Encargo para Codex: Muro estilo manga (v2)",
      "+1. Fuentes locales: @fontsource/bangers y nunito",
      "+2. Integra el CSS en stage, board, handoffs e ideas",
      "+3. paper() depende de la columna",
    ],
  },
  {
    kind: "cmd",
    at: "17:35",
    cmd: "git fetch origin claude/project-thread-qzy1g1",
    out: ["From github.com:mastin95/Claude-Code-Agent-Monitor", " * branch  claude/project-thread-qzy1g1 -> FETCH_HEAD"],
    ok: true,
  },
  {
    kind: "handoff",
    at: "17:36",
    dir: "out",
    text: "Integra el estilo manga: fuentes locales, CSS en sus ficheros, color por columna",
  },
  { kind: "think", at: "17:48", secs: 4 },
  {
    kind: "say",
    at: "17:48",
    text: [
      "Codex no puede escribir en `.git` desde su sandbox (`index.lock: Permission denied`).",
      "El código es suyo; yo hago el commit, el push y el PR.",
    ],
  },
  {
    kind: "cmd",
    at: "17:51",
    cmd: "npm run verify",
    out: ["✓ headers  ✓ format  ✓ typecheck", "server  1493 ok · 0 fallos", "client  582/582"],
    ok: true,
  },
  { kind: "handoff", at: "17:52", dir: "in", text: "Listo: tests en verde, sin scroll horizontal" },
  {
    kind: "say",
    at: "17:53",
    text: ["PR #10 abierto contra master. Lo reviso en el navegador antes de fusionar."],
  },
];

const CODEX: Entry[] = [
  {
    kind: "user",
    at: "17:36",
    who: "Claude",
    text: "Encargo: Muro estilo manga (v2). Crea feat/muro-manga desde master, trae la maqueta y conviértela en código de producción…",
  },
  {
    kind: "think",
    at: "17:37",
    secs: 41,
    open: true,
    text: "**Entender qué pisa a qué.** La maqueta mete manga.css encima de todo con !important y selectores sobre clases de Tailwind. Si lo copio tal cual, cualquier cambio futuro en board.css quedará tapado. Mejor ver regla a regla qué sustituye a qué y mover cada una a su fichero.\n\n**El color por columna.** La maqueta lo resuelve con :has(.muro-mascot[data-mode]), pero paper() ya decide el color en model.ts. Cambiarlo ahí deja el CSS más simple y la ficha hereda el mismo color.",
  },
  { kind: "read", at: "17:38", files: ["board.css", "manga.css", "model.ts", "PostIt.tsx"] },
  {
    kind: "cmd",
    at: "17:39",
    cmd: "rg -n \"muro-note|paper\\(\" client/src",
    out: ["components/muro/model.ts:36: export function paper(", "components/muro/PostIt.tsx:58: \"--paper\": paper(", "components/muro/board.css:61: .muro-note {"],
  },
  {
    kind: "diff",
    at: "17:41",
    file: "client/src/components/muro/model.ts",
    add: 2,
    del: 1,
    lines: [
      "-  return lane === \"waiting\" ? \"#F6E7A6\" : agent === \"claude\" ? \"#FFCFB0\" : \"#AEE8DE\";",
      "+  return lane === \"working\" ? \"#FFE14D\" : lane === \"waiting\" ? \"#FFA8D2\" : \"#9DEBAB\";",
    ],
  },
  {
    kind: "say",
    at: "17:44",
    text: [
      "CSS repartido en `stage.css`, `board.css`, `handoffs.css` e `ideas.css`; `manga.css` eliminado.",
      "Quedan los tests: la cinta de encargos cambió de estructura.",
    ],
  },
  {
    kind: "cmd",
    at: "17:46",
    cmd: "npx vitest run src/components/muro",
    out: ["✗ Handoffs.test.tsx > shows status pills", "  Unable to find text /^Working ·/", "Tests  1 failed | 41 passed"],
    ok: false,
  },
  {
    kind: "think",
    at: "17:47",
    secs: 12,
    open: true,
    text: "El sello ahora tiene dos líneas: el estado en <b> y la duración en <small>. El test buscaba «Working ·» en un solo texto; lo busco por partes.",
  },
  { kind: "handoff", at: "17:52", dir: "out", text: "Listo: 582/582 tests en verde, sin scroll horizontal" },
  { kind: "live", text: "Repasando el contraste de las píldoras de estado…" },
];

function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith("**") ? (
      <b key={index}>{part.slice(2, -2)}</b>
    ) : part.startsWith("`") ? (
      <code key={index}>{part.slice(1, -1)}</code>
    ) : (
      part
    )
  );
}

function EntryView({ entry, side }: { entry: Entry; side: Side }) {
  const other = side === "claude" ? "Codex" : "Claude";
  switch (entry.kind) {
    case "user":
      return (
        <div className={`ch-user${entry.who === "Martin" ? " martin" : ""}`}>
          <header>
            <b>{entry.who}</b>
            <time>{entry.at}</time>
          </header>
          <p>{entry.text}</p>
        </div>
      );
    case "think":
      return (
        <details className="ch-think" open={entry.open}>
          <summary>
            <span className="ch-tag">💭 Pensó {entry.secs} s</span>
            <time>{entry.at}</time>
          </summary>
          {entry.text ? (
            entry.text.split("\n\n").map((paragraph, index) => <p key={index}>{rich(paragraph)}</p>)
          ) : (
            <p className="ch-muted">Claude no guarda el texto de su razonamiento, solo cuánto pensó.</p>
          )}
        </details>
      );
    case "say":
      return (
        <div className="ch-say">
          <span className="ch-tag">{side === "claude" ? "💬 Para ti" : "💬 Para Claude"}</span>
          {entry.text.map((paragraph, index) => (
            <p key={index}>{rich(paragraph)}</p>
          ))}
          <time>{entry.at}</time>
        </div>
      );
    case "cmd":
      return (
        <div className={`ch-cmd${entry.ok === false ? " fail" : ""}`}>
          <header>
            <span>{entry.ok === false ? "✗" : "▶"} Comando</span>
            <time>{entry.at}</time>
          </header>
          <pre className="ch-cmdline">$ {entry.cmd}</pre>
          <pre className="ch-out">{entry.out.join("\n")}</pre>
        </div>
      );
    case "diff":
      return (
        <div className="ch-diff">
          <header>
            <span>✎ {entry.file}</span>
            <span className="ch-diffstat">
              <i className="add">+{entry.add}</i> <i className="del">−{entry.del}</i>
            </span>
          </header>
          <pre>
            {entry.lines.map((line, index) => (
              <span key={index} className={line.startsWith("+") ? "add" : "del"}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      );
    case "read":
      return (
        <div className="ch-read">
          📖 Leyó {entry.files.map((file) => <code key={file}>{file}</code>)}
          <time>{entry.at}</time>
        </div>
      );
    case "handoff":
      return (
        <div className={`ch-handoff ${entry.dir}`}>
          <b>{entry.dir === "out" ? `✈ Enviado a ${other}` : `✈ Recibido de ${other}`}</b>
          <p>{entry.text}</p>
          <time>{entry.at}</time>
        </div>
      );
    case "live":
      return (
        <div className="ch-live">
          <span className="ch-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {entry.text}
        </div>
      );
  }
}

function Column({ side, entries }: { side: Side; entries: Entry[] }) {
  const claude = side === "claude";
  return (
    <section className={`ch-col ${side}`} aria-label={claude ? "Conversación de Claude" : "Conversación de Codex"}>
      <header className="ch-head">
        <Mascot agent={side} mode={claude ? "wait" : "work"} size={60} reducedMotion={claude} />
        <div>
          <h2>{claude ? "Claude" : "Codex"}</h2>
          <p>
            <span className={`ch-state ${claude ? "idle" : "busy"}`}>
              {claude ? "Esperando a Codex" : "Trabajando"}
            </span>
            <span className="ch-chip">{claude ? "Opus · alto" : "astra · medio"}</span>
            <span className="ch-chip">⚡ {claude ? "312k" : "682k"}</span>
          </p>
        </div>
      </header>
      <div className="ch-feed">
        {entries.map((entry, index) => (
          <EntryView key={index} entry={entry} side={side} />
        ))}
      </div>
    </section>
  );
}

export function Charla() {
  // Mockup only: ?fx=glass|neon|gradient previews the visual effect options.
  const fx = new URLSearchParams(window.location.search).get("fx") ?? undefined;
  return (
    <div className="charla-page animate-fade-in" data-fx={fx}>
      <div className="charla-top">
        <h1>Charla en directo</h1>
        <button type="button" className="charla-pick">
          ✈ Encargo: <b>Muro estilo manga</b> ▾
        </button>
        <div className="charla-filters" role="group" aria-label="Mostrar">
          <button type="button" aria-pressed="true">💭 Razonamiento</button>
          <button type="button" aria-pressed="true">▶ Comandos</button>
          <button type="button" aria-pressed="true">✎ Cambios</button>
        </div>
      </div>
      <div className="ch-cols">
        <Column side="claude" entries={CLAUDE} />
        <Column side="codex" entries={CODEX} />
      </div>
    </div>
  );
}
