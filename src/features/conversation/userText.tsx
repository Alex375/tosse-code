// Rendering of a USER message's text. A slash-command invocation reaches us wrapped by
// the CLI as `<command-message>…</command-message><command-name>/foo</command-name>
// <command-args>…</command-args>` — raw noise the user shouldn't read. We surface it as a
// clean command chip instead. Shared by the live thread (MsgUser) and the disk transcript
// (SubAgentTranscript) so both render commands identically.
import { Ico } from "../../ui/kit";

const NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/** Pull the command + args out of a CLI-wrapped slash-command message; `null` when the
 *  text isn't a command invocation (a normal prompt). */
export function parseSlashCommand(text: string): { command: string; args: string } | null {
  const m = NAME_RE.exec(text);
  if (!m) return null;
  let command = m[1].trim();
  if (!command) return null;
  if (!command.startsWith("/")) command = "/" + command;
  const a = ARGS_RE.exec(text);
  const args = a ? a[1].trim() : "";
  return { command, args };
}

/** A user message's text: a slash-command shows as a clean chip (the `<command-*>` wrapper
 *  is dropped), everything else renders as-is. */
export function UserText({ text }: { text: string }) {
  const cmd = parseSlashCommand(text);
  if (!cmd) return <>{text}</>;
  return (
    <span className="cv-cmd">
      <Ico name="wand" className="sm" />
      <span className="cv-cmd-name">{cmd.command}</span>
      {cmd.args ? <span className="cv-cmd-args">{cmd.args}</span> : null}
    </span>
  );
}
