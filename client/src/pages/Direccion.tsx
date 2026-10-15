/**
 * @file Direccion.tsx
 * @description Dirección: Martin gives orders (directly, or by mixing ideas from a Claude-vs-Codex pitch duel), the conductor runs a Claude lead and a Codex collaborator, and the page shows the stage, OK cards and score live.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Duelo, pickKey } from "../components/muro/Duelo";
import { Mascot } from "../components/muro/Mascot";
import { useReducedMotion } from "../components/muro/motion";
import {
  compactTokens,
  currentRound,
  isOrderLive,
  pendingApprovals,
  scoreRows,
  stageAgent,
  type ScoreRow,
} from "../components/muro/direccion-model";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { formatTime } from "../lib/format";
import type {
  ConductorAgentName,
  ConductorAgentState,
  ConductorAnswer,
  ConductorApproval,
  ConductorBrowse,
  ConductorOrder,
  ConductorPitch,
  ConductorPitchDepth,
  ConductorPitchPick,
  ConductorProject,
} from "../lib/types";
import "@fontsource/bangers/400.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "../components/muro/direccion.css";

const AGENTS: ConductorAgentName[] = ["claude", "codex"];
const NAMES: Record<ConductorAgentName, string> = { claude: "Claude", codex: "Codex" };
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PROJECT_KEY = "direccion.project";
const DEPTHS: ConductorPitchDepth[] = ["quick", "normal", "deep"];
/** A duel stays on screen while it drafts or waits for Martin's mix (or shows why it failed). */
const showPitch = (pitch: ConductorPitch | null) =>
  !!pitch && ["drafting", "ready", "error"].includes(pitch.status);

function readStored(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}
function store(id: string) {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    /* Private windows may refuse storage; the picker still works. */
  }
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className="dir-chip" data-tone={tone}>
      {children}
    </span>
  );
}

function LeadPicker({ lead }: { lead: ConductorAgentName | null }) {
  const { t } = useTranslation("direccion");
  return (
    <div className="dir-lead" role="radiogroup" aria-label={t("lead.label")}>
      <span className="dir-label">{t("lead.label")}</span>
      {AGENTS.map((agent) => (
        <span
          key={agent}
          className="dir-lead-tile"
          data-agent={agent}
          role="radio"
          aria-checked={agent === lead}
          aria-disabled="true"
        >
          <Mascot agent={agent} mode="done" size={44} reducedMotion />
          <span>{NAMES[agent]}</span>
          {agent === lead && <b className="dir-baton">{t("lead.badge")}</b>}
        </span>
      ))}
    </div>
  );
}

