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
  restart: "M17 11a6 6 0 1 1-2.2-4.6M17 5.5V9.5H13",
  form: "M5 4h12v14H5zM8 8h6M8 11h6M8 14h3",
  diamond: "M11 3 18 11 11 19 4 11Z",
  stopc: "M6 6h10v10H6z",
  trash: "M4 6h14M9 6V4h4v2M6 6l1 12h8l1-12M9.5 9.5v6M12.5 9.5v6",
  x: "M6 6l10 10M16 6 6 16",
  code: "M8 7l-4 4 4 4M14 7l4 4-4 4",
  splith: "M4 5h14v12H4zM11 5v12",
  splitv: "M4 5h14v12H4zM4 11h14",
  sidebar: "M4 5h14v12H4zM9 5v12",
};

export function Ico({ name, className }: { name: string; className?: string }) {
  const d = WF_PATHS[name] || WF_PATHS.dots;
  return (
    <svg className={"wf-ico " + (className || "")} viewBox="0 0 22 22" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** The Claude sunburst mark (the official Anthropic/Claude logo), filled with
 *  `currentColor` so it inherits the surrounding text colour — used for the model
 *  picker chip and Claude's message avatars. Reuses the brand asset already shipped
 *  in the repo (public/file-icons/claude.svg), inlined here for crisp tinting. */
export function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg className={"wf-claude " + (className || "")} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="m14.375 6.48.49.28v.209l-.14.489-5.937 1.397-.558-1.387zm0 0" />
      <path d="m12.155 2.373.683.143.182.224.173.535-.072.342-3.983 5.447L7.81 7.737l3.673-4.82z" />
      <path d="m8.719 1.522.419-.28.349.14.349.49-.957 5.748-.65-.441-.279-.769.49-4.33z" />
      <path d="m4.239 1.614.43-.55L4.95 1l.558.081.275.216 2.004 4.442.724 2.11-.848.471-3.231-5.864z" />
      <path d="m2.154 4.665-.14-.56.42-.488.488.07h.14l2.933 2.165.908.698 1.257.978-.698 1.187-.629-.489-.419-.419-4.05-2.863z" />
      <path d="M1.316 8.296 1 7.946v-.31l.316-.108 3.562.21 3.491.279-.113.695-6.66-.346z" />
      <path d="M3.411 11.931h-.698l-.278-.32v-.382l1.186-.838 4.82-3.068.487.833z" />
      <path d="m4.738 13.883-.28.07-.418-.21.07-.35 4.12-5.446.558.768-3.072 4.05z" />
      <path d="m8.23 14.581-.21.28-.419.14-.349-.28-.21-.42L8.09 8.646l.629.07z" />
      <path d="M11.791 13.045v.558l-.07.21-.279.14-.489-.066-3.356-4.996 1.331-1.014 1.117 2.025.105.733z" />
      <path d="m13.398 12.207.07.349-.21.279-.21-.07-1.187-.838-1.815-1.606-1.397-.978.419-1.326.698.419.42.768z" />
      <path d="m12.49 8.645 1.746.14.419.28.279.418v.302l-.768.327-3.911-.978-1.606-.07.419-1.466 1.117.838z" />
    </svg>
  );
}

/** A filled "person" glyph (`currentColor`) for the user's own message avatar —
 *  the human counterpart to {@link ClaudeMark}. */
export function UserMark({ className }: { className?: string }) {
  return (
    <svg className={"wf-user-mark " + (className || "")} viewBox="0 0 22 22" fill="currentColor" aria-hidden="true">
      <path d="M11 11.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z" />
      <path d="M4.9 17.8c0-2.8 2.7-4.6 6.1-4.6s6.1 1.8 6.1 4.6v.2H4.9Z" />
    </svg>
  );
}

export function Win({
  title,
  nav,
  right,
  banner,
  children,
}: {
  title?: ReactNode;
  nav?: ReactNode;
  right?: ReactNode;
  /** Full-width strip between the title bar and the body (e.g. update banner). */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="wf-win">
      <div className="wf-titlebar">
        {nav ? <div className="wf-tbnav">{nav}</div> : null}
        {title ? <span className="wf-title">{title}</span> : null}
        {right ? <div className="wf-tbright">{right}</div> : null}
      </div>
      {banner}
      <div className="wf-body">{children}</div>
    </div>
  );
}

