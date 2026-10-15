/**
 * @file Charla.tsx
 * @description Live parent/child conversations with cursor paging and filterable transcript blocks.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { useDataScope, setProviderScope } from "../lib/dataScope";
import { getCurrentLocale } from "../lib/format";
import { isSessionAwaitingInput, type Session, type TranscriptMessage } from "../lib/types";
import {
  childHandoffs,
  handoffsInPeriod,
  sessionHandoff,
  type Handoff,
} from "../components/muro/handoff-model";
import { transcriptBlocks, type CharlaBlock } from "../components/muro/charla-model";
import { Mascot } from "../components/muro/Mascot";
import "../components/muro/charla.css";

function LongText({ text, diff = false }: { text: string; diff?: boolean }) {
  const { t } = useTranslation("muro");
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  return (
    <>
      <pre>
        {(open ? lines : lines.slice(0, 12)).map((line, i) => (
          <span
            key={i}
            className={
              diff
                ? line.startsWith("+")
                  ? "add"
                  : line.startsWith("-")
                    ? "del"
                    : undefined
                : undefined
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
      {lines.length > 12 && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(`charla.${open ? "less" : "more"}`)}
        </button>
      )}
    </>
  );
}
function Entry({ block, codex }: { block: CharlaBlock; codex: boolean }) {
  const { t } = useTranslation("muro");
  const time =
    block.at && Number.isFinite(Date.parse(block.at)) ? (
      <time dateTime={block.at}>
        {new Date(block.at).toLocaleTimeString(getCurrentLocale(), {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
    ) : null;
  if (block.kind === "think")
    return (
      <details className="ch-think">
        <summary>
          {t("charla.thought")} {time}
        </summary>
        <p>{block.text || t("charla.noThinking")}</p>
      </details>
    );
  const label =
    block.kind === "user"
      ? codex
        ? "Claude"
        : t("charla.martin")
      : t(
          `charla.${block.kind === "say" ? (codex ? "forClaude" : "forYou") : block.kind === "handoff" ? (codex ? (block.direction === "out" ? "receivedFromClaude" : "sentToClaude") : block.direction === "out" ? "sent" : "received") : block.kind}`
        );
  return (
    <article
      className={`ch-${block.kind}${block.error ? " fail" : ""}${block.direction === "in" ? " in" : ""}`}
    >
      <header>
        <b>{label}</b>
        {time}
      </header>
      {block.kind === "cmd" || block.kind === "diff" ? (
        <>
          <LongText text={block.text} />
          {block.output != null && <LongText text={block.output} diff={block.kind === "diff"} />}
        </>
      ) : (
        <p>{block.text}</p>
      )}
    </article>
  );
}
function Column({
  session,
  handoff,
  filters,
}: {
  session: Session;
  handoff: Handoff | null;
  filters: Record<string, boolean>;
}) {
  const { t } = useTranslation("muro");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false,
      busy = false,
      pending = false,
      cursor = 0;
    setMessages([]);
    setLoading(true);
    setError(false);
    const load = async () => {
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      try {
        do {
          pending = false;
          let more = true;
          while (more && !disposed) {
            const result = await api.sessions.transcript(session.id, { after: cursor, limit: 200 });
            if (disposed) return;
            setMessages((previous) => [...previous, ...result.messages]);
            more = result.has_more && result.last_line > cursor;
            cursor = Math.max(cursor, result.last_line);
          }
        } while (pending && !disposed);
        if (!disposed) setError(false);
      } catch {
        if (!disposed) setError(true);
      } finally {
        busy = false;
        if (!disposed) setLoading(false);
      }
    };
    void load();
    const unsubscribe = eventBus.subscribe((message) => {
      const data = message.data as { id?: string; session_id?: string };
      if (
        data.session_id === session.id ||
        (message.type.startsWith("session_") && data.id === session.id)
      )
        void load();
    });
    const reconnect = eventBus.onConnection((connected) => {
      if (connected) void load();
    });
    return () => {
      disposed = true;
      unsubscribe();
      reconnect();
    };
  }, [session.id, retry]);
  let effort: string | undefined;
  try {
    const metadata = JSON.parse(session.metadata || "{}");
    const value = metadata.effort || metadata.reasoning_effort || metadata.model_reasoning_effort;
    effort = typeof value === "string" ? value : undefined;
  } catch {
    /* Missing metadata is normal for imported sessions. */
  }
  const blocks = transcriptBlocks(messages, handoff);
  const modelEffort = [session.model, effort]
    .filter((value) => value && value.toLowerCase() !== "unknown")
    .join(" · ");
  const active = session.status === "active" && !isSessionAwaitingInput(session);
  const status = isSessionAwaitingInput(session) ? "waiting" : session.status;
  return (
    <section
      className={`ch-col ${session.provider === "codex" ? "codex" : "claude"}`}
      aria-label={session.provider === "codex" ? "Codex" : "Claude"}
    >
      <header className="ch-head">
        <h2>
          <span className="ch-avatar">
            <Mascot
              agent={session.provider === "codex" ? "codex" : "claude"}
              mode={active ? "work" : status === "completed" ? "done" : "wait"}
              size={40}
            />
          </span>
          {session.provider === "codex" ? "Codex" : "Claude"}
        </h2>
        <p>
          <span>{t(`common:status.${status}`)}</span>
          {modelEffort && <span>{modelEffort}</span>}
          <span>
            {t("charla.tokens", {
              count: session.total_tokens ?? 0,
              value:
                session.total_tokens == null
                  ? t("charla.unknown")
                  : session.total_tokens.toLocaleString(getCurrentLocale()),
            })}
          </span>
        </p>
      </header>
      <div className="ch-feed">
        {loading && <p role="status">{t("charla.loading")}</p>}
        {error && (
          <div role="alert">
            {t("charla.error")}{" "}
            <button onClick={() => setRetry((n) => n + 1)}>{t("charla.retry")}</button>
          </div>
        )}
        {!loading && !error && !blocks.length && (
          <p className="ch-empty">{t("charla.noMessages")}</p>
        )}
        {blocks
          .filter((block) => filters[block.kind] !== false)
          .map((block) => (
            <Entry key={block.id} block={block} codex={session.provider === "codex"} />
          ))}
        {active && (
          <div className="ch-live">
            <span className="ch-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {t("charla.active")}
          </div>
        )}
      </div>
    </section>
  );
}
export function Charla() {
  const { t } = useTranslation("muro");
  const [scope] = useDataScope();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filters, setFilters] = useState<Record<string, boolean>>({
    think: true,
    cmd: true,
    diff: true,
  });
  useEffect(() => {
    let disposed = false,
      busy = false,
      pending = false;
    setLoading(true);
    setError(false);
    setSessions([]);
    setSelected("");
    const load = async () => {
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      try {
        do {
          pending = false;
          const all: Session[] = [];
          let offset = 0;
          while (!disposed) {
            const result = await api.sessions.list({ limit: 1000, offset });
            all.push(...result.sessions);
            offset += result.sessions.length;
            if (!result.sessions.length || offset >= result.total) break;
          }
          if (!disposed) {
            setSessions(all);
            setError(false);
          }
        } while (pending && !disposed);
      } catch {
        if (!disposed) setError(true);
      } finally {
        busy = false;
        if (!disposed) setLoading(false);
      }
    };
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    void load();
    const unsubscribe = eventBus.subscribe((message) => {
      if (
        ["session_created", "session_updated", "agent_updated", "remote_data.updated"].includes(
          message.type
        )
      ) {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          void load();
        }, 1000);
      }
    });
    const reconnect = eventBus.onConnection((connected) => {
      if (connected) void load();
    });
    return () => {
      disposed = true;
      clearTimeout(reloadTimer);
      unsubscribe();
      reconnect();
    };
  }, [scope, retry]);
  const children = sessions.filter((session) => sessionHandoff(session));
  // Recent work first; retain older handoffs so history does not silently disappear.
  const recent = handoffsInPeriod(children, "30d");
  const ordered = [...recent, ...children.filter((child) => !recent.includes(child))].sort(
    (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || a.id.localeCompare(b.id)
  );
  const pairs = ordered.flatMap((child) => {
    const parent = sessions.find((candidate) => childHandoffs(candidate, [child]).length > 0);
    return parent ? [{ child, parent }] : [];
  });
  const pair =
    pairs.find((item) => item.child.id === selected) ||
    pairs.find((item) => item.child.status === "active") ||
    pairs[0];
  const chosenId = pair?.child.id;
  useEffect(() => {
    if (chosenId && selected !== chosenId) setSelected(chosenId);
  }, [chosenId, selected]);
  return (
    <div className="charla-page">
      <div className="charla-top">
        <h1>{t("charla.title")}</h1>
        <label className="charla-pick">
          {t("charla.assignment")}{" "}
          <select
            value={pair?.child.id || ""}
            onChange={(event) => setSelected(event.target.value)}
            disabled={!pairs.length}
          >
            {pairs.map((item) => (
              <option value={item.child.id} key={item.child.id}>
                {item.parent.name || item.parent.id} · {item.child.name || item.child.id}
              </option>
            ))}
          </select>
        </label>
        <div className="charla-filters" role="group" aria-label={t("charla.show")}>
          {["think", "cmd", "diff"].map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={filters[kind]}
              onClick={() => setFilters((previous) => ({ ...previous, [kind]: !previous[kind] }))}
            >
              {t(`charla.filter_${kind}`)}
            </button>
          ))}
        </div>
      </div>
      {scope.provider !== "both" && (
        <p className="ch-empty">
          {t("charla.bothHint")}{" "}
          <button onClick={() => setProviderScope("both")}>{t("charla.both")}</button>
        </p>
      )}
      {loading ? (
        <p role="status">{t("charla.loading")}</p>
      ) : error ? (
        <div role="alert">
          {t("charla.error")}{" "}
          <button onClick={() => setRetry((n) => n + 1)}>{t("charla.retry")}</button>
        </div>
      ) : pair ? (
        <div className="ch-cols">
          <Column
            key={pair.parent.id}
            session={pair.parent}
            handoff={sessionHandoff(pair.child)}
            filters={filters}
          />
          <Column
            key={pair.child.id}
            session={pair.child}
            handoff={sessionHandoff(pair.child)}
            filters={filters}
          />
        </div>
      ) : (
        <p className="ch-empty">{t("charla.empty")}</p>
      )}
    </div>
  );
}
