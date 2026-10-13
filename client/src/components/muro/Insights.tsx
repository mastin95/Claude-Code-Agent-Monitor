/**
 * @file Insights.tsx
 * @description Animated Muro totals and accessible SVG charts from scoped server summaries.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatMs, getCurrentLocale } from "../../lib/format";
import type { MuroCounts, MuroPeriod, MuroSummary } from "../../lib/types";
import type { MuroAgent } from "./Mascot";
import { useReducedMotion } from "./motion";
import "./insights.css";

const AGENTS = ["claude", "codex"] as const;
export const AGENT_COLORS = { claude: "#D46F3A", codex: "#2BA394" };
const NAMES = { claude: "Claude", codex: "Codex" };
const duration = formatMs;

function Counter({ value, format }: { value: number; format: (value: number) => string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const previous = useRef(0);
  useEffect(() => {
    if (reduced) {
      previous.current = value;
      setShown(value);
      return;
    }
    const from = previous.current;
    setShown(from);
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / 900));
      const next = Math.round(from + (value - from) * (1 - Math.pow(1 - progress, 3)));
      previous.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  // Assistive technology reads the final count once, not every animation frame.
  return (
    <span aria-label={format(value)}>
      <span aria-hidden="true">{format(reduced ? value : shown)}</span>
    </span>
  );
}

function Split({ counts, label }: { counts: MuroCounts; label: string }) {
  const total = counts.claude + counts.codex || 1;
  return (
    <div className="muro-split" role="img" aria-label={label} title={label}>
      {AGENTS.map((agent) => (
        <i
          key={agent}
          style={{ width: `${(counts[agent] / total) * 100}%`, background: AGENT_COLORS[agent] }}
        />
      ))}
    </div>
  );
}

export function Kpis({ summary }: { summary: MuroSummary }) {
  const { t } = useTranslation("muro");
  const number = new Intl.NumberFormat(getCurrentLocale());
  const compact = new Intl.NumberFormat(getCurrentLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const metrics = ["tasks_completed", "tokens", "time_worked_ms"] as const;
  const formats = [number.format, compact.format, duration];
  // Streak is not additive. Its split describes each agent's completions in the
  // visible streak window, while the exact day count always comes from the API.
  const days = [...summary.heatmap];
  if (days.length && days[days.length - 1]!.claude + days[days.length - 1]!.codex === 0) days.pop();
  const streakCounts = days
    .slice(Math.max(0, days.length - summary.streak_days))
    .reduce((sum, day) => ({ claude: sum.claude + day.claude, codex: sum.codex + day.codex }), {
      claude: 0,
      codex: 0,
    });
  return (
    <section className="muro-kpis" aria-label={t("insights.label")}>
      {metrics.map((metric, index) => {
        const counts = {
          claude: summary.totals.claude[metric],
          codex: summary.totals.codex[metric],
        };
        const detail = `Claude ${formats[index]!(counts.claude)} · Codex ${formats[index]!(counts.codex)}`;
        return (
          <div className="muro-kpi" key={metric}>
            <h2>{t(`insights.${metric}`)}</h2>
            <div className="muro-kpi-value">
              <Counter value={counts.claude + counts.codex} format={formats[index]!} />
            </div>
            <Split counts={counts} label={detail} />
            <p>{detail}</p>
          </div>
        );
      })}
      <div className="muro-kpi">
        <h2>{t("insights.streak")}</h2>
        <div className="muro-kpi-value">
          <Counter value={summary.streak_days} format={number.format} />
          <small>{t("insights.days")}</small>
        </div>
        <Split
          counts={streakCounts}
          label={t("insights.streakSplit", {
            claude: number.format(streakCounts.claude),
            codex: number.format(streakCounts.codex),
          })}
        />
        <p>{t("insights.streakHint")}</p>
      </div>
    </section>
  );
}

/** Group the thirty daily buckets in chronological, consecutive blocks of three. */
export function rhythmBuckets(summary: MuroSummary) {
  const size = summary.period === "30d" ? 3 : 1;
  const buckets: Array<MuroCounts & { start: string; end: string }> = [];
  for (let index = 0; index < summary.series.buckets.length; index += size) {
    const group = summary.series.buckets.slice(index, index + size);
    buckets.push({
      start: group[0]!.bucket,
      end: group[group.length - 1]!.bucket,
      claude: group.reduce((sum, item) => sum + item.claude, 0),
      codex: group.reduce((sum, item) => sum + item.codex, 0),
    });
  }
  return buckets;
}

