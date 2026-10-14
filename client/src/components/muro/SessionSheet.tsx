/**
 * @file SessionSheet.tsx
 * @description Accessible zooming session sheet with on-demand stats and focus restoration.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { api } from "../../lib/api";
import type { SessionStats } from "../../lib/types";
import { formatDuration, getCurrentLocale } from "../../lib/format";
import { Skeleton } from "../Skeleton";
import { Mascot } from "./Mascot";
import { IdeaTimeline, sessionIdeas } from "./KeyIdeas";
import { HandoffConversation } from "./Handoffs";
import { childHandoffs, sessionHandoff } from "./handoff-model";
import { modeFor, paper, rotation, sessionTitle, type Lane, type MuroSession } from "./model";

export function SessionSheet({
  session,
  lane,
  reducedMotion,
  getOrigin,
  onClose,
  relatedSessions = [],
  onNavigate,
  navigationError = false,
  handoffPeer = false,
}: {
  session: MuroSession;
  lane: Lane;
  reducedMotion: boolean;
  getOrigin: () => HTMLElement | null;
  onClose: () => void;
  relatedSessions?: MuroSession[];
  onNavigate?: (id: string) => void;
  navigationError?: boolean;
  handoffPeer?: boolean;
}) {
  const { t } = useTranslation("muro");
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const animation = useRef<Animation | null>(null);
  const closing = useRef(false);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const title = sessionTitle(session, t("stage.untitled"));
  const number = new Intl.NumberFormat(getCurrentLocale());
  const handoff = sessionHandoff(session);
  const children = childHandoffs(session, relatedSessions);
  useEffect(() => {
    closeButton.current?.focus();
  }, [session.id]);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setError(false);
    const request = handoffPeer
      ? api.sessions.stats(session.id, { handoffPeer: true })
      : api.sessions.stats(session.id);
    request
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, handoffPeer, retry]);

  useLayoutEffect(() => {
    const modal = dialog.current!;
    const source = getOrigin()?.getBoundingClientRect();
    if (modal.showModal) modal.showModal();
    else modal.setAttribute("open", "");
    closeButton.current?.focus();
    const target = panel.current!;
    const to = target.getBoundingClientRect();
    if (!reducedMotion && source?.width && to.width && target.animate) {
      animation.current = target.animate(
        [
          {
            transform: `translate(${source.left - to.left}px,${source.top - to.top}px) scale(${source.width / to.width},${source.height / to.height}) rotate(${rotation(session.id)}deg)`,
          },
          { transform: "none" },
        ],
        { duration: 520, easing: "cubic-bezier(.2,.9,.25,1.05)" }
      );
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      animation.current?.cancel();
      modal.close?.();
      document.body.style.overflow = overflow;
      getOrigin()?.focus();
    };
    // Opening/closing belongs to this sheet's lifetime, not stats or live session updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      animation.current?.cancel();
      if (closing.current) onClose();
    }
  }, [reducedMotion, onClose]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    animation.current?.cancel();
    const origin = getOrigin()?.getBoundingClientRect();
    const element = panel.current!;
    const current = element.getBoundingClientRect();
    if (reducedMotion || !origin?.width || !current.width || !element.animate) {
      onClose();
      return;
    }
    animation.current = element.animate(
      [
        { transform: "none" },
        {
          transform: `translate(${origin.left - current.left}px,${origin.top - current.top}px) scale(${origin.width / current.width},${origin.height / current.height}) rotate(${rotation(session.id)}deg)`,
        },
      ],
      { duration: 380, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }
    );
    animation.current.onfinish = onClose;
  };
  const tools = [...(stats?.tools_used ?? [])].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...tools.map((tool) => tool.count));
  const tokenTotal = stats
    ? Object.values(stats.tokens).reduce((total, value) => total + (value ?? 0), 0)
    : 0;

  return createPortal(
    <dialog
      ref={dialog}
      className="muro-dialog"
      aria-label={title}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
        if (event.key !== "Tab") return;
        const elements = panel.current?.querySelectorAll<HTMLElement>(
          ":is(button:not(:disabled), a[href], summary)"
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        ref={panel}
        className="muro-sheet"
        style={{ "--paper": paper(session.provider, lane) } as CSSProperties}
      >
        <button
          ref={closeButton}
          className="muro-sheet-close"
          type="button"
          aria-label={t("common:close")}
          onClick={close}
        >
          <X size={18} />
        </button>
        <div className="muro-sheet-hero">
          <Mascot
            agent={session.provider}
            mode={modeFor(lane)}
            size={120}
            reducedMotion={reducedMotion}
          />
          <div>
            <p className="muro-eyebrow">
              {session.provider === "claude" ? "Claude" : "Codex"} · {t(`lanes.${lane}`)}
            </p>
            <h2>{title}</h2>
          </div>
        </div>
        {handoff ? (
          <HandoffConversation handoff={handoff} onNavigate={onNavigate} />
        ) : (
          <p className="muro-ask">
            <b>{t("sheet.ask")}</b> {session.prompt_preview || t("sheet.noPrompt")}
          </p>
        )}
        {children.length > 0 && onNavigate && (
          <section className="muro-child-links" aria-label={t("handoffs.childList")}>
            <h3>{t("handoffs.childList")}</h3>
            {children.map((child) => (
              <button
                type="button"
                className="muro-session-link"
                key={child.id}
                onClick={() => onNavigate(child.id)}
              >
                {sessionTitle(child, t("stage.untitled"))} →
              </button>
            ))}
          </section>
        )}
        <IdeaTimeline ideas={sessionIdeas(session)} />
        {navigationError && <p role="alert">{t("sheet.error")}</p>}
        {error ? (
          <div role="alert" className="muro-sheet-message">
            <p>{t("sheet.error")}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              {t("common:retry")}
            </button>
          </div>
        ) : !stats ? (
          <Skeleton className="h-48 w-full my-4" label={t("sheet.loading")} />
        ) : (
          <>
            <div className="muro-sheet-stats">
              <div>
                <b>
                  {formatDuration(session.started_at, session.ended_at || new Date().toISOString())}
                </b>
                <span>{t("sheet.duration")}</span>
              </div>
              <div>
                <b>{number.format(tokenTotal)}</b>
                <span>{t("sheet.tokens")}</span>
              </div>
              <div>
                <b>{number.format(stats.files_touched?.length ?? 0)}</b>
                <span>{t("sheet.files")}</span>
              </div>
            </div>
            <h3>{t("sheet.tools")}</h3>
            <div className="muro-tools">
              {tools.length ? (
                tools.map((tool) => (
                  <div className="muro-tool" key={tool.tool_name}>
                    <span>{tool.tool_name}</span>
                    <span className="muro-tool-track" aria-hidden="true">
                      <span style={{ width: `${Math.max(6, (tool.count / max) * 100)}%` }} />
                    </span>
                    <span>{number.format(tool.count)}</span>
                  </div>
                ))
              ) : (
                <p>{t("sheet.noTools")}</p>
              )}
            </div>
            <h3>{t("sheet.touched")}</h3>
            <div className="muro-files">
              {stats.files_touched?.length ? (
                stats.files_touched.map((file) => <span key={file}>{file}</span>)
              ) : (
                <p>{t("sheet.noFiles")}</p>
              )}
            </div>
          </>
        )}
        <Link className="muro-session-link" to={`/sessions/${encodeURIComponent(session.id)}`}>
          {t("sheet.fullSession")} →
        </Link>
      </div>
    </dialog>,
    document.body
  );
}
