// Shared rendering for the grouped-steps transcript: a collapsible "Exécuté N
// étapes" section (<ToolSection>) holding compact, individually-expandable step
// rows (<ToolStepRow>), plus the per-tool detail body (<ToolDetail>). Used VERBATIM
// by the live thread (ConductorThread) and the off-thread transcript
// (SubAgentTranscript) so the two never diverge — the live side feeds <LiveToolStep>
// (subscribes to the store for its result), the disk side feeds <StaticToolStep>
// (result handed in). Collapsed by default; an error is flagged ONLY by a small alert glyph
// on the row / section — no auto-expand, no red text (the user opens it on purpose).

import { useEffect, useState, type ReactNode } from "react";
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { useSessionState, useToolResult } from "../../store/conversationStore";
import { Ico } from "../../ui/kit";
import { DiffView } from "./DiffView";
import { MentionPathChip } from "./FileMention";
import { QuestionnaireSummary } from "./QuestionnaireAsk";
import { ToolResultBody } from "./ToolResultBody";
import { toolMeta } from "./toolMeta";
import {
  basename,
  multiEdits,
  stepFilePath,
  stepIcon,
  stepLabel,
  stepSummary,
  type StepSummary,
  type ToolStep,
} from "./toolGroup";

export interface StepResult {
  content: JsonValue;
  isError: boolean;
}

/** Flatten a tool_result content to text, for the line-count summaries. */
export function resultContentText(content: JsonValue): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && !Array.isArray(b) && typeof (b as Record<string, JsonValue>).text === "string")
        parts.push((b as Record<string, JsonValue>).text as string);
    }
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

/** Does this tool have an expandable detail body (diff / output / questionnaire)? */
function hasDetailFor(name: string, input: JsonValue, result: StepResult | undefined): boolean {
  const kind = toolMeta(name, input).kind;
  return kind === "edit" || kind === "write" || kind === "bash" || name === "AskUserQuestion" || !!result;
}

/** The expanded detail of a step: a diff (Edit/Write), the command + output (Bash),
 *  the questionnaire recap (AskUserQuestion), or the raw result body. */
export function ToolDetail({
  name,
  input,
  result,
}: {
  name: string;
  input: JsonValue;
  result: StepResult | undefined;
}) {
  const meta = toolMeta(name, input);

  if (name === "AskUserQuestion") return <QuestionnaireSummary input={input} result={result?.content} />;

  if (meta.kind === "edit") {
    if (name === "MultiEdit")
      return (
        <>
          {multiEdits(input).map((e, k) => (
            <DiffView key={k} path={field(input, "file_path")} oldText={e.old} newText={e.next} />
          ))}
        </>
      );
    return (
      <DiffView
        path={field(input, "file_path")}
        oldText={field(input, "old_string") ?? ""}
        newText={field(input, "new_string") ?? ""}
      />
    );
  }

  if (meta.kind === "write")
    return <DiffView path={field(input, "file_path")} newText={field(input, "content") ?? ""} />;

  if (meta.kind === "bash")
    return (
      <>
        {meta.primaryArg ? <pre className="cv-tool-cmd wf-mono">{meta.primaryArg}</pre> : null}
        {result ? <ToolResultBody content={result.content} isError={result.isError} /> : null}
      </>
    );

  return result ? <ToolResultBody content={result.content} isError={result.isError} /> : null;
}

function SummaryBadge({ summary }: { summary: StepSummary }) {
  if (!summary) return null;
  if (summary.kind === "diff")
    return (
      <span className="cv-step-sum wf-mono">
        <span className="cv-step-add">+{summary.added}</span>{" "}
        <span className="cv-step-del">−{summary.removed}</span>
      </span>
    );
  return <span className="cv-step-sum">{summary.text}</span>;
}

/** One compact, expandable row inside a section. Presentational: the live and disk
 *  wrappers resolve the result and hand the body in as `children`. */
