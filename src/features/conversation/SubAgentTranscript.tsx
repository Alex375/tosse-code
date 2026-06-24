// Read-only renderer for a `ConversationItem[]` transcript — the reusable brick
// for showing a sub-agent's full conversation (read from disk via
// `load_subagent_transcript`), and the same renderer the future Workflow view and
// Fleet drill-down will reuse. Unlike the live thread it does NOT read the store:
// it is a pure function of the items handed in, so it can render an off-thread
// transcript (a finished sub-agent, a past run) with zero session state.
//
// Tool results arrive as their OWN `tool_result` items; we join them to their
// `tool_use` block by id locally (the live path does this in the store).

import { useMemo, useState } from "react";
import type { ConversationItem, JsonValue, NormalizedBlock } from "../../ipc/client";
import { field } from "../../agent/ask";
import { Avatar, ClaudeMark, Ico, UserMark } from "../../ui/kit";
import { DiffView } from "./DiffView";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolResultBody } from "./ToolResultBody";
import { toolMeta } from "./toolMeta";

interface JoinedResult {
  content: JsonValue;
  isError: boolean;
}

/** Pull the `edits[]` hunks out of a MultiEdit input (mirrors ConductorThread). */
function multiEdits(input: JsonValue): { old: string; next: string }[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const edits = (input as Record<string, JsonValue>).edits;
  if (!Array.isArray(edits)) return [];
  return edits.map((e) => ({
    old: field(e, "old_string") ?? "",
    next: field(e, "new_string") ?? "",
  }));
}

/** A static tool card: same visual language as the live `ConductorToolCard`, but
 *  fed an already-resolved result (the transcript is finished — no running state). */
function StaticToolCard({
  name,
  input,
  result,
}: {
  name: string;
  input: JsonValue;
  result: JoinedResult | undefined;
}) {
  const meta = toolMeta(name, input);
  // ALL tool cards start COLLAPSED in a transcript view (unlike the live thread which
  // opens edits/writes): a finished transcript is for reading, not editing, so default
  // to a quiet list of headers the reader can expand on demand.
  const [open, setOpen] = useState(false);
  if (meta.suppressed) return null;

  const isEdit = meta.kind === "edit";
  const isMultiEdit = name === "MultiEdit";
  const isWrite = meta.kind === "write";
  const isBash = meta.kind === "bash";

  const hasBody = isEdit || isWrite || isBash || !!result;
  const tone = isEdit || isWrite ? "diff" : isBash ? "term" : "";

  return (
    <div className={"cv-tool " + tone}>
      <div
        className="cv-tool-h"
        onClick={hasBody ? () => setOpen((o) => !o) : undefined}
        role={hasBody ? "button" : undefined}
        style={hasBody ? { cursor: "pointer" } : undefined}
      >
        <Ico name="cog" className="sm" />
        <span className="cv-tool-t">{name}</span>
        {meta.primaryArg ? (
          <span className="cv-tool-m wf-mono" title={meta.primaryArg}>
            {meta.primaryArg}
          </span>
        ) : null}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
          {result?.isError ? (
            <Ico name="alert" className="sm" />
          ) : (
            <Ico name="check" className="sm" />
          )}
          {hasBody ? (
            <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}>
              <Ico name="chev" className="sm" />
            </span>
          ) : null}
        </span>
      </div>
      {hasBody && open ? (
        <div className="cv-tool-b">
          {isBash && meta.primaryArg ? (
            <pre className="cv-tool-cmd wf-mono">{meta.primaryArg}</pre>
          ) : null}
          {isEdit ? (
            isMultiEdit ? (
              multiEdits(input).map((e, k) => (
                <DiffView key={k} path={field(input, "file_path")} oldText={e.old} newText={e.next} />
              ))
            ) : (
              <DiffView
                path={field(input, "file_path")}
                oldText={field(input, "old_string") ?? ""}
                newText={field(input, "new_string") ?? ""}
              />
            )
          ) : isWrite ? (
            <DiffView path={field(input, "file_path")} newText={field(input, "content") ?? ""} />
          ) : result ? (
            <ToolResultBody content={result.content} isError={result.isError} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TranscriptBlocks({
  blocks,
  results,
}: {
  blocks: NormalizedBlock[];
  results: Map<string, JoinedResult>;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return <StreamMarkdown key={i} text={b.text} />;
        if (b.type === "thinking") return <ThinkingBlock key={i} text={b.text} finalized />;
        if (b.type === "tool_use")
          return <StaticToolCard key={i} name={b.name} input={b.input} result={results.get(b.id)} />;
        return null;
      })}
    </>
  );
}

/**
 * Render a finished transcript (e.g. a sub-agent's). Pure: depends only on `items`.
 * Renders user turns and assistant turns (text / thinking / tool_use with its
 * joined result). The streaming-only kinds (`message_started`, `*_delta`) and
 * `turn_result` / `notice` are not part of a settled transcript view.
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
