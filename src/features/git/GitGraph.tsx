// Renders the "git tree" gutter for ONE commit row, from the pure layout
// computed by `computeGraph` (graph.ts). Lanes are colored by column so a branch
// keeps a stable color down the list; diagonals are drawn as smooth S-curves so
// forks/merges read cleanly. Kept dumb on purpose — all topology lives in graph.ts.

import type { GraphRow } from "./graph";

/** Pixel width of one lane column. */
export const GRAPH_COL = 14;
/** Pixel height of one commit row — the commit text must match this exactly so
 *  the node lines up with its row. */
export const GRAPH_ROW_H = 38;
/** Node radius. */
const DOT_R = 3.4;

// Muted, distinguishable rail colors on the app's dark palette.
const RAIL_COLORS = [
  "#7aa2e3",
  "#5fb98c",
  "#e3a857",
  "#c98bdb",
  "#e0727c",
  "#56b6c2",
  "#cf9b6b",
];
const colorFor = (col: number) => RAIL_COLORS[((col % RAIL_COLORS.length) + RAIL_COLORS.length) % RAIL_COLORS.length];

const cx = (col: number) => (col + 0.5) * GRAPH_COL;
const cy = (frac: number) => frac * GRAPH_ROW_H;

/** Path for one segment: a straight line when vertical, an S-curve when it shifts columns. */
function segPath(x1: number, y1: number, x2: number, y2: number): string {
  const px1 = cx(x1);
  const py1 = cy(y1);
  const px2 = cx(x2);
  const py2 = cy(y2);
  if (x1 === x2) return `M${px1} ${py1} L${px2} ${py2}`;
  const ym = (py1 + py2) / 2;
  return `M${px1} ${py1} C${px1} ${ym} ${px2} ${ym} ${px2} ${py2}`;
}

export function GitGraph({ row, width }: { row: GraphRow; width: number }) {
  const w = Math.max(1, width) * GRAPH_COL;
  return (
    <svg
      className=""
      width={w}
      height={GRAPH_ROW_H}
      viewBox={`0 0 ${w} ${GRAPH_ROW_H}`}
      style={{ flex: "none", display: "block" }}
      aria-hidden="true"
    >
      {row.edges.map((e, i) => (
        <path
          key={i}
          d={segPath(e.x1, e.y1, e.x2, e.y2)}
          fill="none"
          stroke={colorFor(e.col)}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      ))}
      <circle
        cx={cx(row.node)}
        cy={cy(0.5)}
        r={DOT_R}
        fill={colorFor(row.node)}
        stroke="var(--wf-bg)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
