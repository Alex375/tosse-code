// Conductor design-system primitives, ported to typed React from the design
// handoff's wirekit.jsx. Uses the global class-based stylesheet (conductor-wirekit.css).
import {
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

const WF_PATHS: Record<string, string> = {
  chat: "M3 11.5a6.5 6 0 0 1 6.5-6h1A6.5 6 0 0 1 17 11.5 6.5 6 0 0 1 10.5 17H6l-2.5 2v-3.2A6.4 6.4 0 0 1 3 11.5Z",
  grid: "M4 4h6v6H4zM12 4h6v6h-6zM4 12h6v6H4zM12 12h6v6h-6z",
  layers: "M11 3 3 7l8 4 8-4-8-4ZM3 13l8 4 8-4M3 10l8 4 8-4",
  folder: "M3 6a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z",
  branch: "M7 4v9m0 0a2 2 0 1 0 0 .01M7 13a6 6 0 0 0 6-6m0 0a2 2 0 1 0 0-.01M16 7v0",
  play: "M7 5l9 6-9 6V5Z",
  pause: "M8 5v12M14 5v12",
  stop: "M6 6h10v10H6z",
  check: "M4 11l5 5 9-11",
  plus: "M11 4v14M4 11h14",
  search: "M9.5 4a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11ZM14 14l4 4",
  dots: "M5 11h.01M11 11h.01M17 11h.01",
  arrow: "M5 11h12m-5-6 6 6-6 6",
  bell: "M6 9a5 5 0 0 1 10 0c0 4 2 5 2 5H4s2-1 2-5ZM9 18a2 2 0 0 0 4 0",
  clock: "M11 5a6 6 0 1 1 0 12 6 6 0 0 1 0-12ZM11 8v3l2 2",
  file: "M6 3h6l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM12 3v4h4",
  diff: "M11 4v6m-3-3h6M5 16h12",
  term: "M4 5h14v12H4zM7 9l3 2-3 2M12 13h3",
  send: "M4 11 18 4l-5 14-3-6-6-1Z",
  cog: "M11 8.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM11 3v2M11 17v2M3 11h2M17 11h2M5 5l1.5 1.5M16 16l-1.5-1.5M5 17l1.5-1.5M16 6l-1.5 1.5",
  list: "M7 5h11M7 11h11M7 17h11M3.5 5h.01M3.5 11h.01M3.5 17h.01",
  spark: "M11 3v4M11 15v4M3 11h4M15 11h4M6 6l2.5 2.5M16 16l-2.5-2.5M6 16l2.5-2.5M16 6l-2.5 2.5",
  key: "M13.5 4a4.5 4.5 0 1 0 3.2 7.7L19 14l-1.5 1.5L16 14l-1.5 1.5L13 14l1.3-1.3A4.5 4.5 0 0 0 13.5 4Zm-.5 3.5h.01",
  alert: "M11 4 3 17h16L11 4ZM11 9v4M11 16h.01",
  ask: "M8 8.5a3 3 0 1 1 4.2 2.7c-.8.4-1.2 1-1.2 1.9M11 16h.01",
  gauge: "M4 15a7 7 0 0 1 14 0M11 15l3.5-3.5",
  bolt: "M12 3 5 13h5l-1 8 7-10h-5l1-8Z",
  shield: "M11 3 4 6v5c0 4 3 6 7 8 4-2 7-4 7-8V6l-7-3Z",
  commit: "M3 11h5m6 0h5M11 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  pr: "M7 6v9M7 6a2 2 0 1 0-.01 0ZM7 15a2 2 0 1 0 .01 0ZM15 16a2 2 0 1 0 .01 0ZM15 14V9a2 2 0 0 0-2-2h-3l2.5-2.5M9.5 7 12 9.5",
  chev: "M6 9l5 5 5-5",
  refresh: "M4.5 11a6.5 6.5 0 0 1 11-4.7M15.5 3.5v3h-3M17.5 11a6.5 6.5 0 0 1-11 4.7M6.5 18.5v-3h3",
  form: "M5 4h12v14H5zM8 8h6M8 11h6M8 14h3",
  diamond: "M11 3 18 11 11 19 4 11Z",
  stopc: "M6 6h10v10H6z",
  trash: "M4 6h14M9 6V4h4v2M6 6l1 12h8l1-12M9.5 9.5v6M12.5 9.5v6",
};

export function Ico({ name, className }: { name: string; className?: string }) {
  const d = WF_PATHS[name] || WF_PATHS.dots;
  return (
    <svg className={"wf-ico " + (className || "")} viewBox="0 0 22 22" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Win({
  title,
  nav,
  right,
  children,
}: {
  title?: ReactNode;
  nav?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="wf-win">
      <div className="wf-titlebar">
        {nav ? <div className="wf-tbnav">{nav}</div> : null}
        {title ? <span className="wf-title">{title}</span> : null}
        {right ? <div className="wf-tbright">{right}</div> : null}
      </div>
      <div className="wf-body">{children}</div>
    </div>
  );
}

export function NavBtn({
  icon,
  label,
  on,
  badge,
  onClick,
}: {
  icon?: string;
  label: string;
  on?: boolean;
  badge?: number | null;
  onClick?: () => void;
}) {
  return (
    <button {...(on ? { "data-on": "" } : {})} onClick={onClick}>
      {icon ? <Ico name={icon} className="sm" /> : null}
      {label}
      {badge != null ? <span className="wf-badge att">{badge}</span> : null}
    </button>
  );
}

export type StreamState = "work" | "ask" | "err" | "review" | "done" | "arch";

export const WF_STATUS: Record<StreamState, { label: string; pill: string; dot: string }> = {
  work: { label: "En cours", pill: "run", dot: "run" },
  ask: { label: "Action requise", pill: "att", dot: "att" },
  err: { label: "Action requise", pill: "err", dot: "err" },
  review: { label: "À relire", pill: "wait", dot: "wait" },
  done: { label: "Terminé", pill: "done", dot: "done" },
  arch: { label: "Archivé", pill: "arch", dot: "arch" },
};
export const WF_ATTENTION: StreamState[] = ["ask", "err", "review"];

export function Dot({ s, pulse }: { s: StreamState; pulse?: boolean }) {
  const st = WF_STATUS[s]?.dot || "done";
  const live = pulse && (s === "work" || s === "ask" || s === "err");
  return <span className={"wf-dot " + st + (live ? " pulse" : "")} />;
}

export function Pill({
  s,
  children,
  icon,
}: {
  s: StreamState;
  children?: ReactNode;
  icon?: false;
}) {
  const st = WF_STATUS[s] || WF_STATUS.done;
  return (
    <span className={"wf-pill " + st.pill}>
      {icon === false ? null : (
        <span className={"wf-dot " + st.dot} style={{ boxShadow: "none", width: 6, height: 6 }} />
      )}
      {children || st.label}
    </span>
  );
}

export function Tag({ icon, children, title }: { icon?: string; children: ReactNode; title?: string }) {
  return (
    <span className="wf-tag" title={title}>
      {icon ? <Ico name={icon} className="sm" /> : null}
      {children}
    </span>
  );
}

export function Avatar({ children, ai }: { children: ReactNode; ai?: boolean }) {
  return <span className={"wf-avatar" + (ai ? " ai" : "")}>{children}</span>;
}

export function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    }
    function k(e: KeyboardEvent) {
      if (e.key === "Escape") onAway();
    }
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [onAway]);
  return ref;
}

