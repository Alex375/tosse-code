// The "Fleet readout" — an adaptive one-line summary of the whole fleet's agents by
// stage: "3 Running · 1 Review · 2 Need Attention · 5 Idle". Coloured numbers, no
// dots or icons, every stage rendered identically (Need Attention gets NO special
// emphasis — a deliberate call). Only non-zero stages show, activity-first order; when
// nothing is active it reads "Fleet rests · N Idle". Counts span EVERY conversation
// (whole fleet), so the sidebar box and the FlightDeck bar always agree.
//
// Two placements share this component via `variant`:
//   - "deck"    → the wide bar at the top of the FlightDeck (replaces the old
//                 AttentionBar), with the fleet total on the right.
//   - "sidebar" → a compact box pinned at the bottom of the conversation sidebar.
//
// Both are gated by their own Settings toggle at the call site, so this component only
// decides WHAT to render, never WHETHER to appear (beyond the empty-fleet guard).
import { Fragment } from "react";
import {
  useFleetCounts,
  fleetSegments,
  mergedFleetSegments,
  isFleetCalm,
  type FleetCounts,
} from "../agent/fleet";

/** The stage list, or the calm "Fleet rests · N Idle" phrasing. Shared by both
 *  variants; the deck lists all four stages, the sidebar the merged three
 *  ({@link mergedFleetSegments}: Review folded into Attention) so the words fit one
 *  line in the narrow panel. */
function ReadoutLine({ c, merged }: { c: FleetCounts; merged?: boolean }) {
  if (isFleetCalm(c)) {
    return (
      <span className="fr-line">
        <span className="fr-rest">Fleet rests</span>
        <span className="fr-sep">·</span>
        <span className="fr-seg idle">
          <span className="fr-n">{c.idle}</span>
          <span className="fr-l">Idle</span>
        </span>
      </span>
    );
  }
  const segs = merged ? mergedFleetSegments(c) : fleetSegments(c);
  return (
    <span className="fr-line">
      {segs.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 ? <span className="fr-sep">·</span> : null}
          <span className={"fr-seg " + s.key}>
            <span className="fr-n">{s.count}</span>
            <span className="fr-l">{s.label}</span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}

export function FleetReadout({ variant }: { variant: "deck" | "sidebar" }) {
  const c = useFleetCounts();
  // Nothing to summarise with an empty fleet — hide entirely rather than show a bare
  // "Fleet rests · 0 Idle". (The FlightDeck already early-returns on no repos, but the
  // sidebar can be empty too.)
  if (c.total === 0) return null;

  if (variant === "sidebar") {
    // Compact, single-line, footer-styled (like the Settings row just below it) — the
    // merged three-stage view keeps it discreet in the narrow panel.
    return (
      <div className="fr-side">
        <ReadoutLine c={c} merged />
      </div>
    );
  }

  return (
    <div className="fr-deck">
      <ReadoutLine c={c} />
      <span className="fr-total">
        <span className="fr-total-n">{c.total}</span> agents
      </span>
    </div>
  );
}
