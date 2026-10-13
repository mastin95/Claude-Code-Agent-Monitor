/**
 * @file Muro.tsx
 * @description Muro page shell with live connection status, a local period selector,
 * and loading, empty, and error states ready for the future data integration.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, StickyNote } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { eventBus } from "../lib/eventBus";

const PERIODS = ["today", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

/** Data states for the shell; the route stays empty until data is connected. */
interface MuroProps {
  status?: "loading" | "empty" | "error";
}

/** Renders the Muro header and its current content state without fetching data. */
export function Muro({ status = "empty" }: MuroProps) {
  const { t } = useTranslation("muro");
  const [period, setPeriod] = useState<Period>("today");
  const wsConnected = useSyncExternalStore(eventBus.onConnection, () => eventBus.connected);

  return (
    <div className="animate-fade-in flex flex-col min-h-[60vh]">
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

      {status === "loading" ? (
        <Skeleton className="w-full h-48" rounded="lg" label={t("loading")} />
      ) : status === "error" ? (
        <div role="alert" className="card flex flex-col items-center justify-center py-16 gap-4">
          <AlertCircle className="w-10 h-10 text-red-400" aria-hidden="true" />
          <p className="text-red-400 text-sm">{t("error")}</p>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={StickyNote}
            title={t("empty.title")}
            description={t("empty.description")}
          />
        </div>
      )}
    </div>
  );
}
