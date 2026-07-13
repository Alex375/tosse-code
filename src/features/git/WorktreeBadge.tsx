// Sidebar badge: a small branch glyph on a conversation row when that
// conversation works in a LINKED (non-main) worktree. Hover shows the worktree
// name; click opens the manager. Renders nothing for conversations on the main
// worktree — so the common case stays completely clean.
import { Ico } from "../../ui/kit";
import { useWorktrees } from "../../ipc/useWorktrees";
import { useSessionState } from "../../store/conversationStore";
import { useConversationsStore, type Conversation } from "../../store/conversationsStore";
import { effectiveCwd, isLinked, resolveWorktree, worktreeLabel } from "./worktree";
import { useWorktreeUi } from "./worktreeUiStore";

export function WorktreeBadge({ conv }: { conv: Conversation }) {
  const repoPath = useConversationsStore(
    (s) => s.repos.find((r) => r.id === conv.repoId)?.path ?? null,
  );
  // One shared query per repo (deduped across rows by the ["worktrees", path] key).
  const { data: worktrees } = useWorktrees(repoPath);
  const state = useSessionState(conv.id);
  const openManager = useWorktreeUi((s) => s.openManager);

  if (!worktrees) return null;
  const wt = resolveWorktree(effectiveCwd(conv, state), worktrees);
  if (!wt || !isLinked(wt)) return null;

  return (
    <button
      type="button"
      className="cv-wt-badge"
      title={`Worktree "${worktreeLabel(wt)}"\nClick to manage worktrees`}
      aria-label={`Worktree ${worktreeLabel(wt)}`}
      onClick={(e) => {
        e.stopPropagation();
        openManager(conv.repoId);
      }}
    >
      <Ico name="branch" className="sm" />
    </button>
  );
}
