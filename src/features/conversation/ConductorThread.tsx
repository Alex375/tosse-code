import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type {
  BackgroundTaskStatus,
  ConversationItem,
  JsonValue,
  NormalizedBlock,
  PermissionRequestPayload,
} from "../../ipc/client";
import { commands } from "../../ipc/client";
import { useAnswerPermission } from "../../ipc/useCommands";
import { classifyAsk, field } from "../../agent/ask";
import { useLiveActivity, useLiveBashCommand } from "../../store/activity";
import {
  useConversationStore,
  useError,
  useGroupBlocks,
  useNotice,
  usePendingPermissions,
  useSessionState,
  useSubThread,
  useRunErrored,
  useTimelineRender,
  useToolResult,
  useTurn,
  useTurnResult,
} from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useTaskByToolUse } from "../../store/backgroundTasksStore";
import { fmtDuration, isBackgroundAgentInput, shortModel } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import { Avatar, ClaudeMark, Dot, Ico, UserMark, type StreamState } from "../../ui/kit";
import { QuestionnaireAsk } from "./QuestionnaireAsk";
import { StreamMarkdown } from "./StreamMarkdown";
import { SubAgentTranscript } from "./SubAgentTranscript";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  atomsToSegments,
  countWorkSteps,
  flattenWork,
  groupBlocks,
  liveVisibleStart,
  runHeader,
  splitFinalMessage,
  workStepIds,
  type Segment,
  type ToolStep,
} from "./toolGroup";
import { useDisplay } from "../../store/display";
import { LiveToolStep, ToolSection } from "./ToolSection";
import { useShallow } from "zustand/react/shallow";
import { LiveSubThread } from "./LiveSubThread";
import { resolveTranscriptSource } from "./transcriptSource";
import type { StickToBottom } from "./useStickToBottom";
import styles from "./ConductorThread.module.css";


export function MsgUser({ text, queued }: { text: string; queued?: boolean }) {
  return (
    <div className={"cv-msg cv-user" + (queued ? " is-queued" : "")}>
      <Avatar user><UserMark /></Avatar>
      <div className="cv-bubble">
        {queued ? (
          <span className="cv-queued-tag" title="Envoyé pendant que l'agent travaille — sera traité en cours de route">
            <Ico name="clock" />
            en attente
          </span>
        ) : null}
        {text}
      </div>
    </div>
  );
}

/** The single, consistent way an error shows in the thread: a red `role=alert`
 *  bubble with an optional bold heading, a main message, and a collapsed
 *  "Détails techniques" disclosure for the raw payload (stderr / exit code / raw
 *  line) so the detail is one click away without polluting the stream. Used by
 *  client errors (MsgError), core error notices (NoticeRow) and failed turns
 *  (TurnResultRow) so they never diverge. */
