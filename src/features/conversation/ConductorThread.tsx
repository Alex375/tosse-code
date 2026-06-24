import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type { JsonValue, NormalizedBlock, PermissionRequestPayload } from "../../ipc/client";
import { useAnswerPermission } from "../../ipc/useCommands";
import { classifyAsk, field } from "../../agent/ask";
import { useLiveActivity } from "../../store/activity";
import {
  useConversationStore,
  useError,
  useNotice,
  usePendingPermissions,
  useSessionState,
  useTimeline,
  useToolResult,
  useTurn,
  useTurnResult,
} from "../../store/conversationStore";
import { Avatar, ClaudeMark, Ico, UserMark } from "../../ui/kit";
import { DiffView } from "./DiffView";
import { QuestionnaireAsk, QuestionnaireSummary, questionCount } from "./QuestionnaireAsk";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolResultBody } from "./ToolResultBody";
import { toolMeta } from "./toolMeta";
import type { StickToBottom } from "./useStickToBottom";
import styles from "./ConductorThread.module.css";

const TOOL_ICON: Record<string, string> = {
  Read: "file",
  Edit: "diff",
  MultiEdit: "diff",
  Write: "file",
  Bash: "term",
  Grep: "search",
  Glob: "search",
  WebFetch: "layers",
  // The sub-agent tool is `Agent` on the wire (was `Task`); keep `Task` as an alias
  // so old transcripts still render the right icon.
  Agent: "spark",
  Task: "spark",
  TodoWrite: "list",
};