// Summary dates are local calendar labels, not UTC instants. Noon avoids DST gaps.
const localDate = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00`);
function bucketLabel(bucket: string, period: MuroPeriod, short = false) {
  if (period === "today") return `${bucket.slice(11, 13)}:00`;
  return new Intl.DateTimeFormat(
    getCurrentLocale(),
    short
      ? { day: "numeric", month: "numeric" }
      : { day: "numeric", month: "short", year: "numeric" }
  ).format(localDate(bucket));
}

type Tip = { x: number; y: number; content: ReactNode } | null;
export function Charts({
  summary,
  agentFilter,
  product,
  onFilter,
  onHighlight,
}: {
  summary: MuroSummary;
  agentFilter: MuroAgent | null;
  product: string;
  onFilter: (agent: MuroAgent) => void;
  onHighlight: (agent: MuroAgent | null) => void;
}) {
  const { t } = useTranslation("muro");
  const [hover, setHover] = useState<MuroAgent | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  const number = new Intl.NumberFormat(getCurrentLocale());
  const counts = {
    claude: summary.totals.claude.tasks_completed,
    codex: summary.totals.codex.tasks_completed,
  };
  const total = counts.claude + counts.codex;
  const highlight = (agent: MuroAgent | null) => {
    setHover(agent);
    onHighlight(agent);
  };
  useEffect(() => {
    setTip(null);
    setHover(null);
    onHighlight(null);
    return () => onHighlight(null);
  }, [summary, onHighlight]);
  const tooltip = (content: ReactNode) => ({
    onMouseEnter: (event: React.MouseEvent<SVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setTip({ x: rect.left + rect.width / 2, y: rect.top, content });
    },
    onMouseLeave: () => setTip(null),
    onFocus: (event: React.FocusEvent<SVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setTip({ x: rect.left + rect.width / 2, y: rect.top, content });
    },
    onBlur: () => setTip(null),
    onKeyDown: (event: React.KeyboardEvent<SVGElement>) => {
      if (event.key === "Escape") setTip(null);
    },
  });
  const buckets = rhythmBuckets(summary);
  const max = Math.max(3, ...buckets.map((bucket) => bucket.claude + bucket.codex));
  const step = Math.max(1, Math.ceil(max / 4));
  const ceiling = Math.ceil(max / step) * step;
  const width = 280 / Math.max(1, buckets.length);
  const heatMax = Math.max(1, ...summary.heatmap.map((day) => day.claude + day.codex));
  const today = summary.heatmap[summary.heatmap.length - 1]?.date;
  const firstWeekday = summary.heatmap.length
    ? (localDate(summary.heatmap[0]!.date).getDay() + 6) % 7
    : 0;
  const weeks = Math.max(5, Math.ceil((firstWeekday + summary.heatmap.length) / 7));
  const heatWidth = 280 / weeks;
  return (
    <aside className="muro-charts" aria-label={t("insights.charts")}>
      <section className="muro-chart" aria-label={t("insights.donut")}>
        <h2>{t("insights.donut")}</h2>
        <p>{t("insights.donutHint")}</p>
        <div className="muro-donut-box">
          <svg
            className="muro-donut"
            viewBox="0 0 130 130"
            role="img"
            aria-label={t("insights.completed", { formatted: number.format(total) })}
          >
            <circle
              cx="65"
              cy="65"
              r="47"
              fill="none"
              stroke="var(--muro-empty)"
              strokeWidth="18"
            />
            {AGENTS.map(
              (agent, index) =>
                counts[agent] > 0 && (
                  <circle
                    key={agent}
                    cx="65"
                    cy="65"
                    r="47"
                    pathLength="100"
                    fill="none"
                    stroke={AGENT_COLORS[agent]}
                    strokeWidth="18"
                    strokeDasharray={`${Math.max(0, (counts[agent] / total) * 100 - (counts.claude && counts.codex ? 0.65 : 0))} 100`}
                    strokeDashoffset={index === 0 ? 0 : (-counts.claude / total) * 100}
                    transform="rotate(-90 65 65)"
                    opacity={hover && hover !== agent ? 0.3 : 1}
                  />
                )
            )}
            <text x="65" y="65" textAnchor="middle" className="muro-donut-total">
              {number.format(total)}
            </text>
            <text x="65" y="82" textAnchor="middle">
              {t("insights.done")}
            </text>
          </svg>
          <div className="muro-legend">
            {AGENTS.map((agent) => (
              <button
                key={agent}
                type="button"
                disabled={product !== "both" && product !== agent}
                aria-pressed={agentFilter === agent}
                aria-label={t("insights.filter", { agent: NAMES[agent] })}
                onClick={() => onFilter(agent)}
                onMouseEnter={() => highlight(agent)}
                onMouseLeave={() => highlight(null)}
                onFocus={() => highlight(agent)}
                onBlur={() => highlight(null)}
              >
                <i style={{ background: AGENT_COLORS[agent] }} />
                <span>{NAMES[agent]}</span>
                <b>{number.format(counts[agent])}</b>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="muro-chart" aria-label={t("insights.rhythm")}>
        <h2>{t("insights.rhythm")}</h2>
        <p>{t(`insights.rhythm_${summary.period}`)}</p>
        <svg
          className="muro-rhythm"
          viewBox="0 0 320 175"
          role="group"
          aria-label={t(`insights.rhythm_${summary.period}`)}
        >
          {Array.from({ length: ceiling / step + 1 }, (_, index) => {
            const value = index * step,
              y = 146 - (value / ceiling) * 130;
            return (
              <g key={value} aria-hidden="true">
                <line
                  x1="30"
                  x2="314"
                  y1={y}
                  y2={y}
                  stroke="var(--muro-grid)"
                  strokeDasharray={value ? "2 4" : undefined}
                />
                <text x="25" y={y + 3} textAnchor="end">
                  {number.format(value)}
                </text>
              </g>
            );
          })}
          {buckets.map((bucket, index) => {
            const x = 32 + index * width;
            const label =
              bucketLabel(bucket.start, summary.period) +
              (bucket.end !== bucket.start ? ` – ${bucketLabel(bucket.end, summary.period)}` : "");
            const detail = `${label} · Claude ${number.format(bucket.claude)} · Codex ${number.format(bucket.codex)}`;
            return (
              <g key={bucket.start}>
                {AGENTS.map((agent, i) => (
                  <rect
                    key={agent}
                    x={x}
                    y={146 - ((bucket[agent] + (i ? bucket.claude : 0)) / ceiling) * 130}
                    width={Math.max(1, width - 4)}
                    height={(bucket[agent] / ceiling) * 130}
                    rx="2"
                    fill={AGENT_COLORS[agent]}
                  />
                ))}
                <rect
                  className="muro-chart-hit"
                  x={x - 2}
                  y="0"
                  width={width}
                  height="148"
                  fill="transparent"
                  tabIndex={0}
                  role="img"
                  aria-label={detail}
                  {...tooltip(
                    <>
                      <b>{label}</b>
                      {AGENTS.map((agent) => (
                        <span key={agent}>
                          <i style={{ background: AGENT_COLORS[agent] }} />
                          {NAMES[agent]} <strong>{number.format(bucket[agent])}</strong>
                        </span>
                      ))}
                    </>
                  )}
                />
                {(summary.period !== "today" || index % 4 === 0) && (
                  <text x={x + width / 2 - 2} y="166" textAnchor="middle" aria-hidden="true">
                    {bucketLabel(bucket.start, summary.period, true)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </section>
      <section className="muro-chart" aria-label={t("insights.heatmap")}>
        <h2>{t("insights.heatmap")}</h2>
        <p>{t("insights.heatHint")}</p>
        <svg
          viewBox="0 0 320 146"
          className="muro-heat"
          role="group"
          aria-label={t("insights.heatmap")}
        >
          {Array.from({ length: 7 }, (_, day) => (
            <text key={day} x="13" y={day * 20 + 16} textAnchor="middle" aria-hidden="true">
              {new Intl.DateTimeFormat(getCurrentLocale(), { weekday: "narrow" }).format(
                new Date(2026, 0, 5 + day)
              )}
            </text>
          ))}
          {summary.heatmap.map((day, index) => {
            const count = day.claude + day.codex,
              level = count ? Math.max(1, Math.ceil((count / heatMax) * 4)) : 0;
            const label = `${bucketLabel(day.date, "7d")}${day.date === today ? ` (${t("period.today")})` : ""} · ${t("insights.completed", { formatted: number.format(count) })}`;
            return (
              <rect
                key={day.date}
                x={30 + Math.floor((index + firstWeekday) / 7) * heatWidth}
                y={((index + firstWeekday) % 7) * 20 + 4}
                width={heatWidth - 6}
                height="16"
                rx="4"
                fill={["#1a1a28", "#2e2f63", "#4547a3", "#6366f1", "#a5a8ff"][level]}
                stroke={day.date === today ? "#f3f4f6" : undefined}
                strokeWidth="2"
                tabIndex={0}
                role="img"
                aria-label={label}
                data-date={day.date}
                aria-current={day.date === today ? "date" : undefined}
                className="muro-chart-hit"
                {...tooltip(<b>{label}</b>)}
              />
            );
          })}
        </svg>
      </section>
      {tip && (
        <div
          className="muro-chart-tip"
          role="tooltip"
          style={{
            left: Math.max(8, Math.min(tip.x - 110, window.innerWidth - 228)),
            top: Math.max(8, Math.min(tip.y - 94, window.innerHeight - 105)),
          }}
        >
          {tip.content}
        </div>
      )}
    </aside>
  );
}
