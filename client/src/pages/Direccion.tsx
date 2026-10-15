/**
 * @file Direccion.tsx
 * @description Dirección as a whiteboard: a folder bar and a description box on top; on Enter
 *   Claude draws its board live (text, lists, charts, mockups, arrows), then Codex draws its
 *   own; finished boards stack in a timeline below. Any element can be zoomed, corrected while
 *   it is being drawn, or used to call Claude or Codex for a new sheet.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  getActiveProjectId,
  notifyProjectsChanged,
  setActiveProjectId,
  useActiveProjectId,
} from "../lib/activeProject";
import { eventBus } from "../lib/eventBus";
import type {
  ConductorAgentName,
  ConductorBoard,
  ConductorBrowse,
  ConductorProject,
  ConductorSheet,
} from "../lib/types";
import { Board, BoardThumb, elementName } from "../components/pizarra/Board";
import "../components/pizarra/pizarra.css";

const NAMES: Record<ConductorAgentName, string> = { claude: "Claude", codex: "Codex" };
const AGENTS: ConductorAgentName[] = ["claude", "codex"];
const samePath = (a: string, b: string) =>
  a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

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
    // Start where the current project lives; fall back to the home folder.
    api.conductor
      .browse(start.trim() || undefined)
      .then(setView)
      .catch(() => open());
    dialog.current?.focus();
  }, [start, open]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
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
    <div className="pz-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="pz-dialog pz-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t("picker.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pz-dialog-head">
          <h2>{t("picker.title")}</h2>
          <button
            type="button"
            className="pz-btn ghost"
            onClick={onClose}
            aria-label={t("picker.close")}
          >
            ✕
          </button>
        </div>
        <div className="pz-picker-body">
          <nav className="pz-picker-side" aria-label={t("picker.places")}>
            <span className="pz-label">{t("picker.drives")}</span>
            {view?.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="pz-place"
                aria-current={view.path === root.path}
                onClick={() => open(root.path)}
              >
                {root.name}
              </button>
            ))}
            <span className="pz-label">{t("picker.places")}</span>
            {view?.places.map((place, i) => (
              <button
                key={place.path}
                type="button"
                className="pz-place"
                aria-current={view.path === place.path}
                onClick={() => open(place.path)}
              >
                {i === 0 ? t("picker.home") : place.name}
              </button>
            ))}
          </nav>
          <div className="pz-picker-main">
            <div className="pz-picker-path">
              <button
                type="button"
                className="pz-btn"
                disabled={!view?.parent || loading}
                onClick={() => view?.parent && open(view.parent)}
              >
                ↑ {t("picker.up")}
              </button>
              <code title={view?.path}>{view?.path || "…"}</code>
            </div>
            {error && <p className="pz-error">{error}</p>}
            <ul className="pz-picker-list" aria-busy={loading}>
              {view && view.dirs.length === 0 && !loading && (
                <li className="pz-muted">{t("picker.empty")}</li>
              )}
              {view?.dirs.map((dir) => (
                <li key={dir.path}>
                  <button
                    type="button"
                    className="pz-folder"
                    title={dir.path}
                    onClick={() => open(dir.path)}
                  >
                    <span aria-hidden>▸</span>
                    <span>{dir.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            {view?.truncated && <small className="pz-muted">{t("picker.truncated")}</small>}
          </div>
        </div>
        <div className="pz-picker-foot">
          <label className="pz-picker-new">
            <span>{t("picker.newFolder")}</span>
            <input
              value={fresh}
              onChange={(e) => setFresh(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              placeholder={t("picker.newHint")}
            />
          </label>
          <button
            type="button"
            className="pz-btn"
            disabled={!view || !freshOk}
            onClick={() => view && onPick(join(view.path, freshName), true)}
          >
            {t("picker.createHere")}
          </button>
          <button
            type="button"
            className="pz-btn primary"
            disabled={!view || loading}
            onClick={() => view && onPick(view.path, false)}
          >
            {t("pizarra.useFolder")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The board that should be on stage: the one being drawn, else the newest finished one. */
