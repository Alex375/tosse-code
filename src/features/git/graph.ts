// Lay out a commit DAG into rails (the "git tree" graph), front-side. The Rust
// core only emits commits with their PARENT oids (a pure data source); deciding
// which column each commit sits on, and how the lines connect, is a pure UI
// concern computed here so it can be unit-tested without a renderer.
//
// The algorithm walks commits top-to-bottom (the order `git log --date-order`
// gives: children before parents). It keeps a set of active "lanes", each a
// column reserved for the next commit expected on it. A commit claims the
// lane(s) pointing at it (merging extra ones in), then routes its parents onto
// lanes below. Output is per-row line segments in a tiny coordinate system the
// component renders verbatim — no graph knowledge needed downstream.

/** Minimal shape the layout needs (a structural subset of `CommitInfo`). */
export interface GraphCommit {
  oid: string;
  parents: string[];
}

/**
 * One line segment within a row's band. Columns are integer lane indices; `y` is
 * a vertical fraction of the row (0 = top edge, 0.5 = the node, 1 = bottom edge),
 * so the renderer just multiplies by the row's pixel geometry. `col` selects the
 * lane's color.
 */
export interface GraphEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  col: number;
}

/** Layout of one commit row: the node's column and the segments to draw. */
export interface GraphRow {
  /** Column the commit's node sits on. */
  node: number;
  edges: GraphEdge[];
}

/** Full graph layout plus the number of columns used (for sizing the gutter). */
export interface Graph {
  rows: GraphRow[];
  width: number;
}

/** First free (null) lane, or a new column past the end. */
function firstFree(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

/**
 * Compute the rail layout for `commits` (in display order, children first).
 * Parents that fall outside the loaded page simply keep their lane open at the
 * bottom of the last row — the graph degrades gracefully under pagination.
 */
export function computeGraph(commits: GraphCommit[]): Graph {
  const rows: GraphRow[] = [];
  // lanes[col] = the oid that column is currently heading toward, or null.
  const lanes: (string | null)[] = [];
  let width = 0;

  for (const c of commits) {
    const edges: GraphEdge[] = [];

    // 1. The node's column: the leftmost lane already pointing at this commit,
    //    else a fresh lane (a branch tip with no child in the loaded page).
    let myCol = lanes.indexOf(c.oid);
    if (myCol === -1) myCol = firstFree(lanes);

    // 2. Every lane pointing at this commit connects into the node from above
    //    (the leftmost is the straight trunk; the rest are merges) and closes.
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === c.oid) {
        edges.push({ x1: j, y1: 0, x2: myCol, y2: 0.5, col: myCol });
        lanes[j] = null;
      }
    }
    lanes[myCol] = null; // free in case it was a fresh tip

    // 3. Unrelated lanes pass straight through this row, top to bottom.
    for (let j = 0; j < lanes.length; j++) {
      if (j !== myCol && lanes[j] !== null) {
        edges.push({ x1: j, y1: 0, x2: j, y2: 1, col: j });
      }
    }

    // 4. Route the parents onto lanes below. The first parent keeps the node's
    //    column (the trunk continues); extras open new lanes (a fork going down,
    //    which becomes a merge when the parent is reached). A parent already on a
    //    lane is reused, so two children of one commit converge instead of
    //    duplicating it.
    c.parents.forEach((p, idx) => {
      let target = lanes.indexOf(p);
      if (target === -1) {
        target = idx === 0 ? myCol : firstFree(lanes);
        lanes[target] = p;
      }
      edges.push({ x1: myCol, y1: 0.5, x2: target, y2: 1, col: target });
    });
    // A root commit (no parents) leaves its lane closed.

    for (const e of edges) width = Math.max(width, e.x1 + 1, e.x2 + 1);
    width = Math.max(width, myCol + 1);
    rows.push({ node: myCol, edges });
  }

  return { rows, width };
}
