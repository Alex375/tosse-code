// Stable IPC surface for the whole app.
// Features import { commands, events } from here, never from ./bindings (raw,
// generated) nor ./provider (the real/mock switch). Types come straight from the
// generated bindings so they always track the Rust contract.

export { commands, events, isTauri } from "./provider";

export type {
  ConversationItem,
  ConversationRecord,
  FileContent,
  FsChangeEvent,
  FsEntry,
  ImageContent,
  JsonValue,
  NormalizedBlock,
  PermissionDecision,
  PermissionMode,
  PermissionRequestPayload,
  PersistedState,
  PlanUsage,
  Pong,
  RepoRecord,
  Result,
  SessionCommandsEvent,
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionStateEvent,
  SessionStatePayload,
  SessionTitleEvent,
  SlashCommand,
  TickEvent,
  UsageError,
  UsageWindow,
  WorktreeInfo,
  WorktreeStatus,
} from "./bindings";