export function ToolStepRow({
  icon,
  label,
  filePath,
  summary,
  isError,
  running,
  hasDetail,
  children,
}: {
  icon: string;
  label: string;
  /** When the step's primary argument is a file, the label opens it in the editor. */
  filePath: string | null;
  summary: StepSummary;
  isError: boolean;
  running: boolean;
  hasDetail: boolean;
  children: ReactNode;
}) {
  // An error is NOT auto-expanded and NOT reddened — it's flagged only by the small alert
  // glyph (cv-step-errico) on the right. The user opens the row on purpose to inspect it.
  const [open, setOpen] = useState(false);
  const toggle = hasDetail ? () => setOpen((o) => !o) : undefined;

  return (
    <div className="cv-step">
      <div
        className="cv-step-h"
        onClick={toggle}
        role={toggle ? "button" : undefined}
        aria-expanded={hasDetail ? open : undefined}
        style={toggle ? { cursor: "pointer" } : undefined}
      >
        <Ico name={icon} className="sm cv-step-ico" />
        {(() => {
          // The whole row toggles the detail; only the file NAME is a clickable mention
          // that opens the file. Split "Edit foo.ts" → "Edit " (toggles) + chip("foo.ts")
          // (the chip stops propagation, so it opens instead of toggling).
          const base = filePath ? basename(filePath) : null;
          if (filePath && base && label.endsWith(base)) {
            return (
              <span className="cv-step-t" title={label}>
                {label.slice(0, label.length - base.length)}
                <MentionPathChip path={filePath} display={base} />
              </span>
            );
          }
          return (
            <span className="cv-step-t" title={label}>
              {label}
            </span>
          );
        })()}
        <SummaryBadge summary={summary} />
        <span className="cv-step-end">
          {running ? (
            <span className="cv-step-run" aria-label="en cours" />
          ) : isError ? (
            <Ico name="alert" className="sm cv-step-errico" />
          ) : (
            <Ico name="check" className="sm cv-step-okico" />
          )}
          {hasDetail ? (
            <span className="cv-step-chev" data-open={open ? "1" : undefined}>
              <Ico name="chev" className="sm" />
            </span>
          ) : null}
        </span>
      </div>
      {open && hasDetail ? <div className="cv-step-b">{children}</div> : null}
    </div>
  );
}

/**
 * A step in the LIVE thread: subscribes to its own result + the session's busy flag.
 * `active` marks a step that belongs to the actively streaming turn; only then may a
 * resultless step show the running spinner. Without it, a resultless step in a PAST
 * turn (e.g. a tool_use left without a tool_result by an interrupt) would falsely spin
 * whenever the session goes busy on a later turn — the session busy flag is global.
 */
export function LiveToolStep({
  session,
  step,
  active = false,
}: {
  session: string;
  step: ToolStep;
  active?: boolean;
}) {
  const result = useToolResult(session, step.id);
  const state = useSessionState(session);
  const joined: StepResult | undefined = result
    ? { content: result.content, isError: result.isError }
    : undefined;
  const running = active && !result && (state?.busy ?? false);
  const isError = result?.isError ?? false;
  const summary = stepSummary(step.name, step.input, joined ? resultContentText(joined.content) : null);
  return (
    <ToolStepRow
      icon={stepIcon(step.name)}
      label={stepLabel(step.name, step.input)}
      filePath={stepFilePath(step.input)}
      summary={summary}
      isError={isError}
      running={running}
      hasDetail={hasDetailFor(step.name, step.input, joined)}
    >
      <ToolDetail name={step.name} input={step.input} result={joined} />
    </ToolStepRow>
  );
}

/** A step in a settled transcript (disk): result handed in, never running. */
export function StaticToolStep({ step, result }: { step: ToolStep; result: StepResult | undefined }) {
  const isError = result?.isError ?? false;
  const summary = stepSummary(step.name, step.input, result ? resultContentText(result.content) : null);
  return (
    <ToolStepRow
      icon={stepIcon(step.name)}
      label={stepLabel(step.name, step.input)}
      filePath={stepFilePath(step.input)}
      summary={summary}
      isError={isError}
      running={false}
      hasDetail={hasDetailFor(step.name, step.input, result)}
    >
      <ToolDetail name={step.name} input={step.input} result={result} />
    </ToolStepRow>
  );
}

/** The collapsible run container. Collapsed by default; auto-opens only while the run is
 *  actively running (`live`) — so its steps appear live with their spinner — then collapses
 *  to the header once the run settles. A contained error does NOT auto-open it: it's flagged
 *  by the small alert glyph on the header (no red title). */
export function ToolSection({
  title,
  errored,
  live,
  children,
}: {
  title: string;
  errored: boolean;
  /** True while this is the actively-running trailing run of the live turn: the section
   *  stays expanded so steps appear live (spinner → result), then collapses on settle. */
  live?: boolean;
  children: ReactNode;
}) {
  // Expanded only while actively running (`live`); collapses once the run settles. An error
  // does NOT auto-expand the section nor redden its title — it's flagged only by the small
  // alert glyph (rendered below off `errored`) on the right.
  const [open, setOpen] = useState(Boolean(live));
  useEffect(() => {
    setOpen(Boolean(live));
  }, [live]);

  return (
    <div className="cv-steps">
      <button
        type="button"
        className="cv-steps-h"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Ico name="layers" className="sm cv-steps-ico" />
        <span className="cv-steps-t">{title}</span>
        {errored ? <Ico name="alert" className="sm cv-steps-errico" /> : null}
        <span className="cv-steps-chev" data-open={open ? "1" : undefined}>
          <Ico name="chev" className="sm" />
        </span>
      </button>
      {open ? <div className="cv-steps-b">{children}</div> : null}
    </div>
  );
}
