/**
 * @file Board.tsx
 * @description Three session lanes with FLIP movement, completion confetti and an accessible sheet.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MuroPeriod } from "../../lib/types";
import { getCurrentLocale } from "../../lib/format";
import { LANES, sessionLane, type Lane, type MuroSession } from "./model";
import { PostIt } from "./PostIt";
import { SessionSheet } from "./SessionSheet";
import { confetti, useReducedMotion } from "./motion";
import "./board.css";

export function Board({
  sessions,
  period,
  filterKey,
}: {
  sessions: MuroSession[];
  period: MuroPeriod;
  filterKey: string;
}) {
  const { t } = useTranslation("muro");
  const reducedMotion = useReducedMotion();
  const root = useRef<HTMLElement>(null);
  const wrappers = useRef(new Map<string, HTMLDivElement>());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const previous = useRef(new Map<string, { rect: DOMRect; lane: Lane }>());
  const previousKey = useRef(filterKey);
  const animations = useRef<Animation[]>([]);
  const cleanups = useRef(new Set<() => void>());
  const [selected, setSelected] = useState<{ session: MuroSession; lane: Lane } | null>(null);
  const close = useCallback(() => setSelected(null), []);
  const getOrigin = useCallback(
    () => buttons.current.get(selected?.session.id ?? "") ?? root.current,
    [selected?.session.id]
  );
  const entries = sessions
    .map((session) => ({ session, lane: sessionLane(session, period) }))
    .filter((entry): entry is { session: MuroSession; lane: Lane } => entry.lane !== null);

  useLayoutEffect(() => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    const next = new Map<string, { rect: DOMRect; lane: Lane }>();
    for (const { session, lane } of entries) {
      const element = wrappers.current.get(session.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      next.set(session.id, { rect, lane });
      const before = previous.current.get(session.id);
      if (reducedMotion || previousKey.current !== filterKey || !element.animate) continue;
      if (before) {
        const dx = before.rect.left - rect.left,
          dy = before.rect.top - rect.top;
        if (dx || dy)
          animations.current.push(
            element.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], {
              duration: 550,
              easing: "cubic-bezier(.2,.8,.2,1)",
            })
          );
        if (before.lane !== "done" && lane === "done") {
          let dispose = () => {};
          const timer = setTimeout(() => {
            dispose = confetti(element, session.provider === "claude" ? "#D46F3A" : "#2BA394");
          }, 550);
          const cleanup = () => {
            clearTimeout(timer);
            dispose();
          };
          cleanups.current.add(cleanup);
          const expiry = setTimeout(() => {
            cleanup();
            cleanups.current.delete(cleanup);
            cleanups.current.delete(clearExpiry);
          }, 2200);
          const clearExpiry = () => clearTimeout(expiry);
          cleanups.current.add(clearExpiry);
        }
      } else if (previous.current.size) {
        animations.current.push(
          element.animate(
            [
              { opacity: 0, transform: "scale(.85)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 350, easing: "ease-out" }
          )
        );
      }
    }
    previous.current = next;
    previousKey.current = filterKey;
  });
  useEffect(() => {
    if (reducedMotion) {
      cleanups.current.forEach((cleanup) => cleanup());
      cleanups.current.clear();
    }
  }, [reducedMotion]);
  useEffect(
    () => () => {
      animations.current.forEach((animation) => animation.cancel());
      cleanups.current.forEach((cleanup) => cleanup());
    },
    []
  );

  const current =
    selected && (entries.find(({ session }) => session.id === selected.session.id) ?? selected);
  return (
    <section ref={root} className="muro-board" aria-label={t("board")} tabIndex={-1}>
      <div className="muro-lanes">
        {LANES.map((lane) => {
          const list = entries.filter((entry) => entry.lane === lane);
          return (
            <section className="muro-lane" key={lane} aria-label={t(`lanes.${lane}`)}>
              <h2>
                <span className={`muro-lane-dot ${lane}`} aria-hidden="true" />
                {t(`lanes.${lane}`)}
                <span className="muro-lane-count">
                  {list.length.toLocaleString(getCurrentLocale())}
                </span>
              </h2>
              <div className="muro-drop">
                {list.length ? (
                  list.map(({ session }) => (
                    <div
                      key={session.id}
                      data-session-id={session.id}
                      ref={(element) => {
                        if (element) wrappers.current.set(session.id, element);
                        else wrappers.current.delete(session.id);
                      }}
                    >
                      <PostIt
                        session={session}
                        lane={lane}
                        reducedMotion={reducedMotion}
                        buttonRef={(element) => {
                          if (element) buttons.current.set(session.id, element);
                          else buttons.current.delete(session.id);
                        }}
                        onOpen={() => setSelected({ session, lane })}
                      />
                    </div>
                  ))
                ) : (
                  <p className="muro-lane-empty">{t(`laneEmpty.${lane}`)}</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {current && (
        <SessionSheet
          session={current.session}
          lane={current.lane}
          reducedMotion={reducedMotion}
          getOrigin={getOrigin}
          onClose={close}
        />
      )}
    </section>
  );
}
