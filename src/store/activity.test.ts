import { describe, it, expect } from "vitest";
import { describeActivity, toolActivityLabel } from "./activity";
import type { SessionEntry, Turn, TimelineEntry, TodoItem, NormalizedBlock } from "./types";

function toolUse(id: string, name: string, input: unknown): NormalizedBlock {
  return { type: "tool_use", id, name, input } as NormalizedBlock;
}

function assistantTurn(id: string, blocks: NormalizedBlock[], streaming = ""): Turn {
  return {
    id,
    role: "assistant",
    status: streaming ? "streaming" : "final",
    streamingText: streaming,
    streamingThinking: "",
    blocks,
    parentToolUseId: null,
    hasThinking: false,
  };
}

function entry(opts: {
  turns?: Record<string, Turn>;
  timeline?: TimelineEntry[];
  toolResults?: Record<string, unknown>;
  todos?: TodoItem[];
}): SessionEntry {
  return {
    session: "s",
    state: {},
    timeline: opts.timeline ?? [],
    turns: opts.turns ?? {},
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: opts.toolResults ?? {},
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    todos: opts.todos ?? [],
    turnSeen: true,
    seq: 0,
  } as unknown as SessionEntry;
}

describe("toolActivityLabel", () => {
  it("names the file for read/edit/write", () => {
    expect(toolActivityLabel("Read", { file_path: "src/App.tsx" })).toBe("Lit App.tsx");
    expect(toolActivityLabel("Edit", { file_path: "a/b/middleware.ts" })).toBe("Modifie middleware.ts");
    expect(toolActivityLabel("Write", { file_path: "x.ts" })).toBe("Écrit x.ts");
  });

  it("previews a Bash command and a Grep pattern", () => {
    expect(toolActivityLabel("Bash", { command: "pnpm test" })).toBe("Exécute pnpm test");
    expect(toolActivityLabel("Grep", { pattern: "TODO" })).toBe("Cherche « TODO »");
  });

  it("names the notebook for NotebookEdit (reads notebook_path, not file_path)", () => {
    expect(toolActivityLabel("NotebookEdit", { notebook_path: "nb/analysis.ipynb" })).toBe(
      "Édite analysis.ipynb",
    );
  });

  it("falls back to the tool name for unknown tools", () => {
    expect(toolActivityLabel("Frobnicate", {})).toBe("Frobnicate…");
  });
});

describe("describeActivity", () => {
  it("describes a tool that is in flight (no result yet)", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Read", { file_path: "src/App.tsx" })]) },
      toolResults: {},
    });
    expect(describeActivity(e)).toBe("Lit App.tsx");
  });

  it("with parallel tools, shows a still-running earlier tool even if a later one finished first", () => {
    // One message batched three tools; the last block (Grep) finished first while
    // the Reads are still running. The live line must name a running Read, not fall
    // through to "Réfléchit…".
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: {
        t1: assistantTurn("t1", [
          toolUse("tu1", "Read", { file_path: "a.ts" }),
          toolUse("tu2", "Read", { file_path: "b.ts" }),
          toolUse("tu3", "Grep", { pattern: "TODO" }),
        ]),
      },
      toolResults: { tu3: { toolUseId: "tu3", content: "", isError: false, parentToolUseId: null } },
    });
    expect(describeActivity(e)).toBe("Lit b.ts");
  });

  it("prefers the current to-do once the tool has finished", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Read", { file_path: "src/App.tsx" })]) },
      toolResults: { tu1: { toolUseId: "tu1", content: "", isError: false, parentToolUseId: null } },
      todos: [{ content: "Migrer staging", status: "in_progress", activeForm: "Migre staging" }],
    });
    expect(describeActivity(e)).toBe("Migre staging");
  });

  it("says it's writing when streaming text with no tool/todo", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [], "Voici le correctif") },
    });
    expect(describeActivity(e)).toBe("Rédige une réponse…");
  });

  it("never shows a FINISHED tool — no stale 'Exécute …' leaking into the next turn", () => {
    // The previous turn ran a Bash echo that completed; a fresh turn is starting
    // with nothing produced yet. The finished echo must NOT be shown as activity.
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Bash", { command: "echo salut" })]) },
      toolResults: { tu1: { toolUseId: "tu1", content: "salut", isError: false, parentToolUseId: null } },
    });
    expect(describeActivity(e)).toBe("Réfléchit…");
  });

  it("never leaks a prior turn's result-less (interrupted) tool into a new empty turn", () => {
    // The previous turn was interrupted mid-Bash (no result synthesized), then a
    // fresh assistant turn starts empty. The stranded echo must NOT reappear.
    const e = entry({
      timeline: [
        { kind: "turn", id: "t1" },
        { kind: "turn_result", id: "tr" },
        { kind: "turn", id: "u1" },
        { kind: "turn", id: "t2" },
      ],
      turns: {
        t1: { ...assistantTurn("t1", [toolUse("tu1", "Bash", { command: "echo salut" })]), status: "interrupted" },
        u1: { ...assistantTurn("u1", []), role: "user", status: "final" },
        t2: assistantTurn("t2", []),
      },
      toolResults: {}, // interrupt synthesized no result for tu1
    });
    expect(describeActivity(e)).toBe("Réfléchit…");
  });

  it("shows nothing-in-flight when the latest main turn is the user's just-sent message", () => {
    // Between send and the agent's first output, the previous turn's result-less
    // tool must not be surfaced.
    const e = entry({
      timeline: [
        { kind: "turn", id: "t1" },
        { kind: "turn", id: "u1" },
      ],
      turns: {
        t1: { ...assistantTurn("t1", [toolUse("tu1", "Bash", { command: "echo salut" })]), status: "interrupted" },
        u1: { ...assistantTurn("u1", []), role: "user", status: "final" },
      },
      toolResults: {},
    });
    expect(describeActivity(e)).toBe("Réfléchit…");
  });

  it("falls back to thinking on an empty turn, and a neutral line with no entry", () => {
    expect(describeActivity(entry({}))).toBe("Réfléchit…");
    expect(describeActivity(undefined)).toBe("Travaille…");
  });
});
