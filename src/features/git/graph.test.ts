import { describe, expect, it } from "vitest";
import { computeGraph, type GraphCommit } from "./graph";

// Helper: does a row carry a segment between two columns at the given y's?
function hasEdge(
  row: { edges: { x1: number; y1: number; x2: number; y2: number }[] },
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  return row.edges.some((e) => e.x1 === x1 && e.y1 === y1 && e.x2 === x2 && e.y2 === y2);
}

describe("computeGraph", () => {
  it("lays a linear history on a single column", () => {
    const commits: GraphCommit[] = [
      { oid: "c", parents: ["b"] },
      { oid: "b", parents: ["a"] },
      { oid: "a", parents: [] },
    ];
    const g = computeGraph(commits);
    expect(g.width).toBe(1);
    expect(g.rows.map((r) => r.node)).toEqual([0, 0, 0]);
    // Each non-root row routes its parent straight down on column 0.
    expect(hasEdge(g.rows[0], 0, 0.5, 0, 1)).toBe(true);
    // The root closes its lane: no downward parent edge.
    expect(g.rows[2].edges.some((e) => e.y2 === 1)).toBe(false);
  });

  it("forks a branch into a second column and merges it back", () => {
    // m is a merge of two branches off a common base.
    const commits: GraphCommit[] = [
      { oid: "m", parents: ["x", "y"] }, // merge commit
      { oid: "x", parents: ["base"] },
      { oid: "y", parents: ["base"] },
      { oid: "base", parents: [] },
    ];
    const g = computeGraph(commits);
    expect(g.width).toBe(2);

    // The merge sits on col 0, opens a second lane (col 1) for its 2nd parent.
    expect(g.rows[0].node).toBe(0);
    expect(hasEdge(g.rows[0], 0, 0.5, 0, 1)).toBe(true); // first parent → col 0
    expect(hasEdge(g.rows[0], 0, 0.5, 1, 1)).toBe(true); // second parent → col 1

    // x continues col 0 down to base.
    expect(g.rows[1].node).toBe(0);

    // y sits on col 1; its parent (base) already occupies col 0, so y converges
    // left into the base lane at the bottom of ITS row (a clean diamond), while
    // the base lane also passes straight through.
    expect(g.rows[2].node).toBe(1);
    expect(hasEdge(g.rows[2], 1, 0.5, 0, 1)).toBe(true); // y merges left into col 0
    expect(hasEdge(g.rows[2], 0, 0, 0, 1)).toBe(true); // base lane passes through

    // base claims col 0 with a straight trunk in, and closes (root, no children).
    const base = g.rows[3];
    expect(base.node).toBe(0);
    expect(hasEdge(base, 0, 0, 0, 0.5)).toBe(true);
    expect(base.edges.some((e) => e.y2 === 1)).toBe(false);
  });

  it("keeps an unrelated lane passing straight through", () => {
    // Two independent tips; the second's lane must pass through the first's row.
    const commits: GraphCommit[] = [
      { oid: "a1", parents: ["a0"] },
      { oid: "b1", parents: ["b0"] },
      { oid: "a0", parents: [] },
      { oid: "b0", parents: [] },
    ];
    const g = computeGraph(commits);
    expect(g.width).toBe(2);
    // a1 on col0; b1 opens col1. On b1's row, a's lane (col0, heading to a0)
    // passes through top→bottom.
    expect(g.rows[1].node).toBe(1);
    expect(hasEdge(g.rows[1], 0, 0, 0, 1)).toBe(true);
  });

  it("handles parents outside the loaded page without crashing", () => {
    // 'a' references parent 'z' which is never emitted (paginated away).
    const g = computeGraph([{ oid: "a", parents: ["z"] }]);
    expect(g.rows[0].node).toBe(0);
    // Lane stays open downward (edge to col 0 at the bottom).
    expect(hasEdge(g.rows[0], 0, 0.5, 0, 1)).toBe(true);
  });

  it("returns an empty layout for no commits", () => {
    expect(computeGraph([])).toEqual({ rows: [], width: 0 });
  });
});
