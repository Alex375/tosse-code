// Read-only renderer for a `ConversationItem[]` transcript — the reusable brick for the
// sub-agent drill-in (live + disk), the history-panel preview, and the future Workflow /
// Fleet views. Pure: a function of the items handed in, no store reads.
//
// It renders the SAME "clean output" shape as the live thread: each user message is its own
// row, and every assistant turn until the next user message is concatenated into ONE
// response whose intermediate work (tool runs, thinking, in-between prose, sub-agents) folds
// behind a single "Travail de Claude" block, leaving only the concluding message in clear.
// Tool results arrive as their own `tool_result` items; we join them to their `tool_use` by
// id locally. The grouped sections + the fold are shared VERBATIM with the live thread
// (<ToolSection> / <StaticToolStep> / <ClaudeWorkBlock>), so disk and live never diverge.

import { useMemo, type ReactNode } from "react";
import type { ConversationItem, JsonValue, NormalizedBlock } from "../../ipc/client";
import { Avatar, ClaudeMark, UserMark } from "../../ui/kit";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  countWorkSteps,
  groupBlocks,
  runHeader,
  splitFinalMessage,
  type Segment,
} from "./toolGroup";
import { ClaudeWorkBlock, StaticToolStep, ToolSection } from "./ToolSection";
import { UserText } from "./userText";
import { parseSpecialMessage } from "./specialMessage";
import { SpecialMessageCard } from "./SpecialMessageCard";

interface JoinedResult {
  content: JsonValue;
  isError: boolean;
}

/** Render grouped segments statically (no store): prose / thinking inline, runs of tool
 *  calls coalesced into one collapsed section, a sub-agent as a single step. Shared by the
 *  folded work and the concluding message. */
function renderSegments(segments: Segment[], results: Map<string, JoinedResult>): ReactNode {
  return segments.map((seg) => {
    if (seg.kind === "text") return <StreamMarkdown key={seg.key} text={seg.text} />;
    if (seg.kind === "thinking") return <ThinkingBlock key={seg.key} text={seg.text} finalized />;
    // A nested sub-agent OR workflow OR proposed plan in a settled transcript: one step row
    // (no live card to drill into). These `.step` segments (vs the run branch's `.steps`) MUST
    // be handled here — otherwise they fall through to the run branch and crash. A sub-agent
    // proposing a plan is a non-case in practice, but the union requires the branch.
    if (seg.kind === "agent" || seg.kind === "workflow" || seg.kind === "plan")
      return <StaticToolStep key={seg.key} step={seg.step} result={results.get(seg.step.id)} />;
    // In-band markers only exist in the LIVE thread (interleaveMarkers); a disk transcript
    // has none, but the union requires the branch — render nothing.
    if (seg.kind === "marker") return null;
    const errored = seg.steps.some((s) => results.get(s.id)?.isError ?? false);
    return (
      <ToolSection key={seg.key} title={runHeader(seg.steps)} errored={errored}>
        {seg.steps.map((step) => (
          <StaticToolStep key={step.id} step={step} result={results.get(step.id)} />
        ))}
      </ToolSection>
    );
  });
}

/** One Claude response (everything between two user messages): intermediate work folds into a
 *  single "Travail de Claude" block, leaving only the concluding message in clear. A response
 *  that ends on tools (no concluding prose) renders unfolded, so something always stays in
 *  clear — mirrors the live thread's settled clean-output behaviour. */
function ClaudeResponse({
  blocks,
  results,
}: {
  blocks: NormalizedBlock[];
  results: Map<string, JoinedResult>;
}) {
  const segments = groupBlocks(blocks, true);
  if (segments.length === 0) return null;
  const { work, final } = splitFinalMessage(segments);
  const fold = work.length > 0 && final.length > 0;
  return (
    <div className="cv-msg cv-ai">
      <Avatar ai>
        <ClaudeMark />
      </Avatar>
      <div className="cv-aibody">
        {fold ? (
          <ClaudeWorkBlock count={countWorkSteps(work)}>
            {renderSegments(work, results)}
          </ClaudeWorkBlock>
        ) : (
          renderSegments(work, results)
        )}
        {renderSegments(final, results)}
      </div>
    </div>
  );
}

type Row =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; blocks: NormalizedBlock[] };

/** Collapse the flat item list into display rows: each user message is its own row; every
 *  assistant turn until the next user message is concatenated into ONE response (mirrors the
 *  live thread's MsgAIGroup), so the clean-output fold spans a whole multi-turn response. */
function toRows(items: ConversationItem[]): Row[] {
  const rows: Row[] = [];
  let cur: NormalizedBlock[] | null = null;
  items.forEach((it, i) => {
    if (it.kind === "user_message") {
      cur = null;
      rows.push({ kind: "user", key: it.id || `u-${i}`, text: it.text });
    } else if (it.kind === "assistant_message") {
      if (it.blocks.length === 0) return;
      if (!cur) {
        cur = [];
        rows.push({ kind: "assistant", key: it.id || `a-${i}`, blocks: cur });
      }
      cur.push(...it.blocks);
    }
    // tool_result joins via the results map; notice / streaming kinds aren't part of a
    // settled transcript view.
  });
  return rows;
}

/**
 * Render a finished transcript (sub-agent / history preview). Pure: depends only on `items`.
 */
export function SubAgentTranscript({ items }: { items: ConversationItem[] }) {
  const results = useMemo(() => {
    const map = new Map<string, JoinedResult>();
    for (const it of items) {
      if (it.kind === "tool_result") {
        map.set(it.tool_use_id, { content: it.content, isError: it.is_error });
      }
    }
    return map;
  }, [items]);
  const rows = useMemo(() => toRows(items), [items]);

  return (
    <div className="cv-subtranscript">
      {rows.map((r) => {
        if (r.kind !== "user")
          return <ClaudeResponse key={r.key} blocks={r.blocks} results={results} />;
        // Same routing as the live thread: an injected `<task-notification>` renders as
        // the clean card, not a raw user bubble — so history matches the conversation.
        const special = parseSpecialMessage(r.text);
        if (special) return <SpecialMessageCard key={r.key} data={special} />;
        return (
          <div className="cv-msg cv-user" key={r.key}>
            <Avatar user>
              <UserMark />
            </Avatar>
            <div className="cv-bubble">
              <UserText text={r.text} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