export function Menu({
  trigger,
  children,
  align,
  up,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trigger: ReactElement<any>;
  children: ReactNode;
  align?: "right";
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(useCallback(() => setOpen(false), []));
  return (
    <span className="wf-menu" ref={ref}>
      {cloneElement(trigger, {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          setOpen((o) => !o);
        },
        "data-open": open ? "" : undefined,
      })}
      {open ? (
        <div
          className={"wf-pop" + (align === "right" ? " right" : "") + (up ? " up" : "")}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}

export function MenuItem({
  on,
  children,
  onClick,
  icon,
  hint,
  disabled,
}: {
  on?: boolean;
  children: ReactNode;
  onClick?: () => void;
  icon?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button className={"wf-mi" + (on ? " on" : "")} onClick={onClick} disabled={disabled}>
      <span className="wf-mi-ck">{on ? <Ico name="check" className="sm" /> : null}</span>
      {icon ? <Ico name={icon} className="sm" /> : null}
      <span className="wf-mi-t">{children}</span>
      {hint ? <span className="wf-mi-h wf-mono">{hint}</span> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="wf-mi-lbl">{children}</div>;
}

export function ChipBtn({
  icon,
  children,
  ...rest
}: { icon?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  // A disabled chip opens no menu, so the dropdown chevron would be misleading.
  return (
    <button className="wf-chip" {...rest}>
      {icon ? <Ico name={icon} className="sm" /> : null}
      {children ? <span className="wf-chip-t">{children}</span> : null}
      {rest.disabled ? null : <Ico name="chev" className="sm wf-chip-chev" />}
    </button>
  );
}

export interface Ctx {
  pct: number;
  used: string;
  max: string;
}

export function ContextRing({ ctx, label, disabled }: { ctx: Ctx; label?: boolean; disabled?: boolean }) {
  const sz = 16;
  const r = sz / 2 - 1.6;
  const c = 2 * Math.PI * r;
  const warn = ctx.pct >= 70;
  // The core does not expose context usage yet — render a quiet, non-interactive stub.
  if (disabled) {
    return (
      <button className="wf-ring" disabled title="Contexte — à venir">
        <svg width={sz} height={sz} viewBox={"0 0 " + sz + " " + sz}>
          <circle cx={sz / 2} cy={sz / 2} r={r} className="wf-ring-bg" />
        </svg>
      </button>
    );
  }
  return (
    <Menu
      align="right"
      up
      trigger={
        <button className={"wf-ring" + (warn ? " warn" : "")} title={"Contexte " + ctx.used + " / " + ctx.max}>
          <svg width={sz} height={sz} viewBox={"0 0 " + sz + " " + sz}>
            <circle cx={sz / 2} cy={sz / 2} r={r} className="wf-ring-bg" />
            <circle
              cx={sz / 2}
              cy={sz / 2}
              r={r}
              className="wf-ring-fg"
              style={{ strokeDasharray: c, strokeDashoffset: c * (1 - ctx.pct / 100) }}
              transform={"rotate(-90 " + sz / 2 + " " + sz / 2 + ")"}
            />
          </svg>
          {label ? <span className="wf-mono wf-chip-t">{ctx.pct}%</span> : null}
        </button>
      }
    >
      <div className="wf-pop-ctx" onClick={(e) => e.stopPropagation()}>
        <div className="wf-pop-h">Fenêtre de contexte</div>
        <div className="wf-pop-row">
          <span>Utilisé</span>
          <span className="wf-mono wf-hi">{ctx.used}</span>
        </div>
        <div className="wf-pop-row">
          <span>Fenêtre</span>
          <span className="wf-mono">{ctx.max}</span>
        </div>
        <div className="wf-pop-bar">
          <i className={warn ? "warn" : ""} style={{ width: ctx.pct + "%" }} />
        </div>
        <div className="wf-pop-sub">
          {ctx.pct}% utilisé · {100 - ctx.pct}% libre
        </div>
        <div className="wf-pop-act">
          <Ico name="spark" className="sm" />
          Compacter le contexte
        </div>
      </div>
    </Menu>
  );
}
