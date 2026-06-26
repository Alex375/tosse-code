import { describe, expect, it } from "vitest";
import type { NormalizedBlock } from "../../ipc/client";
import {
  atomsToSegments,
  countWorkSteps,
  flattenWork,
  groupBlocks,
  isHiddenInline,
  liveVisibleStart,
  runHeader,
  splitFinalMessage,
  stepIcon,
  stepLabel,
  stepSummary,
  workStepIds,
  type Segment,
  type ToolStep,
} from "./toolGroup";

const mkStep = (name: string, input: unknown = {}): ToolStep => ({
  id: name,
  name,
  input: input as never,
});

const text = (t: string): NormalizedBlock => ({ type: "text", text: t });
const thinking = (t: string): NormalizedBlock => ({ type: "thinking", text: t });
const tool = (id: string, name: string, input: unknown = {}): NormalizedBlock => ({
  type: "tool_use",
  id,
  name,
  input: input as never,
});

describe("groupBlocks", () => {
  it("coalesces consecutive tool_use into one run", () => {
    const segs = groupBlocks([tool("a", "Read"), tool("b", "Read"), tool("c", "Edit")]);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("run");
    if (segs[0].kind === "run") expect(segs[0].steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("splits runs around assistant prose (the boundary the user chose)", () => {
    const segs = groupBlocks([
      text("Je vais explorer."),
      tool("a", "Read"),
      tool("b", "Grep"),
      text("Bonne base."),
      tool("c", "Bash"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["text", "run", "text", "run"]);
    if (segs[1].kind === "run") expect(segs[1].steps).toHaveLength(2);
    if (segs[3].kind === "run") expect(segs[3].steps).toHaveLength(1);
  });

  it("thinking also breaks a run", () => {
    const segs = groupBlocks([tool("a", "Read"), thinking("hmm"), tool("b", "Read")]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "thinking", "run"]);
  });

  it("skips hidden tools without breaking the surrounding run", () => {
    const segs = groupBlocks([
      tool("a", "Read"),
      tool("bg", "Bash", { run_in_background: true }), // detached → hidden
      tool("todo", "TodoWrite"), // suppressed → hidden
      tool("b", "Edit"),
    ]);
    expect(segs).toHaveLength(1);
    if (segs[0].kind === "run") expect(segs[0].steps.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("renders a foreground sub-agent as its own segment, breaking the run", () => {
    const segs = groupBlocks([tool("a", "Read"), tool("ag", "Agent"), tool("b", "Read")]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "agent", "run"]);
    if (segs[1].kind === "agent") expect(segs[1].step.id).toBe("ag");
  });

  it("hides a detached (background) sub-agent entirely", () => {
    const segs = groupBlocks([tool("ag", "Agent", { run_in_background: true })]);
    expect(segs).toEqual([]);
  });

  it("drops empty text/thinking placeholders", () => {
    const segs = groupBlocks([text(""), tool("a", "Read"), thinking("")]);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("run");
  });

  it("returns no run when every tool is hidden", () => {
    const segs = groupBlocks([tool("m", "Monitor"), tool("t", "TodoWrite")]);
    expect(segs).toEqual([]);
  });

  it("includeBackground keeps Monitor / detached Bash as steps but still drops suppressed tools", () => {
    const segs = groupBlocks(
      [
        tool("a", "Read"),
        tool("m", "Monitor"),
        tool("bg", "Bash", { run_in_background: true }),
        tool("todo", "TodoWrite"), // suppressed → hidden even on the disk view
        tool("b", "Edit"),
      ],
      true,
    );
    expect(segs).toHaveLength(1);
    if (segs[0].kind === "run")
      expect(segs[0].steps.map((s) => s.id)).toEqual(["a", "m", "bg", "b"]);
  });
});

describe("isHiddenInline", () => {
  it("hides Monitor, detached tools and suppressed tools; keeps foreground tools", () => {
    expect(isHiddenInline("Monitor", {})).toBe(true);
    expect(isHiddenInline("Bash", { run_in_background: true })).toBe(true);
    expect(isHiddenInline("TodoWrite", {})).toBe(true);
    expect(isHiddenInline("Bash", { command: "ls" })).toBe(false);
    expect(isHiddenInline("Read", { file_path: "/a.ts" })).toBe(false);
  });
});

describe("runHeader", () => {
  it("uses the full label for a single step", () => {
    expect(runHeader([mkStep("Read", { file_path: "/x/App.tsx" })])).toBe("Read App.tsx");
  });

  it("summarises distinct action verbs in order", () => {
    expect(runHeader([mkStep("Read"), mkStep("Grep"), mkStep("Glob")])).toBe(
      "Read · Search · Find",
    );
  });

  it("collapses a repeated verb with ×N", () => {
    expect(runHeader([mkStep("Read"), mkStep("Read"), mkStep("Read")])).toBe("Read ×3");
    expect(runHeader([mkStep("Bash"), mkStep("Bash"), mkStep("Edit")])).toBe("Run ×2 · Edit");
  });

  it("caps the number of verb groups", () => {
    expect(
      runHeader([
        mkStep("Read"),
        mkStep("Edit"),
        mkStep("Write"),
        mkStep("Bash"),
        mkStep("Grep"),
      ]),
    ).toBe("Read · Edit · Write · Run · +1");
  });

  it("aggregates MCP tools of one server as a count", () => {
    expect(
      runHeader([
        mkStep("mcp__claude_ai_TOSSE__create_task"),
        mkStep("mcp__claude_ai_TOSSE__get_tasks"),
        mkStep("mcp__claude_ai_TOSSE__update_task"),
      ]),
    ).toBe("claude ai TOSSE · 3 tools");
  });

  it("keeps separate MCP servers apart, singularising the count", () => {
    expect(
      runHeader([
        mkStep("mcp__claude_ai_TOSSE__create_task"),
        mkStep("mcp__claude_ai_TOSSE__get_tasks"),
        mkStep("mcp__playwright__browser_click"),
      ]),
    ).toBe("claude ai TOSSE · 2 tools · playwright · 1 tool");
  });

  it("mixes native verbs and MCP server groups", () => {
    expect(
      runHeader([
        mkStep("Read"),
        mkStep("Read"),
        mkStep("mcp__claude_ai_TOSSE__create_task"),
        mkStep("mcp__claude_ai_TOSSE__get_tasks"),
        mkStep("mcp__claude_ai_TOSSE__update_task"),
      ]),
    ).toBe("Read ×2 · claude ai TOSSE · 3 tools");
  });

  it("uses the full `<server> : <tool>` label for a single MCP step", () => {
    expect(runHeader([mkStep("mcp__claude_ai_TOSSE__create_task")])).toBe(
      "claude ai TOSSE : create_task",
    );
  });
});

describe("stepIcon", () => {
  it("maps known tools, MCP tools (plug) and unknowns (cog)", () => {
    expect(stepIcon("Read")).toBe("file");
    expect(stepIcon("Skill")).toBe("wand");
    expect(stepIcon("mcp__claude_ai_TOSSE__create_task")).toBe("plug");
    expect(stepIcon("Frobnicate")).toBe("cog");
  });
});

describe("stepLabel", () => {
  it("prefers the description for Bash/Agent", () => {
    expect(stepLabel("Bash", { command: "pnpm test", description: "Run the tests" })).toBe(
      "Run the tests",
    );
    expect(stepLabel("Agent", { description: "Explore backend" })).toBe("Explore backend");
  });

  it("falls back to name+arg phrasing for plain tools", () => {
    expect(stepLabel("Read", { file_path: "/x/App.tsx" })).toBe("Read App.tsx");
    expect(stepLabel("Edit", { file_path: "/x/foo.ts" })).toBe("Edit foo.ts");
  });
});

describe("stepSummary", () => {
  it("computes +N −M for an Edit from its input", () => {
    const s = stepSummary("Edit", { old_string: "a\nb", new_string: "a\nB\nc" }, null);
    expect(s?.kind).toBe("diff");
    if (s?.kind === "diff") {
      expect(s.added).toBeGreaterThan(0);
      expect(s.removed).toBeGreaterThan(0);
    }
  });

  it("counts written lines for Write, ignoring a single trailing newline", () => {
    expect(stepSummary("Write", { content: "l1\nl2\nl3" }, null)).toEqual({
      kind: "text",
      text: "3 lines",
    });
    // A file ending in "\n" (the common case) must not be counted as one extra line.
    expect(stepSummary("Write", { content: "l1\nl2\n" }, null)).toEqual({
      kind: "text",
      text: "2 lines",
    });
  });

  it("counts result lines for Grep, null when no result", () => {
    expect(stepSummary("Grep", { pattern: "x" }, "hit1\nhit2\n\nhit3")).toEqual({
      kind: "text",
      text: "3 results",
    });
    expect(stepSummary("Grep", { pattern: "x" }, null)).toBeNull();
  });

  it("returns null for tools without a cheap summary", () => {
    expect(stepSummary("Read", { file_path: "/a" }, "x\ny")).toBeNull();
  });
});

// Build segments via groupBlocks so the helpers are tested on real shapes.
const segs = (blocks: NormalizedBlock[]): Segment[] => groupBlocks(blocks);

describe("splitFinalMessage", () => {
  it("treats the trailing text as the final message, the rest as work", () => {
    const { work, final } = splitFinalMessage(
      segs([tool("a", "Read"), tool("b", "Edit"), text("Voilà, c'est fait.")]),
    );
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final.map((s) => s.kind)).toEqual(["text"]);
    if (final[0].kind === "text") expect(final[0].text).toBe("Voilà, c'est fait.");
  });

  it("keeps an INTERMEDIATE text (followed by tools) inside work", () => {
    const { work, final } = splitFinalMessage(
      segs([text("Je commence."), tool("a", "Read"), text("Terminé.")]),
    );
    // Only the LAST text is the final message; the opening text stays work.
    expect(work.map((s) => s.kind)).toEqual(["text", "run"]);
    expect(final).toHaveLength(1);
    if (final[0].kind === "text") expect(final[0].text).toBe("Terminé.");
  });

  it("only a final message (no work) → empty work", () => {
    const { work, final } = splitFinalMessage(segs([text("Juste une réponse.")]));
    expect(work).toEqual([]);
    expect(final).toHaveLength(1);
  });

  it("no trailing text (ends on tools) → empty final", () => {
    const { work, final } = splitFinalMessage(segs([tool("a", "Read"), tool("b", "Bash")]));
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final).toEqual([]);
  });

  it("folds several trailing text segments together as the final message", () => {
    const { work, final } = splitFinalMessage(
      segs([tool("a", "Read"), text("Première ligne."), text("Seconde ligne.")]),
    );
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final.map((s) => s.kind)).toEqual(["text", "text"]);
  });
});

describe("countWorkSteps", () => {
  it("counts tool steps across runs PLUS sub-agents, ignoring prose/thinking", () => {
    const s = segs([
      text("intro"),
      tool("a", "Read"),
      tool("b", "Edit"),
      thinking("hmm"),
      tool("ag", "Agent"),
      tool("c", "Bash"),
    ]);
    // runs: [Read, Edit] (2) + [Bash] (1) = 3 steps, + the sub-agent (folds into the block
    // in clean-output, so it counts as work) = 4.
    expect(countWorkSteps(s)).toBe(4);
  });

  it("is zero for prose/thinking only", () => {
    expect(countWorkSteps(segs([text("a"), thinking("b")]))).toBe(0);
  });
});

describe("workStepIds", () => {
  it("lists run step ids + sub-agent ids in order, skipping prose/thinking", () => {
    const s = segs([
      text("intro"),
      tool("a", "Read"),
      tool("b", "Edit"),
      thinking("hmm"),
      tool("ag", "Agent"),
      tool("c", "Bash"),
    ]);
    expect(workStepIds(s)).toEqual(["a", "b", "ag", "c"]);
  });

  it("is empty for prose/thinking only", () => {
    expect(workStepIds(segs([text("a"), thinking("b")]))).toEqual([]);
  });
});

describe("flattenWork / atomsToSegments", () => {
  it("flattens a run into one atom per step, then reconstructs it", () => {
    const work = segs([text("intro"), tool("a", "Read"), tool("b", "Edit"), tool("ag", "Agent")]);
    const atoms = flattenWork(work);
    expect(atoms.map((a) => a.kind)).toEqual(["text", "step", "step", "agent"]);
    const back = atomsToSegments(atoms, "x");
    // The two consecutive steps re-coalesce into one run; text + agent stay separate.
    expect(back.map((s) => s.kind)).toEqual(["text", "run", "agent"]);
    if (back[1].kind === "run") expect(back[1].steps.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("gives reconstructed runs stable, prefixed keys (no remount as the fold slides)", () => {
    const atoms = flattenWork(segs([tool("a", "Read"), tool("b", "Edit")]));
    const a = atomsToSegments(atoms, "vis");
    const b = atomsToSegments(atoms.slice(1), "vis");
    expect(a[0].key).toBe("vis-run-0");
    expect(b[0].key).toBe("vis-run-0"); // same key though it now holds only the 2nd step
  });
});

describe("liveVisibleStart", () => {
  const none = () => false;
  it("keeps the last `window` steps visible when nothing runs", () => {
    const atoms = flattenWork(segs([tool("a", "Read"), tool("b", "Read"), tool("c", "Read"), tool("d", "Read")]));
    // 4 steps, window 3 → fold the first, keep the last 3.
    expect(liveVisibleStart(atoms, none, 3)).toBe(1);
  });

  it("keeps a still-running tool visible even beyond the window", () => {
    const atoms = flattenWork(
      segs([tool("a", "Read"), tool("b", "Read"), tool("c", "Read"), tool("d", "Read"), tool("e", "Read")]),
    );
    // 'a' is still running → everything from index 0 stays visible despite the 3-step window.
    const running = (id: string) => id === "a";
    expect(liveVisibleStart(atoms, running, 3)).toBe(0);
  });

  it("keeps a running sub-agent visible while settled steps before it fold", () => {
    const atoms = flattenWork(
      segs([
        tool("a", "Read"),
        tool("b", "Read"),
        tool("c", "Read"),
        tool("d", "Read"),
        tool("ag", "Agent"),
      ]),
    );
    const running = (id: string) => id === "ag";
    // step 'a' folds; b,c,d (the window) + the running sub-agent stay visible.
    expect(liveVisibleStart(atoms, running, 3)).toBe(1);
  });

  it("keeps everything visible when there are fewer than `window` steps", () => {
    const atoms = flattenWork(segs([tool("a", "Read"), tool("b", "Read")]));
    expect(liveVisibleStart(atoms, none, 3)).toBe(0);
  });
});
