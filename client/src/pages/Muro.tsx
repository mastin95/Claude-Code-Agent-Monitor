/**
 * @file Muro.tsx
 * @description Live Muro stage with scoped sessions, today's agent totals, and
 * page-owned period and agent filters for the upcoming board and charts.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, StickyNote } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { eventBus } from "../lib/eventBus";
import { api } from "../lib/api";
import { useDataScope } from "../lib/dataScope";
import { getCurrentLocale } from "../lib/format";
import { isRemoteDataRefreshMessage } from "../lib/remoteDataEvents";
import { isSessionAwaitingInput, type MuroSummary, type Session } from "../lib/types";
import { Mascot, type MuroAgent } from "../components/muro/Mascot";
import "@fontsource/caveat/latin-400.css";
import "@fontsource/caveat/latin-ext-400.css";
import "../components/muro/stage.css";

const PERIODS = ["today", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

/** Renders the team stage; filters stay here so later Muro sections can share them. */
export function Muro() {
  const { t } = useTranslation("muro");
  const [dataScope] = useDataScope();
  const [period, setPeriod] = useState<Period>("today");
  const [agentFilter, setAgentFilter] = useState<MuroAgent | null>(null);
  const [data, setData] = useState<{ sessions: Session[]; summary: MuroSummary } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const wsConnected = useSyncExternalStore(eventBus.onConnection, () => eventBus.connected);

  useEffect(() => {
    let disposed = false;
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError(false);
    const load = async () => {
      const current = ++request;
      try {
        const [summary, result] = await Promise.all([
          api.muro.summary("today"),
          api.sessions.list({ status: "active", limit: 10000, include_transient: true }),
        ]);
        if (disposed || current !== request) return;
        setData({ summary, sessions: result.sessions });
        setError(false);
      } catch {
        if (!disposed && current === request) setError(true);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      // Invalidate in-flight results as soon as newer activity arrives.
      request++;
      timer = setTimeout(() => void load(), 300);
    };
    void load();
    const unsubscribe = eventBus.subscribe((message) => {
      if (
        ["session_created", "session_updated", "agent_updated"].includes(message.type) ||
        isRemoteDataRefreshMessage(message)
      )
        schedule();
    });
    const disconnect = eventBus.onConnection((connected) => {
      if (connected) schedule();
    });
    // Also rolls today's counters over on quiet days or a dropped connection.
    const interval = setInterval(schedule, 60_000);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(interval);
      unsubscribe();
      disconnect();
    };
  }, [dataScope, retry]);

  const number = new Intl.NumberFormat(getCurrentLocale());
  const tokens = new Intl.NumberFormat(getCurrentLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const working = data?.sessions
    .filter((session) => session.status === "active" && !isSessionAwaitingInput(session))
    .sort((a, b) =>
      (b.last_activity || b.started_at).localeCompare(a.last_activity || a.started_at)
    );

  return (
    <div
      className="muro-page animate-fade-in flex flex-col min-h-[60vh]"
      data-agent-filter={agentFilter ?? "all"}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-100">{t("title")}</h1>
          <span
            role="status"
            className={`flex items-center gap-1.5 text-[11px] border px-2 py-0.5 rounded-full ${
              wsConnected
                ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                : "text-gray-400 bg-gray-500/10 border-gray-500/20"
            }`}
          >
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${
                wsConnected
                  ? "bg-emerald-400 animate-pulse-dot motion-reduce:animate-none"
                  : "bg-gray-400"
              }`}
            />
            {wsConnected ? t("common:live") : t("common:offline")}
          </span>
        </div>
        <div
          role="group"
          aria-label={t("period.label")}
          className="flex items-center gap-1 bg-surface-2 rounded-lg p-1 border border-border"
        >
          {PERIODS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                period === value
                  ? "bg-surface-4 text-gray-100"
                  : "text-gray-400 hover:text-gray-200 hover:bg-surface-3"
              }`}
            >
              {t(`period.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div role="alert" className="card flex flex-col items-center justify-center py-16 gap-4">
          <AlertCircle className="w-10 h-10 text-red-400" aria-hidden="true" />
          <p className="text-red-400 text-sm">{t("error")}</p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("common:retry")}
          </button>
        </div>
      ) : !data ? (
        <Skeleton className="w-full h-48" rounded="lg" label={t("loading")} />
      ) : (
        <>
          <section
            aria-label={t("stage.label")}
            className="grid grid-cols-1 xl:grid-cols-2 gap-3.5 mb-8"
          >
            {(["claude", "codex"] as const).map((agent) => {
              const session = working?.find((candidate) => candidate.provider === agent);
              // The sessions API exposes card_prompt_preview as prompt_preview.
              const title =
                session?.name?.trim() ||
                session?.prompt_preview?.trim().slice(0, 40) ||
                t("stage.untitled");
              const totals = data.summary.totals[agent];
              const name = agent === "claude" ? "Claude" : "Codex";
              return (
                <button
                  key={agent}
                  type="button"
                  aria-pressed={agentFilter === agent}
                  aria-label={t("stage.filter", { agent: name })}
                  onClick={() => setAgentFilter((current) => (current === agent ? null : agent))}
                  className={`muro-actor relative overflow-hidden flex items-center gap-3.5 px-4 py-3 rounded-2xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${agentFilter === agent ? "border-accent" : "border-border hover:border-border-light"} ${agentFilter && agentFilter !== agent ? "opacity-[0.45]" : ""}`}
                >
                  <span className="muro-floor" aria-hidden="true" />
                  <Mascot agent={agent} mode={session ? "work" : "wait"} size={104} />
                  <span className="relative flex flex-col gap-1.5 min-w-0">
                    <span className="flex items-center gap-2 text-[17px] font-bold text-gray-100">
                      <span
                        aria-hidden="true"
                        className={`w-2.5 h-2.5 rounded-[3px] ${agent === "claude" ? "bg-[#D46F3A]" : "bg-[#2BA394]"}`}
                      />
                      {name}
                    </span>
                    <span className="muro-bubble">
                      {session ? t(`stage.${agent}`, { title }) : t("stage.waiting")}
                    </span>
                    <span className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-xs text-gray-400">
                      <span>
                        {t("stage.completed", {
                          count: totals.tasks_completed,
                          formatted: number.format(totals.tasks_completed),
                        })}
                      </span>
                      <span title={t("stage.tokens", { formatted: number.format(totals.tokens) })}>
                        {t("stage.tokens", { formatted: tokens.format(totals.tokens) })}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
          {!data.sessions.some(
            (session) =>
              (session.provider === "claude" || session.provider === "codex") &&
              (!agentFilter || session.provider === agentFilter)
          ) &&
            (["claude", "codex"] as const)
              .filter((agent) => !agentFilter || agent === agentFilter)
              .every(
                (agent) =>
                  data.summary.totals[agent].tokens === 0 &&
                  data.summary.totals[agent].tasks_completed === 0
              ) && (
              <div className="flex-1 flex items-center justify-center">
                <EmptyState
                  icon={StickyNote}
                  title={t("empty.title")}
                  description={t("empty.description")}
                />
              </div>
            )}
        </>
      )}
    </div>
  );
}