function liveBoard(
  sheets: ConductorSheet[]
): { sheet: ConductorSheet; board: ConductorBoard } | null {
  const ordered = [...sheets].sort((a, b) => b.n - a.n);
  for (const sheet of ordered) {
    const drawing = sheet.boards.find((b) => b.status === "drafting");
    if (drawing) return { sheet, board: drawing };
  }
  const latest = ordered[0];
  if (!latest) return null;
  const shown = [...latest.boards].reverse().find((b) => b.elements.length) || latest.boards[0];
  return shown ? { sheet: latest, board: shown } : null;
}

export function Direccion() {
  const { t } = useTranslation("direccion");
  const location = useLocation();
  const projectId = useActiveProjectId();
  const [projects, setProjects] = useState<ConductorProject[] | null>(null);
  const [sheets, setSheets] = useState<ConductorSheet[]>([]);
  const [selected, setSelected] = useState<{ sheetId: string; boardId: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const current = useRef<string | null>(projectId);
  current.current = projectId;
  const project = projects?.find((p) => p.id === projectId) || null;

  // "New project" from the welcome screen or the sidebar switcher opens the folder picker.
  const wantsNew = !!(location.state as { newProject?: boolean } | null)?.newProject;
  useEffect(() => {
    if (wantsNew) setPicking(true);
  }, [wantsNew, location.key]);

  useEffect(() => {
    let disposed = false;
    setLoadError(false);
    api.conductor
      .projects()
      .then(({ items }) => {
        if (disposed) return;
        setProjects(items);
        const active = getActiveProjectId();
        setActiveProjectId(
          active && items.some((p) => p.id === active) ? active : items[0]?.id || null
        );
      })
      .catch(() => {
        if (!disposed) setLoadError(true);
      });
    return () => {
      disposed = true;
    };
  }, [retry]);

  const loadSheets = useCallback(async (pid: string) => {
    const { items } = await api.conductor.sheets(pid, 30);
    if (current.current === pid) setSheets(items);
  }, []);
  useEffect(() => {
    setSheets([]);
    setSelected(null);
    setExpanded(null);
    if (!projectId) return;
    loadSheets(projectId).catch(() => setLoadError(true));
  }, [projectId, retry, loadSheets]);

  useEffect(() => {
    const off = eventBus.subscribe((message) => {
      if (message.type !== "conductor_sheet") return;
      const sheet = message.data as ConductorSheet;
      if (sheet.project_id !== current.current) return;
      setSheets((list) => {
        const rest = list.filter((s) => s.id !== sheet.id);
        return [sheet, ...rest].sort((a, b) => b.n - a.n);
      });
    });
    const reconnect = eventBus.onConnection((connected) => {
      if (connected && current.current) void loadSheets(current.current).catch(() => {});
    });
    return () => {
      off();
      reconnect();
    };
  }, [loadSheets]);

  const active = sheets.find((s) => s.status === "drafting") || null;
  const drawing = active?.boards.find((b) => b.status === "drafting") || null;
  // While a board is being drawn the stage follows it; otherwise it shows what Martin picked.
  const pickedSheet = selected && sheets.find((s) => s.id === selected.sheetId);
  const picked = pickedSheet && pickedSheet.boards.find((b) => b.id === selected?.boardId);
  const stage =
    drawing && active
      ? { sheet: active, board: drawing }
      : pickedSheet && picked
        ? { sheet: pickedSheet, board: picked }
        : liveBoard(sheets);

  const usePath = async (path: string, isNew: boolean) => {
    setPicking(false);
    setMenu(false);
    setNotice(null);
    const known = projects?.find((p) => samePath(p.cwd, path));
    if (known) {
      setActiveProjectId(known.id);
      return;
    }
    try {
      const created = await api.conductor.createProject({
        cwd: path,
        create: isNew,
        lead: "claude",
      });
      setProjects((list) => [created, ...(list || [])]);
      setActiveProjectId(created.id);
      notifyProjectsChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const start = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!prompt.trim() || busy) return;
    if (!project) {
      setPicking(true);
      return;
    }
    if (active) return;
    setBusy(true);
    setNotice(null);
    try {
      const sheet = await api.conductor.sheet({ projectId: project.id, prompt: prompt.trim() });
      setSheets((list) => [sheet, ...list.filter((s) => s.id !== sheet.id)]);
      setSelected(null);
      setPrompt("");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const onPromptKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void start();
    }
  };
  const comment = async (board: ConductorBoard, elementId: string | null, text: string) => {
    setNotice(null);
    try {
      await api.conductor.commentBoard(board.id, text, elementId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const call = async (
    board: ConductorBoard,
    elementId: string | null,
    agent: ConductorAgentName,
    text: string
  ) => {
    if (!project) return;
    setNotice(null);
    try {
      const sheet = await api.conductor.sheet({
        projectId: project.id,
        prompt: text,
        agent,
        sourceBoardId: board.id,
        ...(elementId ? { sourceElementId: elementId } : {}),
      });
      setSheets((list) => [sheet, ...list.filter((s) => s.id !== sheet.id)]);
      setSelected(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const stop = async () => {
    if (!active) return;
    try {
      await api.conductor.stopSheet(active.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  if (loadError) {
    return (
      <main className="pz-page">
        <section className="pz-panel" role="alert">
          <p>{t("error.load")}</p>
          <button className="pz-btn primary" onClick={() => setRetry((n) => n + 1)}>
            {t("error.retry")}
          </button>
        </section>
      </main>
    );
  }

  const timeline = [...sheets].sort((a, b) => a.n - b.n);
  const stageBoard = stage?.board || null;
  const visible = stageBoard?.elements.filter((e) => e.kind !== "arrow") || [];
  const drawn = visible.length;
  const last = visible[visible.length - 1];

  return (
    <main className="pz-page">
      <div className="pz-app">
        <div className="pz-bar">
          <span className="pz-label">{t("pizarra.folder")}</span>
          <span className="pz-path" title={project?.cwd}>
            {project ? project.cwd : t("pizarra.noFolder")}
          </span>
          <div className="pz-menu-wrap">
            <button
              type="button"
              className="pz-btn"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => (projects?.length ? setMenu(!menu) : setPicking(true))}
            >
              {project ? t("pizarra.load") : t("pizarra.choose")}
            </button>
            {menu && (
              <div className="pz-menu" role="menu">
                {projects?.map((p) => (
                  <button
                    key={p.id}
                    role="menuitemradio"
                    aria-checked={p.id === projectId}
                    className="pz-menu-item"
                    onClick={() => {
                      setMenu(false);
                      setActiveProjectId(p.id);
                    }}
                  >
                    <b>{p.name}</b>
                    <small>{p.cwd}</small>
                  </button>
                ))}
                <button
                  role="menuitem"
                  className="pz-menu-item more"
                  onClick={() => {
                    setMenu(false);
                    setPicking(true);
                  }}
                >
                  {t("pizarra.otherFolder")}
                </button>
              </div>
            )}
          </div>
        </div>

        <form className="pz-prompt" onSubmit={start}>
          <div className="pz-prompt-field">
            <textarea
              value={prompt}
              rows={3}
              aria-label={t("pizarra.describe")}
              placeholder={active ? t("pizarra.busy") : t("pizarra.placeholder")}
              disabled={!!active}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onPromptKey}
            />
            <small>{t("pizarra.enterHint")}</small>
          </div>
          <button className="pz-btn primary big" disabled={!!active || busy || !prompt.trim()}>
            {t("pizarra.start")}
          </button>
        </form>

        <div className="pz-status" aria-live="polite">
          {stage ? (
            <>
              <span className="pz-who" data-agent={stage.board.agent}>
                <span
                  className="pz-dot"
                  data-live={stage.board.status === "drafting" ? "1" : "0"}
                />
                {NAMES[stage.board.agent]}
              </span>
              <span className="pz-doing">
                {stage.board.status === "drafting"
                  ? last
                    ? t("pizarra.drawing", { what: elementName(last) })
                    : t("pizarra.reading")
                  : t(`pizarra.boardStatus.${stage.board.status}`)}
              </span>
              <span className="pz-count">{t("pizarra.count", { count: drawn })}</span>
              {active && (
                <button type="button" className="pz-btn ghost" onClick={() => void stop()}>
                  {t("pizarra.stop")}
                </button>
              )}
            </>
          ) : (
            <span className="pz-doing">{project ? t("pizarra.idle") : t("pizarra.pickFirst")}</span>
          )}
        </div>

        <section className="pz-stage">
          {stage ? (
            <>
              {stage.sheet.boards.length > 1 && (
                <div className="pz-tabs" role="tablist">
                  {stage.sheet.boards.map((b) => (
                    <button
                      key={b.id}
                      role="tab"
                      data-agent={b.agent}
                      aria-selected={b.id === stage.board.id}
                      onClick={() => setSelected({ sheetId: stage.sheet.id, boardId: b.id })}
                    >
                      {t("pizarra.boardOf", { name: NAMES[b.agent] })}
                      <small>{t(`pizarra.boardStatus.${b.status}`)}</small>
                    </button>
                  ))}
                </div>
              )}
              <Board
                key={stage.board.id}
                board={stage.board}
                prompt={stage.sheet.prompt}
                onComment={(elementId, text) => comment(stage.board, elementId, text)}
                onCall={(elementId, agent, text) => call(stage.board, elementId, agent, text)}
                canCall={!active}
              />
            </>
          ) : (
            <div className="pz-empty">
              <h2>{t("pizarra.emptyTitle")}</h2>
              <p>{t("pizarra.emptyText")}</p>
            </div>
          )}
        </section>

        {notice && (
          <p className="pz-notice" role="status">
            {notice}
          </p>
        )}

        <section className="pz-timeline" aria-label={t("pizarra.timeline")}>
          <div className="pz-timeline-head">
            <span className="pz-label">{t("pizarra.timeline")}</span>
            <span className="pz-legend">
              {AGENTS.map((agent) => (
                <span key={agent} data-agent={agent}>
                  <i />
                  {NAMES[agent]}
                </span>
              ))}
            </span>
          </div>
          {timeline.length === 0 ? (
            <p className="pz-muted">{t("pizarra.timelineEmpty")}</p>
          ) : (
            <ol className="pz-tl">
              {timeline.map((sheet) => {
                const open = expanded === sheet.id;
                return (
                  <li key={sheet.id} className="pz-tl-item" data-open={open ? "1" : "0"}>
                    <button
                      type="button"
                      className="pz-pair"
                      aria-expanded={open}
                      aria-current={stage?.sheet.id === sheet.id}
                      onClick={() => {
                        setExpanded(open ? null : sheet.id);
                        const first =
                          sheet.boards.find((b) => b.elements.length) || sheet.boards[0];
                        if (first) setSelected({ sheetId: sheet.id, boardId: first.id });
                      }}
                    >
                      {sheet.boards.map((b) => (
                        <BoardThumb key={b.id} board={b} />
                      ))}
                    </button>
                    <span className="pz-cap">
                      <b>{sheet.n}</b> · {sheet.prompt}
                    </span>
                    {open && (
                      <div className="pz-open-boards">
                        {sheet.boards.map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            data-agent={b.agent}
                            aria-current={stage?.board.id === b.id}
                            onClick={() => setSelected({ sheetId: sheet.id, boardId: b.id })}
                          >
                            <BoardThumb board={b} large />
                            <span>
                              {t("pizarra.boardOf", { name: NAMES[b.agent] })} ·{" "}
                              {t(`pizarra.boardStatus.${b.status}`)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
      {picking && (
        <FolderPicker
          start={project?.cwd || ""}
          onClose={() => setPicking(false)}
          onPick={usePath}
        />
      )}
    </main>
  );
}