function FolderPicker({
  start,
  onPick,
  onClose,
}: {
  start: string;
  onPick: (path: string, isNew: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("direccion");
  const [view, setView] = useState<ConductorBrowse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fresh, setFresh] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const open = useCallback(async (target?: string) => {
    setLoading(true);
    setError(null);
    try {
      setView(await api.conductor.browse(target));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // Start where the typed path points; fall back to the home folder if it does not exist yet.
    api.conductor
      .browse(start.trim() || undefined)
      .then(setView)
      .catch(() => open());
    dialog.current?.focus();
  }, [start, open]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const freshName = fresh.trim();
  const freshOk = !!freshName && !/[\\/:*?"<>|]/.test(freshName) && !/^\.+$/.test(freshName);
  const join = (base: string, name: string) =>
    base.endsWith(view?.sep || "/") ? base + name : base + (view?.sep || "/") + name;
  return (
    <div className="dir-picker-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="dir-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t("picker.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dir-picker-head">
          <h2 className="dir-title">{t("picker.title")}</h2>
          <button
            type="button"
            className="dir-picker-x"
            onClick={onClose}
            aria-label={t("picker.close")}
          >
            ✕
          </button>
        </div>
        <div className="dir-picker-body">
          <nav className="dir-picker-side" aria-label={t("picker.places")}>
            <span className="dir-label">{t("picker.drives")}</span>
            {view?.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="dir-picker-place"
                data-kind="drive"
                aria-current={view.path === root.path}
                onClick={() => open(root.path)}
              >
                <span aria-hidden>💾</span> {root.name}
              </button>
            ))}
            <span className="dir-label">{t("picker.places")}</span>
            {view?.places.map((place, i) => (
              <button
                key={place.path}
                type="button"
                className="dir-picker-place"
                aria-current={view.path === place.path}
                onClick={() => open(place.path)}
              >
                <span aria-hidden>{i === 0 ? "🏠" : "⭐"}</span>{" "}
                {i === 0 ? t("picker.home") : place.name}
              </button>
            ))}
          </nav>
          <div className="dir-picker-main">
            <div className="dir-picker-path">
              <button
                type="button"
                className="dir-change"
                disabled={!view?.parent || loading}
                onClick={() => view?.parent && open(view.parent)}
              >
                <span aria-hidden>⬆</span> {t("picker.up")}
              </button>
              <code title={view?.path}>{view?.path || "…"}</code>
            </div>
            {error && <p className="dir-error">{error}</p>}
            <ul className="dir-picker-list" aria-busy={loading}>
              {view && view.dirs.length === 0 && !loading && (
                <li className="dir-picker-empty">{t("picker.empty")}</li>
              )}
              {view?.dirs.map((dir) => (
                <li key={dir.path}>
                  <button
                    type="button"
                    className="dir-picker-folder"
                    title={dir.path}
                    onClick={() => open(dir.path)}
                  >
                    <span aria-hidden>📁</span>
                    <span>{dir.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            {view?.truncated && <small>{t("picker.truncated")}</small>}
          </div>
        </div>
        <div className="dir-picker-foot">
          <label className="dir-picker-new">
            <span>{t("picker.newFolder")}</span>
            <input
              value={fresh}
              onChange={(e) => setFresh(e.target.value)}
              onKeyDown={(e) => {
                // The picker lives inside the New project form; Enter must not submit it.
                if (e.key === "Enter") e.preventDefault();
              }}
              placeholder={t("picker.newHint")}
            />
          </label>
          <button
            type="button"
            className="dir-change"
            disabled={!view || !freshOk}
            onClick={() => view && onPick(join(view.path, freshName), true)}
          >
            <span aria-hidden>✨</span> {t("picker.createHere")}
          </button>
          <button
            type="button"
            className="dir-cta small"
            disabled={!view || loading}
            onClick={() => view && onPick(view.path, false)}
          >
            {t("picker.use")}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewProject({
  onCreated,
  onCancel,
}: {
  onCreated: (project: ConductorProject) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("direccion");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [create, setCreate] = useState(true);
  const [picking, setPicking] = useState(false);
  const [models, setModels] = useState<Record<ConductorAgentName, string[]>>({
    claude: [],
    codex: [],
  });
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    for (const agent of AGENTS) {
      api.run
        .models(agent)
        .then((result) => {
          if (!disposed)
            setModels((previous) => ({ ...previous, [agent]: result.items.map((m) => m.id) }));
        })
        .catch(() => {
          /* Model suggestions are optional; free text still works. */
        });
    }
    return () => {
      disposed = true;
    };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const pick = (agent: ConductorAgentName) => ({
        ...(choice[`${agent}_model`] ? { model: choice[`${agent}_model`] } : {}),
        ...(choice[`${agent}_effort`] ? { effort: choice[`${agent}_effort`] } : {}),
      });
      const project = await api.conductor.createProject({
        cwd: cwd.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        create,
        lead: "claude",
        models: { claude: pick("claude"), codex: pick("codex") },
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="dir-newproj" onSubmit={submit}>
      <h2 className="dir-title">{t("newProject.title")}</h2>
      <label>
        <span>{t("newProject.folder")}</span>
        <span className="dir-folder-row">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={t("newProject.folderHint")}
            required
          />
          <button type="button" className="dir-change" onClick={() => setPicking(true)}>
            <span aria-hidden>📂</span> {t("newProject.browse")}
          </button>
        </span>
      </label>
      {picking && (
        <FolderPicker
          start={cwd}
          onClose={() => setPicking(false)}
          onPick={(picked, isNew) => {
            setCwd(picked);
            if (isNew) setCreate(true);
            setPicking(false);
          }}
        />
      )}
      <label>
        <span>{t("newProject.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="dir-check">
        <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
        <span>{t("newProject.create")}</span>
      </label>
      <div className="dir-newproj-lead">
        <span className="dir-label">{t("newProject.lead")}</span>
        <span className="dir-lead-tile" data-agent="claude" aria-checked="true">
          <Mascot agent="claude" mode="done" size={36} reducedMotion />
          <span>Claude</span>
          <b className="dir-baton">{t("lead.badge")}</b>
        </span>
        <span className="dir-lead-tile" data-agent="codex" aria-disabled="true">
          <Mascot agent="codex" mode="done" size={36} reducedMotion />
          <span>Codex</span>
          <b className="dir-soon">{t("lead.soon")}</b>
        </span>
        <small>{t("newProject.codexSoon")}</small>
      </div>
      {AGENTS.map((agent) => (
        <fieldset key={agent} data-agent={agent}>
          <legend>{NAMES[agent]}</legend>
          <label>
            <span>{t("newProject.model")}</span>
            <input
              list={`dir-models-${agent}`}
              value={choice[`${agent}_model`] || ""}
              placeholder={t("newProject.default")}
              onChange={(e) => setChoice({ ...choice, [`${agent}_model`]: e.target.value })}
            />
            <datalist id={`dir-models-${agent}`}>
              {models[agent].map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </label>
          <label>
            <span>{t("newProject.effort")}</span>
            <select
              value={choice[`${agent}_effort`] || ""}
              onChange={(e) => setChoice({ ...choice, [`${agent}_effort`]: e.target.value })}
            >
              <option value="">{t("newProject.default")}</option>
              {EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      ))}
      {error && <p className="dir-error">{error}</p>}
      <div className="dir-newproj-actions">
        <button type="button" className="dir-change" onClick={onCancel}>
          {t("newProject.cancel")}
        </button>
        <button type="submit" className="dir-cta small" disabled={busy || !cwd.trim()}>
          {t("newProject.save")}
        </button>
      </div>
    </form>
  );
}

function AgentCard({
  agent,
  project,
  order,
  reducedMotion,
}: {
  agent: ConductorAgentName;
  project: ConductorProject | null;
  order: ConductorOrder | null;
  reducedMotion: boolean;
}) {
  const { t } = useTranslation("direccion");
  const state = stageAgent(agent, project, order);
  const working = !!order && isOrderLive(order) && state.doingKey !== "waitingHandoff";
  const tokens = compactTokens(state.tokens);
  return (
    <div className="dir-agent" data-agent={agent}>
      <Mascot
        agent={agent}
        mode={working ? "work" : order?.status === "done" ? "done" : "wait"}
        size={96}
        reducedMotion={reducedMotion}
      />
      <div className="dir-agent-body">
        <h3>
          {NAMES[agent]} {state.lead && <b className="dir-baton">{t("lead.badge")}</b>}
        </h3>
        <p className="dir-bubble" aria-live="polite">
          {state.doingKey ? t(`doing.${state.doingKey}`) : state.raw}
        </p>
        <div className="dir-chips">
          <Chip>{state.model || t("stage.defaultModel")}</Chip>
          {state.effort && <Chip tone="effort">{t("stage.effort", { effort: state.effort })}</Chip>}
          {tokens && <Chip tone="tok">{t("stage.tokens", { value: tokens })}</Chip>}
          {state.sessionId && (
            <Link className="dir-chip" data-tone="link" to={`/sessions/${state.sessionId}`}>
              {t("stage.session")}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function HandoffCard({ order }: { order: ConductorOrder | null }) {
  const { t } = useTranslation("direccion");
  const round = currentRound(order);
  if (!round) {
    return (
      <div className="dir-encargo" data-idle="1">
        <div className="dir-plane">✈️</div>
        <h4>{t("stage.noHandoff")}</h4>
        <p>{t("stage.quiet")}</p>
      </div>
    );
  }
  return (
    <div className="dir-encargo">
      <div className="dir-plane">✈️</div>
      <h4>{t("stage.handoff", { n: round.n, from: NAMES[round.from], to: NAMES[round.to] })}</h4>
      <p className="dir-clamp">{round.ask}</p>
      <span className="dir-stamp">{t("stage.stamp")}</span>
      <small>{t("stage.since", { time: formatTime(round.ask_at) })}</small>
    </div>
  );
}

/** Approval details are usually JSON tool input; indent it so commands and diffs read well. */
function prettyDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

/** Score text clamps to three lines; long plans and results expand on demand. */
function ScoreText({ text }: { text: string }) {
  const { t } = useTranslation("direccion");
  const [open, setOpen] = useState(false);
  const long = text.length > 180 || text.split("\n").length > 3;
  return (
    <>
      <span className="dir-clamp" data-open={open ? "1" : "0"}>
        {text}
      </span>
      {long && (
        <button
          type="button"
          className="dir-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? t("score.less") : t("score.more")}
        </button>
      )}
    </>
  );
}

function ApprovalCard({
  approval,
  onAnswer,
}: {
  approval: ConductorApproval;
  onAnswer: (answer: ConductorAnswer, note?: string) => Promise<void>;
}) {
  const { t } = useTranslation("direccion");
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (value: ConductorAnswer, text?: string) => {
    setBusy(true);
    try {
      await onAnswer(value, text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="dir-ok-card" data-agent={approval.agent}>
      <Mascot agent={approval.agent} mode="wait" size={48} reducedMotion />
      <div>
        <h4>
          {NAMES[approval.agent]}{" "}
          <span className="dir-kind">
            {approval.kind === "question" ? t("ok.question") : t("ok.permission")}
          </span>
        </h4>
        <p className="dir-ok-summary">{approval.summary}</p>
        {approval.detail && (
          <details className="dir-ok-detail">
            <summary>{t("ok.detail")}</summary>
            <pre>{prettyDetail(approval.detail)}</pre>
          </details>
        )}
        {approval.options?.length ? (
          <p>{t("ok.options", { options: approval.options.join(" · ") })}</p>
        ) : null}
        {noting && (
          <form
            className="dir-ok-note"
            onSubmit={(e) => {
              e.preventDefault();
              void answer("change", note.trim() || undefined);
            }}
          >
            <input
              autoFocus
              value={note}
              aria-label={t("ok.notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("ok.notePlaceholder")}
            />
            <button type="submit" className="dir-change" disabled={busy}>
              {t("ok.send")}
            </button>
          </form>
        )}
      </div>
      <div className="dir-ok-actions">
        <button className="dir-yes" disabled={busy} onClick={() => void answer("approve")}>
          {t("ok.approve")}
        </button>
        <button className="dir-change" disabled={busy} onClick={() => setNoting(!noting)}>
          {t("ok.change")}
        </button>
        <button className="dir-no" disabled={busy} onClick={() => void answer("stop")}>
          {t("ok.stop")}
        </button>
      </div>
    </article>
  );
}

function scoreLabel(row: ScoreRow, t: (key: string, options?: Record<string, unknown>) => string) {
  if (row.kind === "handoff") return t("score.handoff", { n: row.n, to: "Codex" });
  if (row.kind === "reply" || row.kind === "failed") return t(`score.${row.kind}`, { n: row.n });
  return t(`score.${row.kind}`);
}

function Partitura({ order }: { order: ConductorOrder | null }) {
  const { t } = useTranslation("direccion");
  const rows = scoreRows(order);
  return (
    <section className="dir-score">
      <h2 className="dir-title">{t("score.title")}</h2>
      {rows.length === 0 ? (
        <p className="dir-empty">{t("score.empty")}</p>
      ) : (
        <ol>
          {rows.map((row) => (
            <li key={row.key} data-kind={row.kind} data-who={row.who}>
              <time>{formatTime(row.at)}</time>
              <span className="dir-dot" />
              <div className="dir-score-text">
                <b>{scoreLabel(row, t)}</b>
                <ScoreText text={row.text} />
                {row.kind === "ok" && <em>{t(`score.answer.${row.answer || "pending"}`)}</em>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {order?.rounds.length ? (
        <Link className="dir-score-link" to="/charla">
          {t("score.charla")}
        </Link>
      ) : null}
    </section>
  );
}

export function Direccion() {
  const { t } = useTranslation("direccion");
  const reducedMotion = useReducedMotion();
  const [projects, setProjects] = useState<ConductorProject[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(readStored);
  const [order, setOrder] = useState<ConductorOrder | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [text, setText] = useState("");
  const [indication, setIndication] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [pitch, setPitch] = useState<ConductorPitch | null>(null);
  const [picks, setPicks] = useState<ConductorPitchPick[]>([]);
  const [depth, setDepth] = useState<ConductorPitchDepth>("normal");
  // The order and project the page is following; async results and WS handlers check
  // them so a late response never lands on a project Martin already left.
  const followed = useRef<string | null>(null);
  const selected = useRef<string | null>(projectId);
  selected.current = projectId;

  const project = projects?.find((p) => p.id === projectId) || null;

  const follow = useCallback((next: ConductorOrder | null) => {
    followed.current = next?.id || null;
    setOrder(next);
  }, []);
  const loadOrder = useCallback(async (id: string) => {
    const fresh = await api.conductor.getOrder(id);
    if (followed.current === id) setOrder(fresh);
  }, []);
  // Follow the project's newest order as the server sees it (initial load, other tabs, reconnects).
  const syncLatest = useCallback(
    async (pid: string) => {
      const { items } = await api.conductor.orders(pid, 1);
      if (selected.current !== pid) return;
      const latest = items[0];
      if (!latest) {
        if (!followed.current) follow(null);
        return;
      }
      if (latest.id !== followed.current) followed.current = latest.id;
      await loadOrder(latest.id);
    },
    [follow, loadOrder]
  );

  useEffect(() => {
    let disposed = false;
    setLoadError(false);
    api.conductor
      .projects()
      .then(({ items }) => {
        if (disposed) return;
        setProjects(items);
        setProjectId((current) =>
          current && items.some((p) => p.id === current) ? current : items[0]?.id || null
        );
        if (!items.length) setCreating(true);
      })
      .catch(() => {
        if (!disposed) setLoadError(true);
      });
    return () => {
      disposed = true;
    };
  }, [retry]);

  // Follow the selected project's latest order.
  useEffect(() => {
    follow(null);
    if (!projectId) return;
    store(projectId);
    let disposed = false;
    // Until the latest order is known, giving a new one could start a second lead.
    setLoadingOrder(true);
    syncLatest(projectId)
      .catch(() => {
        if (!disposed) setLoadError(true);
      })
      .finally(() => {
        if (!disposed) setLoadingOrder(false);
      });
    return () => {
      disposed = true;
    };
  }, [projectId, retry, follow, syncLatest]);

  // The project's latest pitch duel, so a duel survives reloads and other tabs.
  useEffect(() => {
    setPitch(null);
    setPicks([]);
    if (!projectId) return;
    let disposed = false;
    api.conductor
      .pitches(projectId, 1)
      .then(({ items }) => {
        if (!disposed && selected.current === projectId) setPitch(items[0] || null);
      })
      .catch(() => {
        /* The duel is optional; orders still work without it. */
      });
    return () => {
      disposed = true;
    };
  }, [projectId, retry]);

  // Live updates: agent snapshots merge in place; everything else refetches (grouped).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (job: () => Promise<void>) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void job().catch(() => {});
      }, 300);
    };
    const refresh = (id: string) => schedule(() => loadOrder(id));
    const resync = () => {
      if (projectId) schedule(() => syncLatest(projectId));
    };
    const unsubscribe = eventBus.subscribe((message) => {
      if (!message.type.startsWith("conductor_")) return;
      if (message.type === "conductor_pitch") {
        const next = message.data as ConductorPitch;
        if (next.project_id !== projectId) return;
        setPitch((current) =>
          !current || current.id === next.id || next.created_at >= current.created_at
            ? next
            : current
        );
        return;
      }
      if (message.type === "conductor_agent") {
        const agentState = message.data as ConductorAgentState;
        setOrder((current) =>
          current && current.id === agentState.orderId
            ? { ...current, agents: { ...current.agents, [agentState.agent]: agentState } }
            : current
        );
        return;
      }
      if (message.type === "conductor_order") {
        const row = message.data as { id: string; project_id?: string };
        if (row.id === followed.current) refresh(row.id);
        // Another order of this project (e.g. from another tab): ask the server which is newest
        // instead of letting any update of an older order take over the stage.
        else if (row.project_id && row.project_id === projectId) resync();
        return;
      }
      const id = (message.data as { order_id?: string }).order_id;
      if (id && id === followed.current) refresh(id);
    });
    const reconnect = eventBus.onConnection((connected) => {
      if (connected) resync();
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      reconnect();
    };
  }, [loadOrder, syncLatest, projectId]);

  const live = isOrderLive(order);
  // A finished lead keeps listening until it exits or a new order retires it.
  const talkable =
    live ||
    (order?.status === "done" &&
      ["running", "spawning"].includes(String(order.runs?.claude?.status)));
  const approvals = pendingApprovals(order);
  const orderLocked = !project || live || loadingOrder;

  const giveOrder = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !text.trim() || orderLocked) return;
    const pid = project.id;
    setBusy(true);
    setNotice(null);
    try {
      const created = await api.conductor.order(pid, text.trim());
      if (selected.current === pid) follow(created);
      setText("");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const propose = async () => {
    if (!project || !text.trim() || orderLocked) return;
    const pid = project.id;
    setBusy(true);
    setNotice(null);
    try {
      const created = await api.conductor.pitch(pid, text.trim(), depth);
      if (selected.current === pid) {
        setPitch(created);
        setPicks([]);
      }
      setText("");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const togglePick = (pick: ConductorPitchPick) =>
    setPicks((current) =>
      current.some((p) => pickKey(p) === pickKey(pick))
        ? current.filter((p) => pickKey(p) !== pickKey(pick))
        : [...current, pick]
    );
  const orderMix = async (note: string) => {
    if (!pitch || !project) return;
    const pid = project.id;
    setBusy(true);
    setNotice(null);
    try {
      const created = await api.conductor.orderPitch(pitch.id, picks, note || undefined);
      if (selected.current === pid) {
        follow(created);
        setPitch((current) => (current ? { ...current, status: "used" } : current));
        setPicks([]);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const discardPitch = async () => {
    if (!pitch) return;
    const current = pitch;
    setPicks([]);
    try {
      if (current.status === "drafting") setPitch(await api.conductor.stopPitch(current.id));
      setPitch((p) => (p && p.id === current.id ? { ...p, status: "stopped" } : p));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const pitchDrafting = pitch?.status === "drafting";

  const sendIndication = async (event: FormEvent) => {
    event.preventDefault();
    if (!order || !indication.trim()) return;
    setNotice(null);
    try {
      const { queued } = await api.conductor.indication(order.id, indication.trim());
      setIndication("");
      setNotice(queued ? t("foot.queued") : null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const answer = async (approval: ConductorApproval, value: ConductorAnswer, note?: string) => {
    try {
      await api.conductor.approve(approval.id, value, note);
      await loadOrder(approval.order_id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const stop = async () => {
    if (!order) return;
    const id = order.id;
    setConfirmStop(false);
    try {
      const stopped = await api.conductor.stopOrder(id);
      if (followed.current === id) setOrder(stopped);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  if (loadError) {
    return (
      <main className="dir-page">
        <section className="dir-alert" role="alert">
          <h2 className="dir-title">{t("error.load")}</h2>
          <button className="dir-cta small" onClick={() => setRetry((n) => n + 1)}>
            {t("error.retry")}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="dir-page">
      <header className="dir-head">
        <h1 className="dir-h1">{t("title")}</h1>
        <div className="dir-project">
          <span className="dir-label">{t("project.label")}</span>
          <select
            className="dir-folder"
            aria-label={t("project.label")}
            value={projectId || ""}
            onChange={(e) => setProjectId(e.target.value || null)}
          >
            {!projects?.length && <option value="">{t("project.pick")}</option>}
            {projects?.map((p) => (
              <option key={p.id} value={p.id} title={p.cwd}>
                📁 {p.name}
              </option>
            ))}
          </select>
          <button className="dir-new" onClick={() => setCreating(!creating)}>
            {t("project.new")}
          </button>
        </div>
        <LeadPicker lead={project?.lead || null} />
        {order && (
          <span className="dir-status" data-status={order.status}>
            {t(`status.${order.status}`)}
          </span>
        )}
        {approvals.length > 0 && (
          <a className="dir-ok-count" href="#dir-ok">
            {t("ok.count", { count: approvals.length })}
          </a>
        )}
      </header>

      {creating && (
        <NewProject
          onCancel={() => setCreating(false)}
          onCreated={(created) => {
            setProjects((list) => [created, ...(list || [])]);
            setProjectId(created.id);
            setCreating(false);
          }}
        />
      )}

      <section className="dir-atril">
        <h2 className="dir-title">{t("order.title")}</h2>
        <form className="dir-order" onSubmit={giveOrder}>
          <div className="dir-order-bubble">
            <textarea
              rows={3}
              value={text}
              aria-label={t("order.title")}
              placeholder={
                !project ? t("order.needProject") : live ? t("order.busy") : t("order.placeholder")
              }
              disabled={orderLocked}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="dir-order-actions">
            <button
              type="button"
              className="dir-cta duel-cta"
              disabled={orderLocked || busy || pitchDrafting || !text.trim()}
              onClick={() => void propose()}
            >
              {t("duel.cta")}
            </button>
            <div className="duel-depth" role="radiogroup" aria-label={t("duel.depth")}>
              {DEPTHS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={depth === value}
                  onClick={() => setDepth(value)}
                >
                  {t(`duel.depths.${value}`)}
                </button>
              ))}
            </div>
            <button className="dir-cta" disabled={orderLocked || busy || !text.trim()}>
              {t("order.cta")}
            </button>
          </div>
        </form>
        <p className="duel-hint">{t("duel.hint")}</p>
        <span className="dir-onoma" aria-hidden="true">
          {t("order.onoma")}
        </span>
        {projects !== null && !projects.length && (
          <p className="dir-empty">{t("empty.noProjects")}</p>
        )}
        {project && !order && !loadingOrder && <p className="dir-empty">{t("empty.noOrder")}</p>}
      </section>

      {showPitch(pitch) && pitch && (
        <Duelo
          pitch={pitch}
          picks={picks}
          onToggle={togglePick}
          onOrder={(note) => void orderMix(note)}
          onDiscard={() => void discardPitch()}
          busy={busy}
          locked={orderLocked}
        />
      )}

      <section className="dir-stage">
        <AgentCard agent="claude" project={project} order={order} reducedMotion={reducedMotion} />
        <HandoffCard order={order} />
        <AgentCard agent="codex" project={project} order={order} reducedMotion={reducedMotion} />
      </section>

      <section className="dir-ok" id="dir-ok">
        <h2 className="dir-title">{t("ok.title")}</h2>
        {approvals.length === 0 ? (
          <p className="dir-empty">{t("ok.empty")}</p>
        ) : (
          <div className="dir-ok-cards">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onAnswer={(value, note) => answer(approval, value, note)}
              />
            ))}
          </div>
        )}
      </section>

      <Partitura order={order} />

      {notice && (
        <p className="dir-notice" role="status">
          {notice}
        </p>
      )}

      {talkable && (
        <footer className="dir-foot">
          <form className="dir-foot-form" onSubmit={sendIndication}>
            <input
              value={indication}
              aria-label={t("foot.placeholder")}
              placeholder={t("foot.placeholder")}
              onChange={(e) => setIndication(e.target.value)}
            />
            <button className="dir-cta small" disabled={!indication.trim()}>
              {t("foot.send")}
            </button>
          </form>
          {confirmStop ? (
            <span className="dir-confirm">
              <b>{t("foot.confirmStop")}</b>
              <button className="dir-no" onClick={() => void stop()}>
                {t("foot.yes")}
              </button>
              <button className="dir-change" onClick={() => setConfirmStop(false)}>
                {t("foot.no")}
              </button>
            </span>
          ) : (
            <button className="dir-no" onClick={() => setConfirmStop(true)}>
              {t("foot.stop")}
            </button>
          )}
        </footer>
      )}
    </main>
  );
}
