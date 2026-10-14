/**
 * @file Muro.tsx
 * @description Live Muro stage with scoped sessions, today's agent totals, and
 * page-owned filters, period insights, illustrated lanes and an on-demand session sheet.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Skeleton } from "../components/Skeleton";
import { eventBus } from "../lib/eventBus";
import { api } from "../lib/api";
import { useDataScope } from "../lib/dataScope";
import { getCurrentLocale } from "../lib/format";
import { isRemoteDataRefreshMessage } from "../lib/remoteDataEvents";
import { isSessionAwaitingInput, type MuroSummary, type Session } from "../lib/types";
import { Mascot, type MuroAgent } from "../components/muro/Mascot";
import { Board } from "../components/muro/Board";
import { Kpis, Charts } from "../components/muro/Insights";
import { IdeaBubble, sessionIdeas } from "../components/muro/KeyIdeas";
import {
  isMuroSession,
  sessionTitle,
  sessionLane,
  type MuroSession,
} from "../components/muro/model";
import { SessionSheet } from "../components/muro/SessionSheet";
import { HandoffPlane, HandoffRibbon } from "../components/muro/Handoffs";
import { useReducedMotion } from "../components/muro/motion";
import { mergeFreshestById } from "../lib/merge-by-id";
import "../components/muro/stage.css";
import "@fontsource/bangers/400.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";

const PERIODS = ["today", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

/** Stage and board share the local agent filter and the global source/product scope. */
export function Muro() {
  const { t } = useTranslation("muro");
  const [dataScope] = useDataScope();
  const [period, setPeriod] = useState<Period>("today");
  const [agentFilter, setAgentFilter] = useState<MuroAgent | null>(null);
  const [data, setData] = useState<{ sessions: Session[]; summary: MuroSummary } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [highlight, setHighlight] = useState<MuroAgent | null>(null);
  const [selected, setSelected] = useState<MuroSession | null>(null);
  const [sheetError, setSheetError] = useState(false);
  const origin = useRef<HTMLElement | null>(null);
  const navigation = useRef(0);
  const reducedMotion = useReducedMotion();
  const getOrigin = useCallback(() => origin.current, []);
  const closeSheet = useCallback(() => {
    navigation.current++;
    setSelected(null);
    setSheetError(false);
  }, []);
  const openSheet = (session: MuroSession) => {
    navigation.current++;
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSheetError(false);
    setSelected(session);
  };
  const [insights, setInsights] = useState<{ key: string; summary: MuroSummary } | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [insightsRetry, setInsightsRetry] = useState(0);
  const wsConnected = useSyncExternalStore(eventBus.onConnection, () => eventBus.connected);
  const product = dataScope.provider || "claude";
  const effectiveFilter = product === "both" || product === agentFilter ? agentFilter : null;
  const insightsKey = `${period}:${effectiveFilter}:${JSON.stringify(dataScope)}`;
  const toggleAgent = (agent: MuroAgent) =>
    setAgentFilter((current) => (current === agent ? null : agent));
  useEffect(() => {
    if (product !== "both") setAgentFilter(null);
  }, [product]);

  useEffect(() => {
    let disposed = false;
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    navigation.current++;
    setSelected(null);
    setError(false);
    const load = async () => {
      const current = ++request;
      try {
        const list = async (status: "active" | "completed") => {
          const sessions: Session[] = [];
          let offset = 0;
          let total = Infinity;
          while (offset < total && !disposed && current === request) {
            const result = await api.sessions.list({
              status,
              limit: 10000,
              ...(offset ? { offset } : {}),
              include_transient: status === "active",
              include_task_progress: true,
            });
            sessions.push(...result.sessions);
            total = result.total;
            if (!result.sessions.length) break;
            offset += result.limit;
          }
          return sessions;
        };
        const [summary, active, completed] = await Promise.all([
          api.muro.summary("today"),
          list("active"),
          list("completed"),
        ]);
        if (disposed || current !== request) return;
        // A completion can arrive between the two requests without a newer event timestamp.
        // Prefer the completed copy on a tie; genuinely newer resumed activity still wins.
        setData({ summary, sessions: mergeFreshestById(completed, active) });
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

  useEffect(() => {
    let disposed = false;
    setInsightsError(null);
    // Reuse today's request for the initial view. Other periods and agent filters
    // fetch their own exact streak (the heatmap only covers 35 days).
    if (!data || (period === "today" && !effectiveFilter)) return;
    api.muro
      .summary(period, effectiveFilter ?? undefined)
      .then((summary) => {
        if (!disposed) setInsights({ key: insightsKey, summary });
      })
      .catch(() => {
        if (!disposed) setInsightsError(insightsKey);
      });
    return () => {
      disposed = true;
    };
  }, [data, period, effectiveFilter, insightsKey, insightsRetry]);

  // Linked parents may be outside the current product list. Refresh their
  // detail after the same live reloads, without reopening a closed sheet.
  useEffect(() => {
    if (!selected || data?.sessions.some((session) => session.id === selected.id)) return;
    let cancelled = false;
    api.sessions
      .get(selected.id, { handoffPeer: true })
      .then((detail) => {
        if (!cancelled && isMuroSession(detail.session)) setSelected(detail.session);
      })
      .catch(() => {
        if (!cancelled) setSheetError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, data]);

  const summary =
    period === "today" && !effectiveFilter
      ? data?.summary
      : insights?.key === insightsKey
        ? insights.summary
        : null;
  const insightStatus =
    insightsError === insightsKey ? (
      <div role="alert" className="card p-4 text-sm text-red-400">
        <p>{t("insights.error")}</p>
        <button
          type="button"
          className="btn-secondary mt-3"
          onClick={() => setInsightsRetry((value) => value + 1)}
        >
          {t("common:retry")}
        </button>
      </div>
    ) : !summary ? (
      <Skeleton className="w-full h-48" label={t("insights.loading")} />
    ) : null;

  const number = new Intl.NumberFormat(getCurrentLocale());
  const tokens = new Intl.NumberFormat(getCurrentLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const sessions = (data?.sessions ?? [])
    .filter(isMuroSession)
    .filter((session) => product === "both" || session.provider === product)
    .sort((a, b) =>
      (b.last_activity || b.started_at).localeCompare(a.last_activity || a.started_at)
    );
  const currentSession =
    selected && (sessions.find((session) => session.id === selected.id) || selected);
  const navigateSheet = async (id: string) => {
    const request = ++navigation.current;
    setSheetError(false);
    const session = sessions.find((candidate) => candidate.id === id);
    if (session) {
      setSelected(session);
      return;
    }
    try {
      const detail = await api.sessions.get(id, { handoffPeer: true });
      if (request === navigation.current && isMuroSession(detail.session))
        setSelected(detail.session);
    } catch {
      if (request === navigation.current) setSheetError(true);
    }
  };

  return (
    <div
      className="muro-page animate-fade-in flex flex-col min-h-[60vh]"
      data-agent-filter={effectiveFilter ?? "all"}
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
            className="muro-stage-handoffs grid grid-cols-1 xl:grid-cols-2 gap-3.5 mb-8"
          >
            {(["claude", "codex"] as const).map((agent) => {
              const excluded = product !== "both" && product !== agent;
              const working = sessions.find(
                (candidate) =>
                  candidate.provider === agent &&
                  candidate.status === "active" &&
                  !isSessionAwaitingInput(candidate)
              );
              const waiting = sessions.find(
                (candidate) => candidate.provider === agent && isSessionAwaitingInput(candidate)
              );
              const session = working || waiting;
              const ideas = excluded ? [] : sessionIdeas(session);
              const title = session ? sessionTitle(session, t("stage.untitled")) : "";
              const totals = data.summary.totals[agent];
              const name = agent === "claude" ? "Claude" : "Codex";
              return (
                <button
                  key={agent}
                  data-agent={agent}
                  type="button"
                  aria-pressed={effectiveFilter === agent}
                  disabled={excluded}
                  aria-label={t("stage.filter", { agent: name })}
                  onClick={() => toggleAgent(agent)}
                  className={`muro-actor ${ideas.length ? "muro-actor-ideas" : ""} relative flex gap-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default ${excluded || (effectiveFilter && effectiveFilter !== agent) ? "opacity-[0.45]" : ""}`}
                >
                  <span className="muro-floor" aria-hidden="true" />
                  <Mascot
                    agent={agent}
                    mode={working ? "work" : "wait"}
                    size={104}
                    reducedMotion={excluded}
                  />
                  <span className="muro-actor-body">
                    <IdeaBubble ideas={ideas} stage />
                    <span className="muro-actor-name">
                      <span
                        aria-hidden="true"
                        className={`w-2.5 h-2.5 rounded-[3px] ${agent === "claude" ? "bg-[#D46F3A]" : "bg-[#2BA394]"}`}
                      />
                      {name}
                    </span>
                    <span className="muro-bubble">
                      {excluded ? (
                        t("stage.excluded")
                      ) : working ? (
                        <>
                          <b className="muro-bubble-verb">{t(`note.${agent}`)}</b>
                          {title}
                        </>
                      ) : waiting ? (
                        <>
                          <b className="muro-bubble-verb">{t("note.reason.stop")}</b>
                          {title}
                        </>
                      ) : (
                        t("stage.waiting")
                      )}
                    </span>
                    {!excluded && (
                      <span className="muro-stage-chips">
                        <span>
                          {t("stage.completed", {
                            count: totals.tasks_completed,
                            formatted: number.format(totals.tasks_completed),
                          })}
                        </span>
                        <span
                          title={t("stage.tokens", { formatted: number.format(totals.tokens) })}
                        >
                          {t("stage.tokens", { formatted: tokens.format(totals.tokens) })}
                        </span>
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            <HandoffPlane
              sessions={sessions.filter(
                (session) => !effectiveFilter || session.provider === effectiveFilter
              )}
              onOpen={openSheet}
            />
          </section>
          <HandoffRibbon
            sessions={sessions.filter(
              (session) => !effectiveFilter || session.provider === effectiveFilter
            )}
            period={period}
            onOpen={openSheet}
          />
          {insightStatus || (summary && <Kpis summary={summary} />)}
          <div className="muro-body">
            <Board
              relatedSessions={sessions}
              onOpen={openSheet}
              sessions={sessions.filter(
                (session) => !effectiveFilter || session.provider === effectiveFilter
              )}
              period={period}
              highlight={highlight}
              filterKey={`${period}:${effectiveFilter}:${product}:${dataScope.mode}:${dataScope.selected.join(",")}`}
            />
            {!insightStatus && summary && (
              <Charts
                summary={summary}
                agentFilter={effectiveFilter}
                product={product}
                onFilter={toggleAgent}
                onHighlight={setHighlight}
              />
            )}
          </div>
          {currentSession && (
            <SessionSheet
              session={currentSession}
              lane={sessionLane(currentSession, period) || "done"}
              reducedMotion={reducedMotion}
              getOrigin={getOrigin}
              onClose={closeSheet}
              relatedSessions={sessions}
              navigationError={sheetError}
              handoffPeer={product !== "both" && currentSession.provider !== product}
              onNavigate={(id) => void navigateSheet(id)}
            />
          )}
        </>
      )}
    </div>
  );
}
