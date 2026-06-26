import { useRef } from "react";
import { ChipBtn, Menu } from "../../ui/kit";
import { EFFORT_LABELS } from "../../agent/subagentMeta";

/**
 * Claude Code reasoning-effort levels (low → xhigh), plus the top "Ultra code"
 * tier. The CLI's runtime `effortLevel` enum is EXACTLY low/medium/high/xhigh
 * (verified against the binary); there is NO "max" wire value — it was a phantom
 * the CLI silently swallowed. "Ultra code" is NOT an effort value either: it is
 * xhigh + a separate `ultracode` flag, handled by the composer. Which levels a
 * model supports is per-model (Ultra code only on xhigh-capable models).
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "ultracode";

// Display labels are shared with the read-only effort surfaces (FlightDeck card,
// agent meta) via subagentMeta.EFFORT_LABELS so they can never drift.
const LABELS: Record<EffortLevel, string> = EFFORT_LABELS;
const ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "ultracode"];

/** Effort levels a model supports (Claude Code per-model table; [] = no effort).
 *  Conservative on purpose: a level the model doesn't accept would be silently
 *  swallowed by the CLI, so we only offer what's safe. The live `get_settings`
 *  read-back keeps the gauge honest if reality ever differs. */
export function effortLevelsForModel(model: string | null | undefined): EffortLevel[] {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) return []; // Haiku 4.5 has no effort support → slider hidden
  if (m.includes("opus")) return ["low", "medium", "high", "xhigh"]; // xhigh-capable
  if (m.includes("sonnet")) return ["low", "medium", "high"]; // no xhigh
  return ["low", "medium", "high"]; // safe fallback
}

/** Slider steps for a model: its levels, plus an Ultra code step if xhigh-capable. */
function stepsForModel(model: string | null | undefined): EffortLevel[] {
  const levels = effortLevelsForModel(model);
  return levels.includes("xhigh") ? [...levels, "ultracode"] : levels;
}

/** Clamp an effort to what a model supports (highest supported ≤ requested). */
export function clampEffort(effort: EffortLevel, model: string | null | undefined): EffortLevel {
  const steps = stepsForModel(model);
  if (steps.length === 0 || steps.includes(effort)) return effort;
  const reqIdx = ORDER.indexOf(effort);
  let best: EffortLevel | null = null;
  for (const s of steps) {
    const i = ORDER.indexOf(s);
    if (i <= reqIdx && (best === null || i > ORDER.indexOf(best))) best = s;
  }
  return best ?? steps[0];
}

// Thumb geometry — must match the .wf-eff-* CSS (--thumb-size 14px, inset 2px).
const span = "(100% - 18px)";
const posAt = (t: number) => `calc(2px + ${t} * ${span} + 7px)`;
const thumbAt = (t: number) => `calc(2px + ${t} * ${span})`;
// Fill's rounded right cap is centred on the thumb (thumb-centre + track half-height
// of 9px), so the coral wraps the thumb with a uniform 2px ring — symmetric with the
// 2px the thumb is inset on the left at the minimum step.
const fillAt = (t: number) => `calc(2px + ${t} * ${span} + 16px)`;

/**
 * A stepped effort slider modeled on Claude Code's: a pill track with a coral
 * fill, discrete notches and a thumb that snaps between rungs (click or drag).
 * Renders nothing when the model has no effort support (e.g. Haiku).
 */
export function EffortGauge({
  model,
  value,
  onChange,
}: {
  model: string | null | undefined;
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const steps = stepsForModel(model);
  if (steps.length === 0) return null;

  const last = steps.length - 1;
  const sel = Math.max(0, steps.indexOf(value));
  const current = steps[sel];
  const isUltra = current === "ultracode";
  const t = last === 0 ? 0 : sel / last;

  const pickFromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const idx = Math.round(frac * last);
    if (steps[idx] !== steps[sel]) onChange(steps[idx]);
  };

  const chip = (
    <ChipBtn icon="bolt" {...(sel > 0 ? { "data-eff-on": "" } : {})} {...(isUltra ? { "data-ultra": "" } : {})}>
      {LABELS[current]}
    </ChipBtn>
  );

  return (
    <Menu up trigger={chip}>
      <div className="wf-eff" onClick={(e) => e.stopPropagation()}>
        <div className="wf-eff-top">
          <span className="wf-eff-lbl">Effort de réflexion</span>
          <span className={"wf-eff-cur" + (isUltra ? " ultra" : "")}>{LABELS[current]}</span>
        </div>

        <div
          ref={trackRef}
          className={"wf-eff-track" + (isUltra ? " ultra" : "")}
          role="slider"
          aria-label="Effort de réflexion"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={sel}
          aria-valuetext={LABELS[current]}
          tabIndex={0}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            pickFromX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) pickFromX(e.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" && sel > 0) onChange(steps[sel - 1]);
            else if (e.key === "ArrowRight" && sel < last) onChange(steps[sel + 1]);
          }}
        >
          <div className={"wf-eff-fill" + (isUltra ? " ultra" : "")} style={{ width: fillAt(t) }} />
          {steps.map((lvl, i) => (
            <span
              key={lvl}
              className={"wf-eff-notch" + (i <= sel ? " on" : "") + (lvl === "ultracode" ? " ultra" : "")}
              style={{ left: posAt(i / last) }}
            />
          ))}
          <span className={"wf-eff-thumb" + (isUltra ? " ultra" : "")} style={{ left: thumbAt(t) }} />
        </div>
      </div>
    </Menu>
  );
}
