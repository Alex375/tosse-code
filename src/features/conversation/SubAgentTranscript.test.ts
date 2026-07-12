import { describe, it, expect } from "vitest";
import type { ConversationItem } from "../../ipc/client";
import { toRows } from "./SubAgentTranscript";

// Regression guard for the "zero silent error" contract on the read-only transcript view
// (history-panel preview + sub-agent drill-in): a `notice` item — e.g. `history_error` from
// a corrupt/unreadable rollout or transcript — must surface as its own row, never be dropped.
describe("SubAgentTranscript.toRows — notices are never dropped", () => {
  const user = (id: string, text: string): ConversationItem =>
    ({ kind: "user_message", id, text, parent_tool_use_id: null, replay: false }) as ConversationItem;
  const assistant = (id: string, text: string): ConversationItem =>
    ({ kind: "assistant_message", id, blocks: [{ type: "text", text }], parent_tool_use_id: null, turn_id: null }) as ConversationItem;
  const notice = (subtype: string, message: string): ConversationItem =>
    ({ kind: "notice", subtype, detail: { message } }) as ConversationItem;

  it("emits a notice row for a history_error item (does not swallow it)", () => {
    const rows = toRows([user("u1", "salut"), notice("history_error", "historique incomplet")]);
    const n = rows.find((r) => r.kind === "notice");
    expect(n).toBeDefined();
    expect(n).toMatchObject({ kind: "notice", subtype: "history_error" });
  });

  it("renders even a notice-only transcript (the blank-preview bug)", () => {
    // parse_rollout can return a notice-only vec when a rollout is unreadable; that must
    // produce a visible row, not an empty render.
    const rows = toRows([notice("history_error", "illisible")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("notice");
  });

  it("breaks the assistant run so the notice renders in place", () => {
    const rows = toRows([
      assistant("a1", "avant"),
      notice("history_error", "coupe ici"),
      assistant("a2", "après"),
    ]);
    // Two distinct assistant rows split by the notice → the notice is not merged/lost.
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "notice", "assistant"]);
  });
});
