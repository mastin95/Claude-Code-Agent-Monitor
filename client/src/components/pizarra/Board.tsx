/**
 * @file Board.tsx
 * @description One agent's whiteboard for Dirección: title, notes, lists, charts, sandboxed
 *   mockups and code laid out on a grid, arrows drawn between related elements, and a popover
 *   on every element to zoom it, correct it live or call Claude or Codex about it. Also the
 *   small "photo" thumbnail the timeline shows for each finished board.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConductorAgentName, ConductorBoard, ConductorBoardElement } from "../../lib/types";

const NAMES: Record<ConductorAgentName, string> = { claude: "Claude", codex: "Codex" };
const SERIES = ["var(--pz-agent)", "#5B8DEF", "#8A94A6", "#E0A458", "#6FBFA8", "#B48EE0"];

/** Mockups are agent-written HTML: no scripts (empty sandbox) and no network (CSP). */
export function mockupDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>html,body{margin:0;font-family:system-ui,sans-serif}svg{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

/** Short human name for an element (status line, popover title). */
export function elementName(element: ConductorBoardElement): string {
  return (
    element.title ||
    (element.text && element.text.slice(0, 60)) ||
    element.items?.[0] ||
    element.kind
  );
}

function Chart({ chart }: { chart: NonNullable<ConductorBoardElement["chart"]> }) {
  const { labels, values, type, unit } = chart;
  const W = 300;
  const H = 150;
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  if (type === "pie") {
    const total = values.reduce((sum, v) => sum + Math.max(v, 0), 0) || 1;
    let angle = -Math.PI / 2;
    return (
      <div className="pz-chart pie">
        <svg
          viewBox="0 0 120 120"
          width="120"
          height="120"
          role="img"
          aria-label={labels.join(", ")}
        >
          {values.map((v, i) => {
            const slice = (Math.max(v, 0) / total) * Math.PI * 2;
            const a0 = angle;
            angle += slice;
            const large = slice > Math.PI ? 1 : 0;
            const p = (a: number) => `${60 + 54 * Math.cos(a)} ${60 + 54 * Math.sin(a)}`;
            const d =
              slice >= Math.PI * 2 - 1e-6
                ? "M 60 6 A 54 54 0 1 1 59.99 6 Z"
                : `M 60 60 L ${p(a0)} A 54 54 0 ${large} 1 ${p(angle)} Z`;
            return (
              <path
                key={i}
                d={d}
                fill={SERIES[i % SERIES.length]}
                stroke="#fff"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
        <ul>
          {labels.map((label, i) => (
            <li key={i}>
              <i style={{ background: SERIES[i % SERIES.length] }} />
              {label}{" "}
              <b>
                {values[i]}
                {unit ? ` ${unit}` : ""}
              </b>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const step = (W - 30) / labels.length;
  const y = (v: number) => H - 22 - (Math.max(v, 0) / max) * (H - 40);
  return (
    <svg className="pz-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={labels.join(", ")}>
      <line x1="24" y1={H - 22} x2={W - 4} y2={H - 22} stroke="#C9CDD3" />
      {type === "line" ? (
        <>
          <polyline
            fill="none"
            stroke="var(--pz-agent)"
            strokeWidth="2.5"
            points={values.map((v, i) => `${30 + step * i + step / 2},${y(v)}`).join(" ")}
          />
          {values.map((v, i) => (
            <circle
              key={i}
              cx={30 + step * i + step / 2}
              cy={y(v)}
              r="3.5"
              fill="var(--pz-agent)"
            />
          ))}
        </>
      ) : (
        values.map((v, i) => (
          <rect
            key={i}
            x={30 + step * i + step * 0.2}
            y={y(v)}
            width={step * 0.6}
            height={H - 22 - y(v)}
            rx="2"
            fill="var(--pz-agent)"
          />
        ))
      )}
      {values.map((v, i) => (
        <text
          key={`v${i}`}
          x={30 + step * i + step / 2}
          y={y(v) - 5}
          textAnchor="middle"
          fontSize="10"
          fill="#5A606B"
        >
          {v}
        </text>
      ))}
      {labels.map((label, i) => (
        <text
          key={`l${i}`}
          x={30 + step * i + step / 2}
          y={H - 7}
          textAnchor="middle"
          fontSize="10"
          fill="#5A606B"
        >
          {label.length > 10 ? `${label.slice(0, 9)}…` : label}
        </text>
      ))}
      {unit && (
        <text x="2" y="10" fontSize="10" fill="#5A606B">
          {unit}
        </text>
      )}
    </svg>
  );
}

function ElementBody({
  element,
  large = false,
}: {
  element: ConductorBoardElement;
  large?: boolean;
}) {
  const { t } = useTranslation("direccion");
  return (
    <>
      {element.kind !== "title" && element.title && <h4>{element.title}</h4>}
      {element.kind === "title" && <h3>{element.title || element.text}</h3>}
      {element.text && (element.kind !== "title" || element.title) && <p>{element.text}</p>}
      {element.items && (
        <ul>
          {element.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
      {element.chart && <Chart chart={element.chart} />}
      {element.html && (
        <iframe
          className="pz-mockup"
          data-large={large ? "1" : "0"}
          title={element.title || t("pizarra.mockup")}
          sandbox=""
          srcDoc={mockupDoc(element.html)}
          tabIndex={-1}
        />
      )}
      {element.code && <pre className="pz-code">{element.code}</pre>}
    </>
  );
}

interface Line {
  id: string;
  d: string;
  label?: string;
  lx: number;
  ly: number;
}

export function Board({
  board,
  prompt,
  onComment,
  onCall,
  canCall,
}: {
  board: ConductorBoard;
  prompt: string;
  onComment: (elementId: string | null, text: string) => Promise<void>;
  onCall: (elementId: string | null, agent: ConductorAgentName, text: string) => Promise<void>;
  canCall: boolean;
}) {
  const { t } = useTranslation("direccion");
  const wrap = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [focus, setFocus] = useState<{ id: string | null; top: number; left: number } | null>(null);
  const [zoom, setZoom] = useState<ConductorBoardElement | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const elements = board.elements.filter((e) => e.kind !== "arrow");
  const arrows = board.elements.filter((e) => e.kind === "arrow");
  const titles = elements.filter((e) => e.kind === "title");
  const cards = elements.filter((e) => e.kind !== "title");
  const drawing = board.status === "drafting";
  const pins = new Map<string, number[]>();
  board.comments.forEach((c, i) => {
    if (c.element_id) pins.set(c.element_id, [...(pins.get(c.element_id) || []), i + 1]);
  });

  // Arrows follow the laid-out cards; recompute when cards appear or the board resizes.
  const arrowKey = arrows.map((a) => `${a.from}>${a.to}`).join("|");
  useLayoutEffect(() => {
    const host = wrap.current;
    if (!host) return;
    const draw = () => {
      const base = host.getBoundingClientRect();
      const box = (id: string) => {
        const node = host.querySelector<HTMLElement>(`[data-el="${CSS.escape(id)}"]`);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
      };
      const next: Line[] = [];
      for (const arrow of arrows) {
        const a = box(arrow.from!);
        const b = box(arrow.to!);
        if (!a || !b) continue;
        const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
        const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        const horizontal = Math.abs(bc.x - ac.x) > Math.abs(bc.y - ac.y);
        const s = horizontal
          ? { x: ac.x + Math.sign(bc.x - ac.x) * (a.w / 2), y: ac.y }
          : { x: ac.x, y: ac.y + Math.sign(bc.y - ac.y) * (a.h / 2) };
        const e = horizontal
          ? { x: bc.x - Math.sign(bc.x - ac.x) * (b.w / 2 + 4), y: bc.y }
          : { x: bc.x, y: bc.y - Math.sign(bc.y - ac.y) * (b.h / 2 + 4) };
        const mx = (s.x + e.x) / 2;
        const my = (s.y + e.y) / 2;
        next.push({
          id: arrow.id,
          d: horizontal
            ? `M${s.x} ${s.y} C ${mx} ${s.y}, ${mx} ${e.y}, ${e.x} ${e.y}`
            : `M${s.x} ${s.y} C ${s.x} ${my}, ${e.x} ${my}, ${e.x} ${e.y}`,
          label: arrow.label,
          lx: mx,
          ly: my,
        });
      }
      setLines(next);
    };
    draw();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(draw) : null;
    observer?.observe(host);
    return () => observer?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrowKey, elements.length]);

  const open = (id: string | null, target: HTMLElement | null) => {
    const host = wrap.current;
    if (!host) return;
    const base = host.getBoundingClientRect();
    const r = target?.getBoundingClientRect();
    setNote("");
    setFocus({
      id,
      top: r ? r.bottom - base.top + 6 : 8,
      left: r ? Math.max(8, Math.min(r.left - base.left, base.width - 320)) : 8,
    });
  };
  const send = async (agent?: ConductorAgentName) => {
    if (!focus || !note.trim()) return;
    setSending(true);
    try {
      if (agent) await onCall(focus.id, agent, note.trim());
      else await onComment(focus.id, note.trim());
      setFocus(null);
      setNote("");
    } finally {
      setSending(false);
    }
  };
  const focused = focus?.id ? elements.find((e) => e.id === focus.id) || null : null;

  const card = (element: ConductorBoardElement) => (
    <div
      key={element.id}
      data-el={element.id}
      className="pz-el"
      data-kind={element.kind}
      data-focus={focus?.id === element.id ? "1" : "0"}
      role="button"
      tabIndex={0}
      aria-label={elementName(element)}
      onClick={(e) => {
        e.stopPropagation();
        open(element.id, e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(element.id, e.currentTarget);
        }
      }}
    >
      <ElementBody element={element} />
      {pins.get(element.id)?.map((n) => (
        <span key={n} className="pz-pin">
          {n}
        </span>
      ))}
    </div>
  );

  return (
    <div className="pz-board-frame" data-agent={board.agent}>
      <div className="pz-board-head">
        <span className="pz-board-tag">{t("pizarra.boardOf", { name: NAMES[board.agent] })}</span>
        <span className="pz-board-prompt" title={prompt}>
          {prompt}
        </span>
        <button
          type="button"
          className="pz-btn ghost small"
          onClick={(e) => {
            e.stopPropagation();
            open(null, null);
          }}
        >
          {drawing ? t("pizarra.commentBoard") : t("pizarra.askAboutBoard")}
        </button>
      </div>
      <div className="pz-board" ref={wrap} onClick={() => setFocus(null)}>
        <svg className="pz-arrows" aria-hidden="true">
          <defs>
            <marker
              id={`pz-ah-${board.id}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10z" fill="#6B7280" />
            </marker>
          </defs>
          {lines.map((line) => (
            <g key={line.id}>
              <path d={line.d} markerEnd={`url(#pz-ah-${board.id})`} />
              {line.label && (
                <text x={line.lx} y={line.ly - 4} textAnchor="middle">
                  {line.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        {titles.map(card)}
        <div className="pz-grid">{cards.map(card)}</div>
        {drawing && (
          <div className="pz-ghost" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
        {board.status === "error" && board.error && <p className="pz-error">{board.error}</p>}
        {!elements.length && !drawing && board.status === "waiting" && (
          <p className="pz-muted">{t("pizarra.waiting", { name: NAMES[board.agent] })}</p>
        )}
        {focus && (
          <div
            className="pz-pop"
            style={{ top: focus.top, left: focus.left }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={focused ? elementName(focused) : t("pizarra.wholeBoard")}
          >
            <b>{focused ? elementName(focused) : t("pizarra.wholeBoard")}</b>
            {focused && (
              <button type="button" className="pz-btn small" onClick={() => setZoom(focused)}>
                {t("pizarra.zoom")}
              </button>
            )}
            <textarea
              autoFocus
              rows={2}
              value={note}
              aria-label={drawing ? t("pizarra.correction") : t("pizarra.request")}
              placeholder={drawing ? t("pizarra.correction") : t("pizarra.request")}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(drawing ? undefined : board.agent);
                }
                if (e.key === "Escape") setFocus(null);
              }}
            />
            <div className="pz-pop-actions">
              {drawing ? (
                <button
                  type="button"
                  className="pz-btn primary small"
                  disabled={sending || !note.trim()}
                  onClick={() => void send()}
                >
                  {t("pizarra.sendTo", { name: NAMES[board.agent] })}
                </button>
              ) : (
                (["claude", "codex"] as ConductorAgentName[]).map((agent) => (
                  <button
                    key={agent}
                    type="button"
                    className="pz-btn small"
                    data-agent={agent}
                    disabled={sending || !note.trim() || !canCall}
                    onClick={() => void send(agent)}
                  >
                    {t("pizarra.askAgent", { name: NAMES[agent] })}
                  </button>
                ))
              )}
            </div>
            <small className="pz-muted">
              {drawing
                ? t("pizarra.correctionHint", { name: NAMES[board.agent] })
                : canCall
                  ? t("pizarra.requestHint")
                  : t("pizarra.busyHint")}
            </small>
          </div>
        )}
      </div>
      {board.comments.length > 0 && (
        <ol className="pz-comments">
          {board.comments.map((c, i) => (
            <li key={c.id} data-status={c.status}>
              <span className="pz-pin static">{i + 1}</span>
              <span>{c.text}</span>
              <small>{t(`pizarra.commentStatus.${c.status}`)}</small>
            </li>
          ))}
        </ol>
      )}
      {zoom && (
        <div className="pz-backdrop" onClick={() => setZoom(null)}>
          <div
            className="pz-dialog pz-zoom"
            data-agent={board.agent}
            role="dialog"
            aria-modal="true"
            aria-label={elementName(zoom)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pz-el" data-kind={zoom.kind}>
              <ElementBody element={zoom} large />
            </div>
            <button
              type="button"
              className="pz-btn primary"
              autoFocus
              onClick={() => setZoom(null)}
            >
              {t("picker.close")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The timeline's "photo" of a board: one grey block per element under the agent's colour. */
export function BoardThumb({ board, large = false }: { board: ConductorBoard; large?: boolean }) {
  const blocks = board.elements
    .filter((e) => e.kind !== "arrow" && e.kind !== "title")
    .slice(0, 12);
  return (
    <span
      className="pz-thumb"
      data-agent={board.agent}
      data-large={large ? "1" : "0"}
      data-status={board.status}
      aria-hidden="true"
    >
      <i className="pz-thumb-title" />
      <span className="pz-thumb-grid">
        {blocks.map((e) => (
          <i key={e.id} data-kind={e.kind} />
        ))}
      </span>
    </span>
  );
}