function ErrorBlock({
  heading,
  children,
  detail,
}: {
  heading?: ReactNode;
  children?: ReactNode;
  /** Raw technical detail, hidden behind a disclosure (collapsed by default). */
  detail?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.errorBubble} role="alert">
      <Ico name="alert" className={"sm " + styles.errorBubbleIco} />
      <div className={styles.errorBody}>
        {heading ? <div className={styles.errorHeading}>{heading}</div> : null}
        {children ? <div className={styles.errorText}>{children}</div> : null}
        {detail ? (
          <>
            <button
              type="button"
              className={styles.errorToggle}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Masquer le détail" : "Détails techniques"}
            </button>
            {open ? <pre className={styles.errorDetail}>{detail}</pre> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function MsgError({ session, errorId }: { session: string; errorId: string }) {
  const err = useError(session, errorId);
  if (!err) return null;
  return <ErrorBlock detail={err.detail}>{err.message}</ErrorBlock>;
}

/** French heading for each error-bearing notice subtype the core can emit. Any
 *  subtype listed here (plus the generic `error`) renders as a visible error
 *  bubble; subtypes absent from this map stay quiet (e.g. `control_change`). This
 *  is the front half of the "zero silent error" contract: a layer surfaces an
 *  error by emitting `Notice{subtype, detail:{message, detail?}}` and it shows up
 *  here with no extra plumbing. */
const NOTICE_ERROR_HEADINGS: Record<string, string> = {
  process_exited: "La session Claude Code s'est arrêtée de façon inattendue",
  session_crashed: "La session Claude Code a planté",
  send_failed: "Message non transmis à Claude Code",
  protocol_error: "Erreur de protocole",
  permission_error: "Demande d'autorisation illisible",
  task_failed: "Une tâche de fond a échoué",
  history_error: "Problème de restauration de l'historique",
};

/** Pull a human-readable detail string out of a notice's raw `detail` payload, for
 *  the collapsed "Détails techniques" disclosure. Prefers explicit `detail`, then
 *  any technical fields (stderr / exit code), else the whole payload as JSON. */
function noticeDetailText(d: Record<string, JsonValue> | null): string | null {
  if (!d) return null;
  if (typeof d.detail === "string" && d.detail.trim()) return d.detail;
  const lines: string[] = [];
  if (typeof d.stderr === "string" && d.stderr.trim()) lines.push(d.stderr.trimEnd());
  if (d.exit_code != null) lines.push(`exit code: ${String(d.exit_code)}`);
  if (typeof d.signal === "string" && d.signal) lines.push(`signal: ${d.signal}`);
  if (lines.length) return lines.join("\n");
  return null;
}

/** Control-channel + error notices surfaced from the core:
 *  - `control_change`: a model/effort/permission change CONFIRMED by the CLI — a
 *    subtle inline line (like the VS Code extension). Emitted only on the model-felt
 *    transition (get_settings read-back / set_permission_mode ack / system/init),
 *    never on the optimistic click, so it is reliable.
 *  - `control_error` + every subtype in NOTICE_ERROR_HEADINGS (and the generic
 *    `error`): a real error — a visible red bubble, never silent.
 *  Other notice subtypes stay quiet. */
function NoticeRow({ session, noticeId }: { session: string; noticeId: string }) {
  const notice = useNotice(session, noticeId);
  if (!notice) return null;
  const d = (notice.detail ?? null) as Record<string, JsonValue> | null;
  const get = (k: string): string | undefined => {
    const v = d?.[k];
    return typeof v === "string" ? v : undefined;
  };

  if (notice.subtype === "control_change") {
    return (
      <div className={styles.controlChange}>
        <Ico name={get("icon") ?? "spark"} className="sm" />
        <span>
          {get("control")} : <b>{get("from")}</b> → <b>{get("to")}</b>
        </span>
      </div>
    );
  }

  if (notice.subtype === "control_error") {
    return (
      <ErrorBlock detail={noticeDetailText(d)}>
        Réglage « {get("control") ?? "contrôle"} » refusé par Claude Code
        {get("message") ? ` : ${get("message")}` : ""}.
      </ErrorBlock>
    );
  }

  const heading = NOTICE_ERROR_HEADINGS[notice.subtype] ?? (notice.subtype === "error" ? "Erreur" : null);
  if (heading) {
    return (
      <ErrorBlock heading={heading} detail={noticeDetailText(d)}>
        {get("message") ?? null}
      </ErrorBlock>
    );
  }
  return null;
}

/** A turn that ended in error: the CLI sends a `result` with `is_error` (or an
 *  `error_*` subtype) carrying the human error text — previously stored but never
 *  rendered (it fell through the timeline switch). Now a persistent error bubble
 *  with a typed heading. Successful / interrupted turns render nothing here. */
function turnErrorHeading(meta: { subtype: string; apiErrorStatus?: string | null }): string {
  if (meta.apiErrorStatus) return `Erreur d'API : ${meta.apiErrorStatus}`;
  switch (meta.subtype) {
    case "error_max_turns":
      return "Nombre maximum de tours atteint";
    case "error_during_execution":
      return "Erreur pendant l'exécution";
    default:
      return "La tâche s'est terminée en erreur";
  }
}

function resultToText(result: JsonValue | null): string | null {
  if (result == null) return null;
  if (typeof result === "string") return result.trim() || null;
  return JSON.stringify(result, null, 2);
}

function TurnResultRow({ session, resultId }: { session: string; resultId: string }) {
  const meta = useTurnResult(session, resultId);
  if (!meta) return null;
  const isError = meta.isError || meta.subtype.startsWith("error");
  if (!isError) return null; // success / interrupted: nothing to surface here
  const text = resultToText(meta.result);
  return <ErrorBlock heading={turnErrorHeading(meta)}>{text}</ErrorBlock>;
}


/** Map a sub-agent's coarse lifecycle onto the design's status-dot colour token. */
function taskDotState(o: { running: boolean; failed: boolean; stopped: boolean }): StreamState {
  if (o.failed) return "err";
  if (o.running) return "work";
  if (o.stopped) return "off";
  return "done";
}


/**
 * A sub-agent launched by the `Agent` tool (ex-`Task`): a collapsible header with
 * the live lifecycle (label, type, running→done dot, tokens / tool-calls / duration
 * once finished) and, when expanded, the sub-agent's transcript INLINE. While it
 * runs we show the live sub-thread (streamed, keyed by this tool_use id); once
 * finished — or on a resumed conversation where the sub-thread wasn't replayed —
 * the full transcript is read from disk via `load_subagent_transcript`.
 *
 * Drill-down needs the claude session_id (durable) + the sub-agent's agent_id; the
 * latter is reported only by the LIVE task lifecycle, so a resumed conversation
 * degrades to the live sub-thread / a clear "unavailable" note instead.
 *
 * Renders nothing for a DETACHED sub-agent (`run_in_background`): those are surfaced
 * in the pinned <AgentBar>, not inline, to keep the thread clean.
 */
function SubAgentCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const task = useTaskByToolUse(session, toolUseId);
  const result = useToolResult(session, toolUseId);
  const state = useSessionState(session);
  const liveIds = useSubThread(session, toolUseId);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );

  const status: BackgroundTaskStatus | null = task?.status ?? null;
  const label = field(input, "description") ?? task?.label ?? "Sous-agent";
  const subagentType = field(input, "subagent_type") ?? task?.subagent_type ?? null;
  const agentId = task?.agent_id ?? null;
  const model = task?.model ?? null;
  // Sub-agents inherit the conversation's reasoning effort (not recorded per sub-agent
  // anywhere), so the parent's effort is the best available signal.
  const effort = state?.effort ?? null;

  const running = status === "running" || (status === null && !result && (state?.busy ?? false));
  const failed = status === "failed" || (status === null && (result?.isError ?? false));
  const stopped = status === "stopped";
  const dot = taskDotState({ running, failed, stopped });

  const [open, setOpen] = useState(false);
  const [disk, setDisk] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchTranscript = useCallback(async () => {
    if (!claudeSessionId || !agentId) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await commands.loadSubagentTranscript(claudeSessionId, agentId);
      if (res.status === "ok") setDisk(res.data);
      else setErr(res.error);
    } catch (e) {
      // A thrown IPC/transport error must NEVER be swallowed: surface it and clear the
      // loading state (the `finally` guarantees we don't get stuck "Chargement…").
      console.error("loadSubagentTranscript threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [claudeSessionId, agentId]);

  // Fetch on open, and again once the task settles (running → terminal) so a
  // mid-run partial read is replaced by the complete transcript. Both effects depend
  // on `fetchTranscript` so a change of session/agent id re-binds to a fresh fetch
  // (no stale closure loading the wrong transcript).
  useEffect(() => {
    if (open) void fetchTranscript();
  }, [open, fetchTranscript]);
  useEffect(() => {
    if (open && status && status !== "running") void fetchTranscript();
  }, [open, status, fetchTranscript]);

  // A detached (run_in_background) sub-agent lives in the pinned AgentBar, not inline —
  // keep the thread clean. All hooks above have run, so this conditional render is safe.
  if (isBackgroundAgentInput(input)) return null;

  // The prompt sent to the sub-agent (the Agent tool's `prompt` input) — prepended to
  // the live view since the live sub-thread streams only the sub-agent's REPLIES. (The
  // disk transcript already carries it as its first user_message.)
  const promptText = field(input, "prompt");

  // Live → disk → fallback, resolved in one shared place (mirrored by <TranscriptPopover>).
  let body: ReactNode = null;
  if (open) {
    switch (
      resolveTranscriptSource({
        running,
        liveCount: liveIds.length,
        diskCount: disk?.length ?? 0,
        loading,
        error: err != null,
        resolvable: !!(claudeSessionId && agentId),
      })
    ) {
      case "live":
        body = <LiveSubThread session={session} ids={liveIds} promptText={promptText} />;
        break;
      case "disk":
        body = <SubAgentTranscript items={disk!} />;
        break;
      case "loading":
        body = <div className={styles.subEmpty}>Chargement du transcript…</div>;
        break;
      case "error":
        body = <div className={styles.subEmpty}>Transcript illisible : {err}</div>;
        break;
      case "working":
        body = <div className={styles.subEmpty}>Le sous-agent travaille…</div>;
        break;
      case "unavailable":
        body = (
          <div className={styles.subEmpty}>Transcript indisponible (conversation rouverte).</div>
        );
        break;
      case "empty":
        body = <div className={styles.subEmpty}>Aucun transcript pour ce sous-agent.</div>;
        break;
    }
  }

  return (
    <div className="cv-tool">
      <div
        className="cv-tool-h"
        onClick={() => setOpen((o) => !o)}
        role="button"
        style={{ cursor: "pointer" }}
      >
        <Ico name="spark" className="sm" />
        <span className="cv-tool-t">Sous-agent</span>
        <span className="cv-tool-m" title={label}>
          {label}
        </span>
        {subagentType ? <span className={styles.subType}>{subagentType}</span> : null}
        <span className={styles.status}>
          <Dot s={dot} pulse={running} />
          <span
            style={{
              display: "inline-flex",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
              marginLeft: 4,
            }}
          >
            <Ico name="chev" className="sm" />
          </span>
        </span>
      </div>
      {model || effort || (task && (task.tokens != null || task.duration_ms != null || task.tool_uses != null)) ? (
        <div className={styles.subStats + " wf-mono"}>
          {model ? <span title={model}>{shortModel(model)}</span> : null}
          {effort ? <span>effort {effort}</span> : null}
          {task?.tokens != null ? <span>{fmtTokens(task.tokens)} tk</span> : null}
          {task?.tool_uses != null ? <span>{task.tool_uses} outils</span> : null}
          {task?.duration_ms != null ? <span>{fmtDuration(task.duration_ms)}</span> : null}
        </div>
      ) : null}
      {open ? <div className="cv-tool-b">{body}</div> : null}
    </div>
  );
}


/**
 * One collapsed section for a run of consecutive (non-sub-agent) tool steps. Its own
 * component so it can subscribe to the run's aggregate error state and auto-expand on
 * failure. Sub-agents are NOT here — they render inline via <SubAgentCard> (see
 * AssistantBlocks), keeping their live lifecycle and drill-in transcript.
 */
function LiveRunSection({
  session,
  steps,
  active,
  live,
}: {
  session: string;
  steps: ToolStep[];
  active: boolean;
  /** True while this run is the live trailing run → section stays expanded, collapses on settle. */
  live: boolean;
}) {
  const errored = useRunErrored(
    session,
    steps.map((s) => s.id),
  );
  return (
    <ToolSection title={runHeader(steps)} errored={errored} live={live}>
      {steps.map((step) => (
        <LiveToolStep key={step.id} session={session} step={step} active={active} />
      ))}
    </ToolSection>
  );
}

/** Render a list of segments as the grouped transcript nodes. `active` marks segments
 *  belonging to the live turn (gates the running spinner); `liveIdx` is the index of the
 *  one run that should render EXPANDED & live (its steps appear as they stream), or -1.
 *  Shared by the normal flow and the inside of a folded <ClaudeWorkBlock>. */
function renderSegments(
  session: string,
  segs: Segment[],
  active: boolean,
  liveIdx: number,
): ReactNode[] {
  return segs.map((seg, i) => {
    if (seg.kind === "text") return <StreamMarkdown key={seg.key} text={seg.text} />;
    if (seg.kind === "thinking")
      return <ThinkingBlock key={seg.key} text={seg.text} finalized />;
    if (seg.kind === "agent")
      // A sub-agent always renders inline (live lifecycle + drill-in transcript),
      // never grouped nor hidden by the live-trailing suppression.
      return (
        <SubAgentCard
          key={seg.key}
          session={session}
          toolUseId={seg.step.id}
          input={seg.step.input}
        />
      );
    // A `run` of regular tools. The trailing run of the live turn renders EXPANDED so its
    // steps appear live (spinner → result), then collapses to its header on settle. Past
    // / non-trailing runs render collapsed. `active` gates the spinner so a resultless
    // step in a PAST turn never spins when the session is busy later.
    return (
      <LiveRunSection
        key={seg.key}
        session={session}
        steps={seg.steps}
        active={active}
        live={i === liveIdx}
      />
    );
  });
}

/**
 * The "clean output" fold: one collapsible block holding a response's intermediate work (tool
 * runs, thinking, in-between prose, sub-agents), so only the response's concluding message
 * stays in clear. Collapsed by default and expandable any time — including mid-stream.
 *
 * The fold header carries NO error indicator: a failed tool inside is folded like the rest,
 * flagged only by the small alert glyph on its command section / step row (visible once the
 * block is open). A conversation-stopping error is a separate timeline item (Notice /
 * turn_result) rendered outside the block, always visible.
 */
function ClaudeWorkBlock({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const label =
    count > 0 ? `Travail de Claude · ${count} étape${count > 1 ? "s" : ""}` : "Travail de Claude";
  return (
    <div className="cv-work">
      <button
        type="button"
        className="cv-work-h"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Ico name="spark" className="sm cv-work-ico" />
        <span className="cv-work-t">{label}</span>
        <span className="cv-work-chev" data-open={open ? "1" : undefined}>
          <Ico name="chev" className="sm" />
        </span>
      </button>
      {open ? <div className="cv-work-b">{children}</div> : null}
    </div>
  );
}

/** The live sliding window: how many trailing steps stay visible (current activity) before
 *  the rest fold into the block. */
const LIVE_WINDOW = 3;

/**
 * The clean-output body of one assistant response: the fold + the trailing region + the final
 * message, rendered as ONE component so it has stable React identity. That stability is what
 * fixes the fold collapsing on settle — the SAME `<ClaudeWorkBlock>` fiber spans the live and
 * the settled render, so a block the user expanded mid-stream stays open when the response
 * finishes (live → settled is just a prop change here, not a remount).
 *
 * It subscribes to EXACTLY this response's tool results (which ids are still running) via a
 * shallow-compared boolean array, so a settled response never re-renders while a LATER turn
 * streams — only the live one (whose ids gain results) re-renders.
 *
 *  - live: settled work folds; the sliding window AND any still-running command / sub-agent
 *    stay visible (see {@link liveVisibleStart}); the trailing run shows live.
 *  - settled, with a final message: ALL the work folds, the final message shows in clear.
 *  - settled, ending on tools (no final): rendered unfolded — folding everything would leave
 *    nothing in clear.
 */
function CleanBlocks({
  session,
  work,
  final,
  live,
}: {
  session: string;
  work: Segment[];
  final: Segment[];
  live: boolean;
}) {
  const ids = workStepIds(work);
  // Per-id "still running?" of THIS response's tools (no result yet). Shallow-compared so the
  // component re-renders only when one of ITS ids settles — a past response never re-renders
  // while a later turn streams.
  const running = useConversationStore(
    useShallow((s) => {
      const tr = s.sessions[session]?.toolResults;
      return ids.map((id) => !tr?.[id]);
    }),
  );
  const runningById = new Map<string, boolean>();
  ids.forEach((id, i) => runningById.set(id, running[i] ?? false));
  const isRunning = (id: string) => runningById.get(id) ?? false;

  // Settled response ending on tools (no closing prose): render unfolded — folding everything
  // would leave nothing in clear.
  if (final.length === 0 && !live) {
    return <>{renderSegments(session, work, false, -1)}</>;
  }

  const atoms = flattenWork(work);
  const split = live ? liveVisibleStart(atoms, isRunning, LIVE_WINDOW) : atoms.length;
  const folded = atomsToSegments(atoms.slice(0, split), "fold");
  const visible = live ? atomsToSegments(atoms.slice(split), "vis") : [];
  // Expand the trailing run of the visible region so its steps show live (spinner → result).
  let liveIdx = -1;
  visible.forEach((s, i) => {
    if (s.kind === "run") liveIdx = i;
  });

  return (
    <>
      {folded.length > 0 ? (
        <ClaudeWorkBlock count={countWorkSteps(folded)}>
          {renderSegments(session, folded, false, -1)}
        </ClaudeWorkBlock>
      ) : null}
      {visible.length > 0 ? renderSegments(session, visible, true, liveIdx) : null}
      {final.length > 0 ? renderSegments(session, final, false, -1) : null}
    </>
  );
}

/**
 * An assistant turn's blocks as the grouped transcript. Default: prose / thinking inline,
 * every run of consecutive tool calls coalesced into one section (`groupBlocks`); the live
 * turn's trailing run shows EXPANDED & live, collapsing on settle.
 *
 * When the "clean output" pref is ON, the response's intermediate work folds into one
 * <ClaudeWorkBlock>, leaving only the concluding message in clear — see {@link CleanBlocks}
 * for the live / settled / ends-on-tools cases and the stable-fold behaviour.
 */
function AssistantBlocks({
  session,
  blocks,
  live,
}: {
  session: string;
  blocks: NormalizedBlock[];
  live: boolean;
}) {
  const cleanOutput = useDisplay((s) => s.cleanOutput);
  const segments = groupBlocks(blocks);

  if (!cleanOutput) {
    const lastIdx = segments.length - 1;
    return <>{renderSegments(session, segments, live, live ? lastIdx : -1)}</>;
  }

  // Clean output: fold this response's intermediate work, keep the concluding message in
  // clear. Rendered through ONE component (CleanBlocks) so the fold keeps its open state
  // across the live → settled transition; it handles the live / settled / ends-on-tools
  // cases internally.
  const { work, final } = splitFinalMessage(segments);
  return <CleanBlocks session={session} work={work} final={final} live={live} />;
}

function MsgAI({
  session,
  turnId,
  busy,
  awaiting,
}: {
  session: string;
  turnId: string;
  busy: boolean;
  awaiting: boolean;
}) {
  const turn = useTurn(session, turnId);
  if (!turn) return null;
  // The trailing run is shown live (bottom indicator) only for the turn that is ACTIVELY
  // streaming — keyed on the turn's own status, not the last timeline entry, so a queued
  // user message landing after it doesn't un-suppress this run; and not while paused on a
  // permission prompt (`awaiting`), so the pending tool still shows as a section.
  const live = busy && !awaiting && turn.status === "streaming";
  return (
    <div className="cv-msg cv-ai">
      <Avatar ai><ClaudeMark /></Avatar>
      <div className="cv-aibody">
        {/* Finalized blocks accumulated so far, then the block currently being
            typed as a live tail. Both render together so an already-shown block is
            never swapped out — the text between two tools stays put. */}
        {turn.blocks.length > 0 && (
          <AssistantBlocks session={session} blocks={turn.blocks} live={live} />
        )}
        {turn.streamingThinking && <ThinkingBlock text={turn.streamingThinking} finalized={false} />}
        {turn.streamingText && <StreamMarkdown text={turn.streamingText} streaming />}
      </div>
    </div>
  );
}

/**
 * An ASSISTANT response = one OR MORE consecutive assistant turns (messages) rendered as
 * ONE flow under a single avatar. Their blocks are concatenated, so a run of tool calls
 * spread across several messages — the agent's loop emits one tool per message — groups
 * into ONE section; only a real text message breaks the run. The LAST turn carries the
 * live streaming tail and drives `live`.
 */
function MsgAIGroup({
  session,
  turnIds,
  busy,
  awaiting,
}: {
  session: string;
  turnIds: string[];
  busy: boolean;
  awaiting: boolean;
}) {
  const blocks = useGroupBlocks(session, turnIds);
  const lastTurn = useTurn(session, turnIds[turnIds.length - 1]);
  // Turns stay "streaming" until turn_result, so the group is live while its last turn
  // streams → the combined trailing run shows live and collapses once the turn settles.
  const live = busy && !awaiting && lastTurn?.status === "streaming";
  return (
    <div className="cv-msg cv-ai">
      <Avatar ai>
        <ClaudeMark />
      </Avatar>
      <div className="cv-aibody">
        {blocks.length > 0 && <AssistantBlocks session={session} blocks={blocks} live={live} />}
        {lastTurn?.streamingThinking && (
          <ThinkingBlock text={lastTurn.streamingThinking} finalized={false} />
        )}
        {lastTurn?.streamingText && <StreamMarkdown text={lastTurn.streamingText} streaming />}
      </div>
    </div>
  );
}

// ---- Ask box (the real request: question / permission / questionnaire) ----

function AskTurn({ session, request }: { session: string; request: PermissionRequestPayload }) {
  const answer = useAnswerPermission(session);
  // AskUserQuestion is an interactive questionnaire, not a yes/no prompt.
  if (request.tool_name === "AskUserQuestion") {
    return <QuestionnaireAsk session={session} request={request} />;
  }
  const ask = classifyAsk(request);
  const allow = () =>
    answer.mutate({ requestId: request.request_id, decision: { behavior: "allow", updated_input: null } });
  const deny = () =>
    answer.mutate({ requestId: request.request_id, decision: { behavior: "deny", message: "Refusé." } });

  return (
    <div className="cv-msg cv-ai">
      <Avatar ai><ClaudeMark /></Avatar>
      <div className="cv-aibody">
        <div className="cv-ask-turn">
          <div className="wf-ask">
            <div className="wf-ask-h">
              <Ico name="key" className="sm" />
              Demande une autorisation
            </div>
            <div className="wf-ask-t">{ask.text}</div>
            {ask.cmd ? <code className="wf-ask-cmd wf-mono">$ {ask.cmd}</code> : null}
          </div>
          <div className="wf-row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <button className="wf-btn ghost sm" onClick={deny}>
              Refuser
            </button>
            <button className="wf-btn prim sm" onClick={allow}>
              <Ico name="check" className="sm" />
              Autoriser
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ConductorThread({
  session,
  scrollRef,
  onRender,
}: {
  session: string;
  // The stick-to-bottom instance is owned by the parent pane so the composer can
  // snap the thread to the bottom on send (see ConductorConversation).
  scrollRef: StickToBottom["scrollRef"];
  onRender: StickToBottom["onRender"];
}) {
  const plan = useTimelineRender(session);
  const pending = usePendingPermissions(session);
  const state = useSessionState(session);
  const busy = state?.busy ?? false;
  const awaiting = state?.awaiting_permission ?? false;
  const empty = plan.length === 0 && pending.length === 0;

  return (
    <div className="cv-thread" ref={scrollRef}>
      <StreamFollow session={session} onRender={onRender} />
      <div className="cv-thread-inner">
        {empty && !busy ? (
          <div className={styles.empty}>Démarre la conversation en envoyant un message.</div>
        ) : (
          <>
            <div className="cv-day">
              <span className="wf-line" />
              aujourd'hui
              <span className="wf-line" />
            </div>
            {plan.map((item) => {
              if (item.kind === "ai")
                return (
                  <MsgAIGroup
                    key={item.ids[0]}
                    session={session}
                    turnIds={item.ids}
                    busy={busy}
                    awaiting={awaiting}
                  />
                );
              if (item.kind === "user")
                return <TurnRow key={item.id} session={session} turnId={item.id} />;
              if (item.kind === "error")
                return <MsgError key={item.id} session={session} errorId={item.id} />;
              if (item.kind === "notice")
                return <NoticeRow key={item.id} session={session} noticeId={item.id} />;
              if (item.kind === "turn_result")
                return <TurnResultRow key={item.id} session={session} resultId={item.id} />;
              return null;
            })}
            {pending.map((req) => (
              <AskTurn key={req.request_id} session={session} request={req} />
            ))}
            {busy && !awaiting && <WorkingIndicator session={session} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The live "what's happening now" line shown under the timeline while the agent
 * works. Its own leaf so the per-token activity recompute (`useLiveActivity`
 * re-derives on every streamed delta) re-renders only this row, not the message
 * list. Shares `describeActivity` with the FlightDeck card, so the thread and the
 * card never describe the agent differently — instead of the raw protocol hint.
 */
function WorkingIndicator({ session }: { session: string }) {
  const activity = useLiveActivity(session);
  // Registre (1): when the live tool is a FOREGROUND shell command, show it
  // terminal-style ("$ command…") rather than the generic "Exécute …" phrase — the
  // bottom-of-terminal feel of the CLI. Any other activity keeps the plain line.
  const bash = useLiveBashCommand(session);
  return (
    <div className={styles.activity}>
      <span className={styles.typing} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {bash ? (
        <code className={"cv-shellrun wf-mono"} title={bash}>
          <span className="cv-shellrun-p" aria-hidden="true">$</span>
          {bash}
        </code>
      ) : (
        <span>{activity}</span>
      )}
    </div>
  );
}

/**
 * Invisible leaf that drives scroll positioning. It subscribes to the whole session
 * entry, so it re-renders on every store update for this session (each streamed token,
 * each state change, the async history replay), and calls `onRender` in a layout
 * effect — before paint — so positioning (initial restore, then stick-to-bottom while
 * streaming) tracks updates with no visible jump. Isolated in its own component so
 * this per-token re-render doesn't re-render the message list.
 */
function StreamFollow({ session, onRender }: { session: string; onRender: () => void }) {
  useConversationStore((s) => s.sessions[session]);
  useLayoutEffect(() => {
    onRender();
  });
  return null;
}

export function TurnRow({
  session,
  turnId,
  busy = false,
  awaiting = false,
}: {
  session: string;
  turnId: string;
  /** Session-level flags; MsgAI derives `live` from them + the turn's own status. */
  busy?: boolean;
  awaiting?: boolean;
}) {
  const turn = useTurn(session, turnId);
  if (!turn) return null;
  if (turn.role === "user") return <MsgUser text={turn.streamingText} queued={turn.queued} />;
  return <MsgAI session={session} turnId={turnId} busy={busy} awaiting={awaiting} />;
}
