/**
 * @file Mascot.tsx
 * @description Presentational Claude and Codex SVG mascots ported from the Muro
 * prototype. Agent and mode select the drawing; CSS owns all motion.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import "./mascot.css";

export type MuroAgent = "claude" | "codex";
export interface MascotProps {
  agent: MuroAgent;
  mode: "work" | "wait" | "done";
  size?: number;
  reducedMotion?: boolean;
}

/** Decorative avatar; its containing card supplies the accessible text. */
export function Mascot({ agent, mode, size = 104, reducedMotion = false }: MascotProps) {
  const claude = agent === "claude";
  const animation = mode === "work" ? (claude ? "sweep" : "build") : mode;
  return (
    <svg
      className={`muro-mascot ${animation}`}
      data-agent={agent}
      data-mode={mode}
      data-reduced={reducedMotion ? "1" : "0"}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="50" cy="96" rx="26" ry="4" fill="rgba(0,0,0,.18)" />
      {mode === "work" &&
        (claude ? (
          <g className="dust">
            <circle cx="82" cy="92" r="4" fill="#c9b8a6" />
            <circle cx="86" cy="94" r="3" fill="#c9b8a6" />
            <circle cx="78" cy="94" r="3.5" fill="#c9b8a6" />
          </g>
        ) : (
          <>
            <g>
              <rect x="78" y="88" width="16" height="8" rx="1" fill="#c0603c" />
              <rect
                x="80"
                y="80"
                width="16"
                height="8"
                rx="1"
                fill="#c96a45"
                className="brick-new"
              />
            </g>
            <g className="spark">
              <path
                d="M86 86 l-6 -6 M86 86 l0 -9 M86 86 l7 -5"
                stroke="#F2C14E"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </g>
          </>
        ))}
      <g className="body-g">
        {claude ? (
          <>
            <path d="M24 70 Q22 36 50 34 Q78 36 76 70 Q76 94 50 94 Q24 94 24 70Z" fill="#D46F3A" />
            <path
              d="M30 50 Q50 40 70 50"
              fill="none"
              stroke="#e99a6f"
              strokeWidth="3"
              strokeLinecap="round"
              opacity=".6"
            />
            <path d="M44 34 Q50 20 56 34" fill="#D46F3A" />
            <circle cx="50" cy="22" r="4.5" fill="#F2C14E" />
            <g className="eyes">
              <ellipse cx="41" cy="58" rx="6" ry="7" fill="#fff" />
              <ellipse cx="59" cy="58" rx="6" ry="7" fill="#fff" />
              <circle cx="42.5" cy="59" r="3.2" fill="#1b1a24" />
              <circle cx="60.5" cy="59" r="3.2" fill="#1b1a24" />
            </g>
            <circle cx="34" cy="70" r="3.5" fill="#f59e7a" opacity=".7" />
            <circle cx="66" cy="70" r="3.5" fill="#f59e7a" opacity=".7" />
            <path
              d={mode === "wait" ? "M45 74 H55" : "M44 72 Q50 78 56 72"}
              fill="none"
              stroke="#1b1a24"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            {mode === "done" && (
              <path d="M26 64 L14 48" stroke="#D46F3A" strokeWidth="7" strokeLinecap="round" />
            )}
          </>
        ) : (
          <>
            <rect x="26" y="40" width="48" height="52" rx="12" fill="#2BA394" />
            <rect x="32" y="50" width="36" height="20" rx="7" fill="#123a35" />
            <g className="eyes">
              <rect x="38" y="56" width="8" height="8" rx="2" fill="#AEE8DE" />
              <rect x="54" y="56" width="8" height="8" rx="2" fill="#AEE8DE" />
            </g>
            <path
              d={mode === "wait" ? "M43 80 H57" : "M42 78 Q50 84 58 78"}
              fill="none"
              stroke="#123a35"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <path d="M24 42 Q24 24 50 24 Q76 24 76 42 Z" fill="#F2C14E" />
            <rect x="20" y="40" width="60" height="6" rx="3" fill="#d9a83a" />
            <rect x="46" y="24" width="8" height="16" rx="3" fill="#d9a83a" />
            {mode === "done" && (
              <path d="M28 60 L14 44" stroke="#2BA394" strokeWidth="7" strokeLinecap="round" />
            )}
          </>
        )}
      </g>
      {mode === "work" &&
        (claude ? (
          <g className="tool" data-tool="broom">
            <line
              x1="64"
              y1="62"
              x2="84"
              y2="90"
              stroke="#6b4a2b"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <path
              d="M76 88 L92 86 L95 97 L78 99 Z"
              fill="#E8C35A"
              stroke="#a8862c"
              strokeWidth="1.5"
            />
            <path
              d="M80 91 L81 98 M85 90 L86 98 M90 89 L91 97"
              stroke="#a8862c"
              strokeWidth="1.2"
            />
          </g>
        ) : (
          <g className="tool" data-tool="hammer">
            <line
              x1="66"
              y1="58"
              x2="86"
              y2="74"
              stroke="#6b4a2b"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <rect
              x="80"
              y="66"
              width="14"
              height="9"
              rx="2"
              fill="#5b6470"
              transform="rotate(38 87 70)"
            />
          </g>
        ))}
      {mode === "done" &&
        (claude ? (
          <g className="tool" data-tool="brush">
            <line
              x1="64"
              y1="62"
              x2="80"
              y2="44"
              stroke="#6b4a2b"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <path d="M78 40 q6 -6 10 0 q-4 6 -10 0z" fill="#D46F3A" />
          </g>
        ) : (
          <g className="tool" data-tool="wrench">
            <line
              x1="66"
              y1="58"
              x2="80"
              y2="40"
              stroke="#5b6470"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <circle cx="81" cy="38" r="5" fill="none" stroke="#5b6470" strokeWidth="3" />
          </g>
        ))}
      {mode === "wait" && (
        <>
          <text className="zz" x={claude ? 70 : 74} y={claude ? 30 : 22}>
            z
          </text>
          <text className="zz zz-small" x={claude ? 78 : 82} y={claude ? 20 : 12}>
            z
          </text>
        </>
      )}
    </svg>
  );
}
