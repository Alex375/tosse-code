// Read-only renderer for a `ConversationItem[]` transcript — the reusable brick for
// showing a sub-agent's full conversation (read from disk via
// `load_subagent_transcript`), and the same renderer the future Workflow view and
// Fleet drill-down will reuse. Unlike the live thread it does NOT read the store: it
// is a pure function of the items handed in.
//
// Tool results arrive as their OWN `tool_result` items; we join them to their
// `tool_use` block by id locally. Rendering — the grouped "Exécuté N étapes"
// sections — is shared VERBATIM with the live thread via <ToolSection> /
// <StaticToolStep>, so the off-thread transcript and the live conversation never
// diverge.

import { useMemo } from "react";
import type { ConversationItem, JsonValue, NormalizedBlock } from "../../ipc/client";
import { Avatar, ClaudeMark, UserMark } from "../../ui/kit";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { groupBlocks, runHeader } from "./toolGroup";
import { StaticToolStep, ToolSection } from "./ToolSection";

interface JoinedResult {
  content: JsonValue;
  isError: boolean;
}

/** An assistant turn's blocks, grouped exactly like the live thread: prose / thinking
 *  inline, runs of consecutive tool calls coalesced into one collapsed section. */
function TranscriptBlocks({
  blocks,
  results,
}: {
  blocks: NormalizedBlock[];
  results: Map<string, JoinedResult>;
}) {
  // Disk view: keep background tools (Monitor / detached Bash) as steps — there is no
  // live bar here to show them, so hiding them would silently drop the only record.
  const segments = groupBlocks(blocks, true);
  return (
    <>
      {segments.map((seg) => {
        if (seg.kind === "text") return <StreamMarkdown key={seg.key} text={seg.text} />;
        if (seg.kind === "thinking")
          return <ThinkingBlock key={seg.key} text={seg.text} finalized />;
        // A nested sub-agent OR workflow in a settled transcript: render it as a single step
        // row (the disk view has no live card to drill into).
        if (seg.kind === "agent" || seg.kind === "workflow")
          return <StaticToolStep key={seg.key} step={seg.step} result={results.get(seg.step.id)} />;
        const errored = seg.steps.some((s) => results.get(s.id)?.isError ?? false);
        return (
          <ToolSection key={seg.key} title={runHeader(seg.steps)} errored={errored}>
            {seg.steps.map((step) => (
              <StaticToolStep key={step.id} step={step} result={results.get(step.id)} />
            ))}
          </ToolSection>
        );
      })}
    </>
  );
}

/**
 * Render a finished transcript (e.g. a sub-agent's). Pure: depends only on `items`.
 * Renders user turns and assistant turns (text / thinking / grouped tool sections).
 * The streaming-only kinds (`message_started`, `*_delta`) and `turn_result` /
 * `notice` are not part of a settled transcript view.
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

  return (
    <div className="cv-subtranscript">
      {items.map((it, i) => {
        if (it.kind === "user_message") {
          return (
            <div className="cv-msg cv-user" key={it.id || i}>
              <Avatar user>
                <UserMark />
              </Avatar>
              <div className="cv-bubble">{it.text}</div>
            </div>
          );
        }
        if (it.kind === "assistant_message") {
          if (it.blocks.length === 0) return null;
          return (
            <div className="cv-msg cv-ai" key={it.id || i}>
              <Avatar ai>
                <ClaudeMark />
              </Avatar>
              <div className="cv-aibody">
                <TranscriptBlocks blocks={it.blocks} results={results} />
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
