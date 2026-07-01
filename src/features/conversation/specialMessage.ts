// Some messages reach the thread as a plain `user_message` but aren't the human
// speaking — the CLI injects them. The prime example is a `<task-notification>` block,
// emitted when a background task/agent finishes (task-id, status, summary, result,
// usage…). Rendered raw it's unreadable XML. We detect these injected "special
// messages" here and route them to a dedicated card, mirroring how `userText`
// special-cases slash-commands. Pure + tested; the SAME parse feeds the live thread
// (MsgUser) and the disk transcript (SubAgentTranscript) so both render identically.
//
// The union is deliberately open (`SpecialMessage`) so future injected markers get a
// new `type` here rather than another ad-hoc branch scattered across the renderers.

export interface TaskNotificationUsage {
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

export interface TaskNotification {
  type: "task-notification";
  taskId: string | null;
  toolUseId: string | null;
  outputFile: string | null;
  /** completed | failed | killed | stopped | … — kept verbatim; the UI maps known ones. */
  status: string | null;
  summary: string | null;
  /** Model-directed boilerplate ("a task-notification fires each time…"); de-emphasised. */
  note: string | null;
  /** The (possibly very long) body — a sub-agent's final report, a command's output… */
  result: string | null;
  usage: TaskNotificationUsage | null;
}

/** Extensible union: add future injected markers as new members. */
export type SpecialMessage = TaskNotification;

const TN_OPEN = "<task-notification>";
const TN_CLOSE = "</task-notification>";

/** First `<tag>…</tag>` (non-greedy), trimmed — for the short scalar fields near the top. */
function scalar(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? m[1].trim() : null;
}

function intField(body: string, tag: string): number | null {
  const raw = scalar(body, tag);
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** The `result` body can hold arbitrary text (markdown, angle brackets, even
 *  tag-looking substrings), so we grab from the first `<result>` to the LAST
 *  `</result>` — robust to `<…>` (and a stray `</result>`) inside the report. */
function resultField(body: string): string | null {
  const open = body.indexOf("<result>");
  if (open === -1) return null;
  const close = body.lastIndexOf("</result>");
  if (close === -1 || close < open) return null;
  const inner = body.slice(open + "<result>".length, close).trim();
  return inner.length ? inner : null;
}

function usageField(body: string): TaskNotificationUsage | null {
  const m = /<usage>([\s\S]*?)<\/usage>/.exec(body);
  if (!m) return null;
  const usage: TaskNotificationUsage = {
    tokens: intField(m[1], "subagent_tokens"),
    toolUses: intField(m[1], "tool_uses"),
    durationMs: intField(m[1], "duration_ms"),
  };
  if (usage.tokens == null && usage.toolUses == null && usage.durationMs == null) return null;
  return usage;
}

/** Detect an injected special message inside a user-message's text. Returns `null`
 *  for ordinary prompts — including prose that merely *mentions* `<task-notification>`
 *  (we require the trimmed text to OPEN with the tag; real injections always do, and
 *  hand-written prompts referencing it in prose never do). */
export function parseSpecialMessage(text: string): SpecialMessage | null {
  const t = text.trimStart();
  if (!t.startsWith(TN_OPEN)) return null;
  const close = t.lastIndexOf(TN_CLOSE);
  if (close === -1) return null;
  const body = t.slice(TN_OPEN.length, close);
  return {
    type: "task-notification",
    taskId: scalar(body, "task-id"),
    toolUseId: scalar(body, "tool-use-id"),
    outputFile: scalar(body, "output-file"),
    status: scalar(body, "status"),
    summary: scalar(body, "summary"),
    note: scalar(body, "note"),
    result: resultField(body),
    usage: usageField(body),
  };
}

export type NotifTone = "ok" | "err" | "warn" | "muted";

export interface NotifStyle {
  /** `Ico` glyph name. */
  icon: string;
  tone: NotifTone;
  /** French status label shown in the pill. */
  label: string;
}

/** Map a task-notification `status` to its icon glyph, colour tone and French label.
 *  Pure so the mapping is testable without rendering the card. */
export function taskNotificationStyle(status: string | null): NotifStyle {
  switch ((status || "").toLowerCase()) {
    case "completed":
      return { icon: "check", tone: "ok", label: "Terminé" };
    case "failed":
      return { icon: "alert", tone: "err", label: "Échec" };
    case "killed":
      return { icon: "x", tone: "err", label: "Tué" };
    case "stopped":
      return { icon: "stopc", tone: "warn", label: "Arrêté" };
    default:
      return { icon: "bolt", tone: "muted", label: status ? status : "Notification" };
  }
}
