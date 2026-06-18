import {
  Bot,
  FilePen,
  FilePlus,
  FileText,
  FolderTree,
  Globe,
  ListTodo,
  Search,
  TerminalSquare,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { JsonValue } from "../../ipc/client";

export type ToolKind = "edit" | "write" | "bash" | "plain";

export interface ToolMeta {
  icon: LucideIcon;
  /** The salient argument shown on the card header (path, command, pattern…). */
  primaryArg: string | null;
  /** Internal IDE-control RPC tools are hidden from the transcript. */
  suppressed: boolean;
  kind: ToolKind;
}

function asObject(v: JsonValue): Record<string, JsonValue> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : {};
}

function str(v: JsonValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function toolMeta(name: string, input: JsonValue): ToolMeta {
  const obj = asObject(input);
  const fp = str(obj.file_path);
  const fileArg = fp ? basename(fp) : null;

  switch (name) {
    case "Read":
      return { icon: FileText, primaryArg: fileArg, suppressed: false, kind: "plain" };
    case "Edit":
    case "MultiEdit":
      return { icon: FilePen, primaryArg: fileArg, suppressed: false, kind: "edit" };
    case "Write":
      return { icon: FilePlus, primaryArg: fileArg, suppressed: false, kind: "write" };
    case "Bash":
      return {
        icon: TerminalSquare,
        primaryArg: str(obj.command),
        suppressed: false,
        kind: "bash",
      };
    case "Grep":
      return { icon: Search, primaryArg: str(obj.pattern), suppressed: false, kind: "plain" };
    case "Glob":
      return { icon: FolderTree, primaryArg: str(obj.pattern), suppressed: false, kind: "plain" };
    case "WebFetch":
      return { icon: Globe, primaryArg: str(obj.url), suppressed: false, kind: "plain" };
    case "WebSearch":
      return { icon: Search, primaryArg: str(obj.query), suppressed: false, kind: "plain" };
    case "TodoWrite":
      // Suppressed from the transcript: the to-do list is rendered by the
      // dedicated pinned <TodoBar>, so the raw tool card would be a duplicate.
      return { icon: ListTodo, primaryArg: null, suppressed: true, kind: "plain" };
    case "Task":
      return { icon: Bot, primaryArg: str(obj.description), suppressed: false, kind: "plain" };
    default:
      return {
        icon: Wrench,
        primaryArg: fileArg ?? str(obj.command) ?? str(obj.pattern),
        suppressed: /^(mcp__ide__|ide_)/.test(name),
        kind: "plain",
      };
  }
}