export function NavBtn({
  icon,
  label,
  on,
  badge,
  title,
  onClick,
}: {
  icon?: string;
  label: string;
  on?: boolean;
  badge?: number | null;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button {...(on ? { "data-on": "" } : {})} title={title} onClick={onClick}>
      {icon ? <Ico name={icon} className="sm" /> : null}
      {label}
      {badge != null ? <span className="wf-badge att">{badge}</span> : null}
    </button>
  );
}

export type StreamState = "work" | "ask" | "err" | "review" | "done" | "arch" | "off";

export const WF_STATUS: Record<StreamState, { label: string; pill: string; dot: string }> = {
  work: { label: "En cours", pill: "run", dot: "run" },
  ask: { label: "Action requise", pill: "att", dot: "att" },
  err: { label: "Action requise", pill: "err", dot: "err" },
  review: { label: "À relire", pill: "wait", dot: "wait" },
  done: { label: "Actif", pill: "done", dot: "done" },
  arch: { label: "Archivé", pill: "arch", dot: "arch" },
  off: { label: "Éteint", pill: "off", dot: "off" },
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

export function Avatar({ children, ai, user }: { children: ReactNode; ai?: boolean; user?: boolean }) {
  return <span className={"wf-avatar" + (ai ? " ai" : "") + (user ? " user" : "")}>{children}</span>;
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
  onOpen,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trigger: ReactElement<any>;
  children: ReactNode;
  align?: "right";
  up?: boolean;
  /** Fired once each time the menu transitions closed → open (e.g. to refresh data). */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(useCallback(() => setOpen(false), []));
  return (
    <span className="wf-menu" ref={ref}>
      {cloneElement(trigger, {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          if (!open) onOpen?.();
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
  iconNode,
  children,
  ...rest
}: { icon?: string; iconNode?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  // A disabled chip opens no menu, so the dropdown chevron would be misleading.
  // `iconNode` lets a chip render a custom leading mark (e.g. the Claude logo)
  // instead of a named stroke icon.
  return (
    <button className="wf-chip" {...rest}>
      {iconNode ?? (icon ? <Ico name={icon} className="sm" /> : null)}
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

/** Subscription plan (rate-limit) snapshot, surfaced from `rate_limit_event`.
 *  The stream-json protocol only exposes the coarse status + reset time — NOT a
 *  usage percentage (that lives behind `/api/oauth/usage`). */
export interface PlanInfo {
  status: string | null;
  resetsAt: number | null;
  limitType: string | null;
  usingOverage: boolean;
}

/** Real usage fill of one rate-limit window (from `GET /api/oauth/usage`). Shape
 *  mirrors the core's `UsageWindow` so the generated type passes structurally.
 *  `resets_at` is a raw timestamp string (ISO 8601, or epoch-seconds digits). */
export interface PlanUsageWindow {
  used_percentage: number;
  resets_at: string | null;
}

/** Normalize a window's raw `resets_at` to Unix epoch SECONDS for `fmtReset`. Handles
 *  ISO 8601 (the live endpoint) via the native `Date` parser and a digits-only epoch
 *  (the alternate shape). `null` when absent/unparseable. */
function resetToEpochSeconds(s: string | null): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Real plan-usage %, the precise figure the stream does NOT carry. Each window is
 *  null when the endpoint did not report it. Mirrors the core's `PlanUsage`. */
export interface PlanUsageInfo {
  five_hour: PlanUsageWindow | null;
  seven_day: PlanUsageWindow | null;
}

/** Why the real plan-usage fetch failed — mirrors the core's `UsageError` union so
 *  the generated type passes structurally and the popover can branch on `kind`. */
export type PlanUsageError =
  | { kind: "no_token" }
  | { kind: "keychain_denied"; detail: string }
  | { kind: "unauthorized"; status: number }
  | { kind: "rate_limited"; retry_after: number | null }
  | { kind: "http"; status: number; body: string }
  | { kind: "network"; detail: string }
  | { kind: "parse"; body: string };

/** French message + actionable next step + retry-applies + raw detail, per cause.
 *  Single source of the copy so it lives in one place. */
function usageErrorCopy(e: PlanUsageError): {
  msg: string;
  action: string;
  retry: boolean;
  detail: string | null;
} {
  switch (e.kind) {
    case "no_token":
      return {
        msg: "Aucun jeton Claude trouvé.",
        action:
          "Connecte-toi via le CLI : lance « claude » dans un terminal, authentifie-toi, puis réessaie.",
        retry: true,
        detail: null,
      };
    case "keychain_denied":
      return {
        msg: "Accès au trousseau refusé.",
        action:
          "L'app n'est pas signée : clique « Toujours autoriser » sur le prompt du trousseau macOS, puis réessaie.",
        retry: true,
        detail: e.detail,
      };
    case "unauthorized":
      return {
        msg: `Jeton expiré ou révoqué (HTTP ${e.status}).`,
        action: "Relance une session « claude » pour rafraîchir le jeton, puis réessaie.",
        retry: true,
        detail: null,
      };
    case "rate_limited":
      return {
        msg: "Endpoint d'usage temporairement limité.",
        action: e.retry_after
          ? `L'endpoint /api/oauth/usage est lui-même rate-limité (il est aussi interrogé par le CLI). Réessaie dans ~${e.retry_after}s.`
          : "L'endpoint /api/oauth/usage est lui-même rate-limité (il est aussi interrogé par le CLI). Attends quelques minutes avant de réessayer.",
        retry: true,
        detail: null,
      };
    case "http":
      return {
        msg: `Le service d'usage a renvoyé une erreur (HTTP ${e.status}).`,
        action: "Réessaie dans un instant ; si ça persiste, signale-le avec les détails.",
        retry: true,
        detail: e.body,
      };
    case "network":
      return {
        msg: "Connexion au service d'usage impossible.",
        action: "Vérifie ta connexion internet, puis réessaie.",
        retry: true,
        detail: e.detail,
      };
    case "parse":
      return {
        msg: "Réponse illisible du service d'usage.",
        action: "Probablement un bug — signale-le avec les détails ci-dessous.",
        retry: false,
        detail: e.body,
      };
    default: {
      // Exhaustiveness guard: a new UsageError kind must be handled above (this line
      // fails to compile otherwise). At RUNTIME it also catches a foreign thrown value
      // (e.g. a raw transport Error that slipped past normalization) so the popover
      // degrades gracefully instead of crashing on `undefined.msg`.
      const _exhaustive: never = e;
      void _exhaustive;
      const detail =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      return {
        msg: "Erreur inattendue du service d'usage.",
        action: "Réessaie ; si ça persiste, signale-le avec les détails ci-dessous.",
        retry: true,
        detail,
      };
    }
  }
}

/** Turns a failed usage fetch into a concrete next step. Two modes:
 *  - full (no data yet): message + action + optional « Réessayer » + « Détails ».
 *  - `stale` (data already shown above): a compact non-destructive warning so a failed
 *    refresh is NEVER silent — the bars stay, but the user is told they may be stale. */
function UsageErrorCard({
  error,
  loading,
  onRetry,
  stale,
}: {
  error: PlanUsageError;
  loading?: boolean;
  onRetry?: () => void;
  stale?: boolean;
}) {
  const c = usageErrorCopy(error);
  const retryBtn =
    c.retry && onRetry ? (
      <button
        className="wf-pop-err-retry"
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
        disabled={loading}
      >
        <Ico name="refresh" className={"sm" + (loading ? " wf-spin-fast" : "")} />
        Réessayer
      </button>
    ) : null;

  if (stale) {
    return (
      <div className="wf-pop-staleerr">
        <span className="wf-pop-staleerr-msg">
          <Ico name="alert" className="sm" />
          Rafraîchissement échoué — chiffres possiblement périmés.
        </span>
        <div className="wf-pop-err-foot">
          {retryBtn}
          <details className="wf-pop-err-det" onClick={(e) => e.stopPropagation()}>
            <summary>Détails</summary>
            <pre className="wf-mono">{c.detail ? `${c.msg}\n${c.detail}` : c.msg}</pre>
          </details>
        </div>
      </div>
    );
  }
  return (
    <div className="wf-pop-err">
      <div className="wf-pop-err-msg">{c.msg}</div>
      <div className="wf-pop-err-act">{c.action}</div>
      {retryBtn || c.detail ? (
        <div className="wf-pop-err-foot">
          {retryBtn}
          {c.detail ? (
            <details className="wf-pop-err-det" onClick={(e) => e.stopPropagation()}>
              <summary>Détails</summary>
              <pre className="wf-mono">{c.detail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One window's real-usage bar: label · % · reset, with a fill that warns past 80%. */
function UsageRow({
  label,
  w,
  fallbackReset,
}: {
  label: string;
  w: PlanUsageWindow;
  fallbackReset: number | null;
}) {
  const pct = Math.min(100, Math.max(0, Math.round(w.used_percentage)));
  const warn = pct >= 80;
  const reset = resetToEpochSeconds(w.resets_at) ?? fallbackReset;
  return (
    <div className="wf-pop-usage">
      <div className="wf-pop-usage-top">
        <span>{label}</span>
        <span className="wf-mono">
          {pct}%{reset ? ` · ${fmtReset(reset)}` : ""}
        </span>
      </div>
      <div className="wf-pop-bar">
        <i className={warn ? "warn" : ""} style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

/** Map a rate-limit status to a label + colour token. */
function planStatus(status: string | null): { label: string; color: string } {
  switch (status) {
    case "allowed":
      return { label: "OK", color: "var(--wf-run)" };
    case "allowed_warning":
      return { label: "Proche limite", color: "var(--wf-att)" };
    case "rejected":
      return { label: "Limité", color: "var(--wf-err)" };
    default:
      return { label: status ?? "—", color: "var(--wf-tx-lo)" };
  }
}

/** Human label for a rate-limit window type. */
function planWindow(limitType: string | null): string {
  switch (limitType) {
    case "five_hour":
      return "5h";
    case "seven_day":
      return "7j";
    default:
      return limitType ?? "";
  }
}

/** "dans 2h14" / "dans 43min" / "imminent" — computed at render (popover re-opens). */
function fmtReset(resetsAt: number | null): string {
  if (!resetsAt) return "—";
  const secs = resetsAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "imminent";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `dans ${h}h${m.toString().padStart(2, "0")}` : `dans ${m}min`;
}

export function ContextRing({
  ctx,
  plan,
  label,
  disabled,
  onCompact,
  usage,
  usageLoading,
  usageError,
  onOpenUsage,
  onRefreshUsage,
}: {
  ctx: Ctx;
  plan?: PlanInfo | null;
  label?: boolean;
  disabled?: boolean;
  onCompact?: () => void;
  /** Real usage % (5h + weekly), from `GET /api/oauth/usage`. Null/absent → the
   *  popover falls back to the coarse `plan` status. */
  usage?: PlanUsageInfo | null;
  usageLoading?: boolean;
  /** Structured failure of the last usage fetch — drives a tailored guidance card. */
  usageError?: PlanUsageError | null;
  /** Fired when the popover opens — caller throttles (e.g. only if data is stale). */
  onOpenUsage?: () => void;
  /** Forced refresh from the manual button; also gates whether the button shows. */
  onRefreshUsage?: () => void;
}) {
  const sz = 16;
  const r = sz / 2 - 1.6;
  const c = 2 * Math.PI * r;
  const warn = ctx.pct >= 70;
  // No usage reported yet (fresh session, pre-first-turn) — quiet, non-interactive stub.
  if (disabled) {
    return (
      <button className="wf-ring" disabled title="Contexte — en attente du 1er tour">
        <svg width={sz} height={sz} viewBox={"0 0 " + sz + " " + sz}>
          <circle cx={sz / 2} cy={sz / 2} r={r} className="wf-ring-bg" />
        </svg>
      </button>
    );
  }
  const st = plan ? planStatus(plan.status) : null;
  const hasForfait = !!(plan || usage || usageLoading || usageError);
  return (
    <Menu
      align="right"
      up
      onOpen={onOpenUsage}
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
        <div className="wf-pop-ctx-line wf-mono">
          {ctx.used}/{ctx.max} tokens <span className={warn ? "warn" : "wf-pop-ctx-pct"}>({ctx.pct}%)</span>
        </div>
        <div className="wf-pop-bar">
          <i className={warn ? "warn" : ""} style={{ width: ctx.pct + "%" }} />
        </div>
        {hasForfait ? (
          <>
            <div className="wf-pop-sep" />
            <div className="wf-pop-h wf-pop-h-row">
              <span>Forfait</span>
              {onRefreshUsage ? (
                <button
                  className="wf-pop-refresh"
                  title="Rafraîchir l'usage"
                  aria-label="Rafraîchir l'usage"
                  aria-busy={usageLoading}
                  disabled={usageLoading}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRefreshUsage();
                  }}
                >
                  <Ico name="refresh" className={"sm" + (usageLoading ? " wf-spin-fast" : "")} />
                </button>
              ) : null}
            </div>
            {/* Real usage bars (precise %), when the endpoint reported them. */}
            {usage?.five_hour ? (
              <UsageRow
                label="5h"
                w={usage.five_hour}
                fallbackReset={plan?.limitType === "five_hour" ? plan.resetsAt : null}
              />
            ) : null}
            {usage?.seven_day ? (
              <UsageRow
                label="7j"
                w={usage.seven_day}
                fallbackReset={plan?.limitType === "seven_day" ? plan.resetsAt : null}
              />
            ) : null}
            {/* Coarse status pill (warning / rejected) — always informative. */}
            {st && plan ? (
              <div className="wf-pop-row">
                <span>Statut{!usage && planWindow(plan.limitType) ? ` · ${planWindow(plan.limitType)}` : ""}</span>
                <span className="wf-pop-pill">
                  <i style={{ background: st.color }} />
                  {st.label}
                </span>
              </div>
            ) : null}
            {/* No precise %: keep the coarse reset line (from the stream). */}
            {!usage && plan ? (
              <div className="wf-pop-row">
                <span>Réinitialisation</span>
                <span className="wf-mono">{fmtReset(plan.resetsAt)}</span>
              </div>
            ) : null}
            {/* A real error: actionable guidance (full card if no data, or a compact
                non-destructive "stale" warning if bars are already shown above). Never
                silent — a failed refresh after a prior success still surfaces here. */}
            {usageError ? (
              <UsageErrorCard
                error={usageError}
                loading={usageLoading}
                onRetry={onRefreshUsage}
                stale={!!usage}
              />
            ) : null}
            {!usage && !usageError && usageLoading ? (
              <div className="wf-pop-sub">Chargement de l'usage…</div>
            ) : null}
            {plan?.usingOverage ? <div className="wf-pop-sub">Overage actif</div> : null}
          </>
        ) : null}
        <div
          className="wf-pop-act"
          role="button"
          tabIndex={0}
          onClick={() => onCompact?.()}
          title="Envoyer /compact pour réduire le contexte"
        >
          <Ico name="spark" className="sm" />
          Compacter le contexte
        </div>
      </div>
    </Menu>
  );
}

/** Compact context-fill meter — a tiny bar + percentage (the card variant of the
 *  ContextRing). The exact "used / max" is in the hover title. */
export function ContextMeter({ ctx }: { ctx: Ctx }) {
  const warn = ctx.pct >= 70;
  return (
    <span className={"wf-ctxm" + (warn ? " warn" : "")} title={`Contexte ${ctx.used} / ${ctx.max}`}>
      <Ico name="gauge" className="sm" />
      <span className="wf-ctx">
        <i style={{ width: ctx.pct + "%" }} />
      </span>
      <span className="wf-mono" style={{ fontSize: 10.5 }}>
        {ctx.pct}%
      </span>
    </span>
  );
}

/** A todo segment's state for the {@link TodoPips} bar. */
export type TodoSeg = "todo" | "doing" | "done";

/** The to-do progress pips + ratio: one dash per task — grey (not started),
 *  amber (in progress), green (done) — followed by "done/total". */
export function TodoPips({ segs, done, total }: { segs: TodoSeg[]; done: number; total: number }) {
  return (
    <span
      className="wf-row"
      style={{ gap: 6, color: "var(--wf-tx-lo)", fontSize: 11 }}
      title="Avancement des tâches"
    >
      <span className="wf-todobar">
        {segs.map((s, i) => (
          <i key={i} className={"wf-todoseg " + s} />
        ))}
      </span>
      <span className="wf-mono">
        {done}/{total}
      </span>
    </span>
  );
}