function MsgUser({ text, queued }: { text: string; queued?: boolean }) {
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

/** MultiEdit carries an `edits: [{old_string, new_string}, …]` array instead of the
 *  top-level old/new pair an Edit has. Pull each hunk out so every one renders a diff
 *  (reading the top-level fields would yield an empty `+0/−0` diff). */
function multiEdits(input: JsonValue): { old: string; next: string }[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const edits = (input as Record<string, JsonValue>).edits;
  if (!Array.isArray(edits)) return [];
  return edits.map((e) => ({
    old: field(e, "old_string") ?? "",
    next: field(e, "new_string") ?? "",
  }));
}

function ConductorToolCard({
  session,
  toolUseId,
  name,
  input,
}: {
  session: string;
  toolUseId: string;
  name: string;
  input: JsonValue;
}) {
  const meta = toolMeta(name, input);
  const result = useToolResult(session, toolUseId);
  const state = useSessionState(session);
  if (meta.suppressed) return null;

  const isEdit = meta.kind === "edit";
  // MultiEdit shares the "edit" kind but carries an `edits[]` array instead of a
  // top-level old/new pair — render one diff per hunk (see `multiEdits`).
  const isMultiEdit = name === "MultiEdit";
  const isWrite = meta.kind === "write";
  const isBash = meta.kind === "bash";
  // AskUserQuestion renders a clean Q→A recap instead of raw result text.
  const isQuestionnaire = name === "AskUserQuestion";
  const running = !result && (state?.busy ?? false);

  // Edit/Write show their diff immediately; all other results are collapsed by default.
  const [open, setOpen] = useState(isEdit || isWrite);
  // A failed tool must not hide its error behind a collapsed card: auto-expand once
  // an error result lands (it arrives after mount, so an effect, not initial state).
  useEffect(() => {
    if (result?.isError) setOpen(true);
  }, [result?.isError]);

  // Bash cards are expandable even before a result: the header command is
  // ellipsised, so expanding is how the user reads the full command.
  const hasBody = isEdit || isWrite || isQuestionnaire || !!result || (isBash && !!meta.primaryArg);
  const canToggle = hasBody && !isEdit && !isWrite;

  const icon = isQuestionnaire ? "form" : TOOL_ICON[name] || "cog";
  const label = isQuestionnaire ? "Questionnaire" : name;
  const primaryArg = isQuestionnaire
    ? `${questionCount(input)} question${questionCount(input) > 1 ? "s" : ""}`
    : meta.primaryArg;
  const tone = isEdit || isWrite ? "diff" : meta.kind === "bash" ? "term" : "";

  return (
    <div className={"cv-tool " + tone}>
      <div
        className="cv-tool-h"
        onClick={canToggle ? () => setOpen((o) => !o) : undefined}
        role={canToggle ? "button" : undefined}
        style={canToggle ? { cursor: "pointer" } : undefined}
      >
        <Ico name={icon} className="sm" />
        <span className="cv-tool-t">{label}</span>
        {primaryArg ? (
          <span className="cv-tool-m wf-mono" title={primaryArg}>
            {primaryArg}
          </span>
        ) : null}
        <span className={styles.status}>
          {running ? (
            <span className={styles.runDot} />
          ) : result?.isError ? (
            <Ico name="alert" className={"sm " + styles.errIco} />
          ) : (
            <Ico name="check" className={"sm " + styles.okIco} />
          )}
          {canToggle && (
            <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s ease", marginLeft: 2 }}>
              <Ico name="chev" className="sm" />
            </span>
          )}
        </span>
      </div>

      {open && hasBody && (
        <div className="cv-tool-b">
          {/* Bash: the full command (wraps, fully readable) above its output. */}
          {isBash && meta.primaryArg ? (
            <pre className="cv-tool-cmd wf-mono">{meta.primaryArg}</pre>
          ) : null}
          {isEdit ? (
            isMultiEdit ? (
              multiEdits(input).map((e, k) => (
                <DiffView
                  key={k}
                  path={field(input, "file_path")}
                  oldText={e.old}
                  newText={e.next}
                />
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
          ) : isQuestionnaire ? (
            <QuestionnaireSummary input={input} result={result?.content} />
          ) : result ? (
            <ToolResultBody content={result.content} isError={result.isError} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function AssistantBlocks({ session, blocks }: { session: string; blocks: NormalizedBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return <StreamMarkdown key={i} text={b.text} />;
        if (b.type === "thinking") return <ThinkingBlock key={i} text={b.text} finalized />;
        if (b.type === "tool_use")
          return (
            <ConductorToolCard key={i} session={session} toolUseId={b.id} name={b.name} input={b.input} />
          );
        return null;
      })}
    </>
  );
}

function MsgAI({ session, turnId }: { session: string; turnId: string }) {
  const turn = useTurn(session, turnId);
  if (!turn) return null;
  return (
    <div className="cv-msg cv-ai">
      <Avatar ai><ClaudeMark /></Avatar>
      <div className="cv-aibody">
        {/* Finalized blocks accumulated so far, then the block currently being
            typed as a live tail. Both render together so an already-shown block is
            never swapped out — the text between two tools stays put. */}
        {turn.blocks.length > 0 && <AssistantBlocks session={session} blocks={turn.blocks} />}
        {turn.streamingThinking && <ThinkingBlock text={turn.streamingThinking} finalized={false} />}
        {turn.streamingText && <StreamMarkdown text={turn.streamingText} streaming />}
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
  const timeline = useTimeline(session);
  const pending = usePendingPermissions(session);
  const state = useSessionState(session);
  const busy = state?.busy ?? false;
  const awaiting = state?.awaiting_permission ?? false;
  const empty = timeline.length === 0 && pending.length === 0;

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
            {timeline.map((entry) => {
              if (entry.kind === "turn")
                return <TurnRow key={entry.id} session={session} turnId={entry.id} />;
              if (entry.kind === "error")
                return <MsgError key={entry.id} session={session} errorId={entry.id} />;
              if (entry.kind === "notice")
                return <NoticeRow key={entry.id} session={session} noticeId={entry.id} />;
              if (entry.kind === "turn_result")
                return <TurnResultRow key={entry.id} session={session} resultId={entry.id} />;
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
  return (
    <div className={styles.activity}>
      <span className={styles.typing} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{activity}</span>
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

function TurnRow({ session, turnId }: { session: string; turnId: string }) {
  const turn = useTurn(session, turnId);
  if (!turn) return null;
  if (turn.role === "user") return <MsgUser text={turn.streamingText} queued={turn.queued} />;
  return <MsgAI session={session} turnId={turnId} />;
}
