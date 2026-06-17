import { useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import type { JsonValue, NormalizedBlock, PermissionRequestPayload } from "../../ipc/client";
import { useAnswerPermission } from "../../ipc/useCommands";
import {
  usePendingPermissions,
  useSessionState,
  useTimeline,
  useToolResult,
  useTurn,
} from "../../store/conversationStore";
import { Avatar, Ico } from "../../ui/kit";
import { DiffView } from "./DiffView";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolResultBody } from "./ToolResultBody";
import { toolMeta } from "./toolMeta";
import styles from "./ConductorThread.module.css";

function field(input: JsonValue, key: string): string | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const v = (input as Record<string, JsonValue>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

const TOOL_ICON: Record<string, string> = {
  Read: "file",
  Edit: "diff",
  MultiEdit: "diff",
  Write: "file",
  Bash: "term",
  Grep: "search",
  Glob: "search",
  WebFetch: "layers",
  Task: "spark",
  TodoWrite: "list",
};

function MsgUser({ text }: { text: string }) {
  return (
    <div className="cv-msg cv-user">
      <Avatar>VS</Avatar>
      <div className="cv-bubble">{text}</div>
    </div>
  );
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
  const isWrite = meta.kind === "write";
  const running = !result && (state?.busy ?? false);

  // Edit/Write show their diff immediately; all other results are collapsed by default.
  const [open, setOpen] = useState(isEdit || isWrite);

  const hasBody = isEdit || isWrite || !!result;
  const canToggle = hasBody && !isEdit && !isWrite;

  const icon = TOOL_ICON[name] || "cog";
  const tone = isEdit || isWrite ? "diff" : meta.kind === "bash" ? "term" : "";

  return (
    <div className={"cv-tool " + tone}>
      <div
        className="cv-tool-h"
        onClick={canToggle ? () => setOpen((o) => !o) : undefined}
        style={canToggle ? { cursor: "pointer" } : undefined}
      >
        <Ico name={icon} className="sm" />
        <span className="cv-tool-t">{name}</span>
        {meta.primaryArg ? <span className="cv-tool-m wf-mono">{meta.primaryArg}</span> : null}
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
          {isEdit ? (
            <DiffView
              path={field(input, "file_path")}
              oldText={field(input, "old_string") ?? ""}
              newText={field(input, "new_string") ?? ""}
            />
          ) : isWrite ? (
            <DiffView path={field(input, "file_path")} newText={field(input, "content") ?? ""} />
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
      <Avatar ai>✦</Avatar>
      <div className="cv-aibody">
        {turn.blocks !== null ? (
          <AssistantBlocks session={session} blocks={turn.blocks} />
        ) : (
          <>
            {turn.streamingThinking && <ThinkingBlock text={turn.streamingThinking} finalized={false} />}
            {turn.streamingText && <StreamMarkdown text={turn.streamingText} streaming />}
          </>
        )}
      </div>
    </div>
  );
}

// ---- Ask box (the real request: question / permission / questionnaire) ----

interface Ask {
  kind: "question" | "permission" | "questions" | "error" | "blocked";
  text?: string;
  cmd?: string;
  questions?: string[];
}

function toAsk(req: PermissionRequestPayload): Ask {
  if (req.tool_name === "AskUserQuestion") {
    const input = req.input as Record<string, JsonValue> | null;
    const raw = input && Array.isArray(input.questions) ? input.questions : [];
    const questions = raw.map((q) => {
      const o = q as Record<string, JsonValue>;
      return typeof o?.question === "string" ? o.question : String(q);
    });
    return { kind: "questions", questions };
  }
  if (req.tool_name === "Bash") {
    return { kind: "permission", text: "Autoriser l'exécution de la commande ?", cmd: field(req.input, "command") };
  }
  const target = field(req.input, "file_path");
  return {
    kind: "permission",
    text: req.description || (target ? `Autoriser la modification de ${target} ?` : `Autoriser ${req.tool_name} ?`),
  };
}

function AskTurn({ session, request }: { session: string; request: PermissionRequestPayload }) {
  const answer = useAnswerPermission(session);
  const ask = toAsk(request);
  const allow = () =>
    answer.mutate({ requestId: request.request_id, decision: { behavior: "allow", updated_input: null } });
  const deny = () =>
    answer.mutate({ requestId: request.request_id, decision: { behavior: "deny", message: "Refusé." } });

  const meta =
    ask.kind === "questions"
      ? { icon: "form", label: `${ask.questions?.length ?? 0} questions à répondre` }
      : { icon: "key", label: "Demande une autorisation" };

  return (
    <div className="cv-msg cv-ai">
      <Avatar ai>✦</Avatar>
      <div className="cv-aibody">
        <div className="cv-ask-turn">
          <div className="wf-ask">
            <div className="wf-ask-h">
              <Ico name={meta.icon} className="sm" />
              {meta.label}
            </div>
            {ask.kind === "questions" ? (
              <ol className="wf-ask-q">
                {ask.questions?.map((q, i) => <li key={i}>{q}</li>)}
              </ol>
            ) : (
              <>
                <div className="wf-ask-t">{ask.text}</div>
                {ask.cmd ? <code className="wf-ask-cmd wf-mono">$ {ask.cmd}</code> : null}
              </>
            )}
          </div>
          <div className="wf-row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <button className="wf-btn ghost sm" onClick={deny}>
              Refuser
            </button>
            <button className="wf-btn prim sm" onClick={allow}>
              <Ico name="check" className="sm" />
              {ask.kind === "questions" ? `Répondre (${ask.questions?.length ?? 0})` : "Autoriser"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ConductorThread({ session, wide }: { session: string; wide?: boolean }) {
  const timeline = useTimeline(session);
  const pending = usePendingPermissions(session);
  const state = useSessionState(session);
  const busy = state?.busy ?? false;
  const awaiting = state?.awaiting_permission ?? false;
  const empty = timeline.length === 0 && pending.length === 0;

  const { scrollRef, contentRef } = useStickToBottom();

  return (
    <div className="cv-thread" ref={scrollRef}>
      <div
        className="cv-thread-inner"
        ref={contentRef}
        style={wide ? { maxWidth: 720 } : { maxWidth: 760 }}
      >
        {empty && !busy ? (
          <div className={styles.empty}>Démarre la conversation en envoyant un message.</div>
        ) : (
          <>
            <div className="cv-day">
              <span className="wf-line" />
              aujourd'hui
              <span className="wf-line" />
            </div>
            {timeline.map((entry) =>
              entry.kind === "turn" ? (
                <TurnRow key={entry.id} session={session} turnId={entry.id} />
              ) : null,
            )}
            {pending.map((req) => (
              <AskTurn key={req.request_id} session={session} request={req} />
            ))}
            {busy && !awaiting && (
              <div className={styles.activity}>
                <Ico name="spark" className="sm wf-spin" />
                <span>{state?.activity ? state.activity : "Travaille…"}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TurnRow({ session, turnId }: { session: string; turnId: string }) {
  const turn = useTurn(session, turnId);
  if (!turn) return null;
  if (turn.role === "user") return <MsgUser text={turn.streamingText} />;
  return <MsgAI session={session} turnId={turnId} />;
}
