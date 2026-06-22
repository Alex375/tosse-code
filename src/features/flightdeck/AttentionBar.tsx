// The "what needs you" strip across the top of the FlightDeck. Counts come from
// the shared status model (useFleetAttention → rowAttention over every agent), NOT
// from the desktop-notification edge — so it reflects the real action-required set
// (permission / questionnaire / open question / error / review), live.
import { Dot, Ico, type StreamState } from "../../ui/kit";
import { useFleetAttention } from "../../agent/fleet";

export function AttentionBar() {
  const a = useFleetAttention();
  const calm = a.total === 0;

  const chips: Array<[StreamState, string, number]> = [];
  if (a.needsInput + a.error > 0) chips.push(["ask", "Action requise", a.needsInput + a.error]);
  if (a.review > 0) chips.push(["review", "À relire", a.review]);

  return (
    <div className={"ag-attn" + (calm ? " calm" : "")}>
      <span className="wf-row" style={{ gap: 8 }}>
        <span style={{ display: "inline-flex", color: calm ? "var(--wf-tx-lo)" : "var(--wf-att)" }}>
          <Ico name="bell" className="sm" />
        </span>
        <span className="wf-hi" style={{ fontWeight: 600 }}>
          {calm
            ? "Aucun stream ne demande ton attention"
            : `${a.total} stream${a.total > 1 ? "s" : ""} demande${a.total > 1 ? "nt" : ""} ton attention`}
        </span>
      </span>
      {!calm ? (
        <div className="wf-row" style={{ gap: 8, marginLeft: "auto" }}>
          {chips.map(([s, label, n]) => (
            <span key={s} className="ag-attn-chip">
              <Dot s={s} pulse />
              <span className="wf-hi">{n}</span>
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
