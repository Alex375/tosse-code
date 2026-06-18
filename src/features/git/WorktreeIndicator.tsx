// Conversation-header (top-right) indicator of the worktree the active
// conversation works in RIGHT NOW — it follows the agent when it moves into a
// worktree (EnterWorktree) and back out (ExitWorktree), via the conversation's
// live cwd. Shows the worktree's branch name, accented when it is a LINKED
// (non-main) worktree. Click opens the worktree manager for the repo. Renders
// nothing when the repo is not a git repository so it never adds noise.
import { Ico } from "../../ui/kit";
import { useWorktrees } from "../../ipc/useWorktrees";
import { useSessionState } from "../../store/conversationStore";
import type { Conversation } from "../../store/conversationsStore";
import { effectiveCwd, isLinked, mainWorktree, resolveWorktree, worktreeName } from "./worktree";
import { useWorktreeUi } from "./worktreeUiStore";

export function WorktreeIndicator({
  conv,
  repoPath,
}: {
  conv: Conversation;
  repoPath: string;
}) {
  const { data: worktrees } = useWorktrees(repoPath);
  const state = useSessionState(conv.id);
  const openManager = useWorktreeUi((s) => s.openManager);

  // Not a git repo / not loaded yet → show nothing.
  if (!worktrees || worktrees.length === 0) return null;

  // The worktree the conversation is in now (live cwd → session cwd → spawn cwd),
  // falling back to the main worktree if it can't be resolved (e.g. a relative ".").
  const cwd = effectiveCwd(conv, state);
  const wt = resolveWorktree(cwd, worktrees) ?? mainWorktree(worktrees);
  if (!wt) return null;

  const linked = isLinked(wt);
  // The worktree's NAME (its directory) when in a linked worktree, else just
  // "principal" for the main checkout. Branch names live in the manager, not here.
  const label = linked ? worktreeName(wt) : "principal";
  const extra = worktrees.filter((w) => !w.is_bare).length - 1;

  // Colour carries the "am I in a worktree?" answer: accent = a linked worktree,
  // neutral = the repo's main checkout.
  return (
    <button
      type="button"
      className="wf-chip"
      style={{ cursor: "pointer", color: linked ? "var(--wf-accent)" : "var(--wf-tx-lo)" }}
      onClick={() => openManager(conv.repoId)}
      title={
        linked
          ? `Worktree « ${worktreeName(wt)} »\n${wt.path}\nCliquer pour gérer les worktrees`
          : `Arbre de travail principal (pas un worktree lié)${extra > 0 ? `\n${extra} worktree${extra > 1 ? "s" : ""} lié${extra > 1 ? "s" : ""} dans ce dépôt` : ""}\nCliquer pour gérer les worktrees`
      }
      aria-label="Gérer les worktrees"
    >
      <Ico name="branch" className="sm" />
      <span className="wf-chip-t">{label}</span>
      {extra > 0 ? (
        <span className="wf-chip-t" style={{ opacity: 0.5 }}>
          +{extra}
        </span>
      ) : null}
    </button>
  );
}
