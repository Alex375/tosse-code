// Worktree manager: a modal, opened per repo, that lists the repository's
// worktrees — branch / path / status / the conversations attached to each — and
// lets the user remove one (strictly guarded) or start a conversation in one.
// Worktrees are CREATED elsewhere: by the agent (EnterWorktree) or via the
// composer's "worktree" toggle when starting a conversation — not from here, to
// keep this view a clean, read-mostly overview.
//
// Deletion guard (strict): the main worktree can never be removed; a worktree
// with a LIVE session running in it is blocked; a worktree with uncommitted or
// untracked work requires an explicit "force" confirmation (a separate, clearly
// destructive button). Everything else deletes cleanly. The actual git-level
// safety is delegated to `git worktree remove` (see the Rust git module).
import { useState } from "react";
import { Ico } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useRemoveWorktree, useWorktreeStatus, useWorktrees } from "../../ipc/useWorktrees";
import type { WorktreeInfo } from "../../ipc/client";
import {
  createConversationInWorktree,
  repoName,
  useConversations,
  useConversationsStore,
  type Conversation,
} from "../../store/conversationsStore";
import { effectiveCwd, resolveWorktree, worktreeLabel, worktreeName } from "./worktree";
import { useWorktreeUi } from "./worktreeUiStore";
import styles from "./WorktreeManager.module.css";

export function WorktreeManager() {
  const repoId = useWorktreeUi((s) => s.managerRepoId);
  const close = useWorktreeUi((s) => s.closeManager);
  const repoPath = useConversationsStore(
    (s) => s.repos.find((r) => r.id === repoId)?.path ?? null,
  );
  const conversations = useConversations();
  const { data: worktrees, isLoading, isError, error, refetch, isFetching } =
    useWorktrees(repoPath);
  // A manual refresh that fails while a previous list is still shown would
  // otherwise be swallowed (the query keeps status:"success" with stale data),
  // so we surface the refetch error explicitly.
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Hooks are all above this guard so their order never changes between renders.
  if (!repoId || !repoPath) return null;

  // Start a conversation rooted in a worktree (same repo group, worktree cwd),
  // then close the manager so the user lands on it.
  function openConversationIn(cwd: string) {
    createConversationInWorktree(repoId!, cwd);
    close();
  }

  // Conversations of THIS repo, grouped by the worktree they're in (live cwd if
  // the agent moved into one, else the spawn cwd).
  const convsForRepo = conversations.filter((c) => c.repoId === repoId);
  const convsByPath = new Map<string, Conversation[]>();
  if (worktrees) {
    for (const c of convsForRepo) {
      const wt = resolveWorktree(effectiveCwd(c, undefined), worktrees);
      if (!wt) continue;
      const arr = convsByPath.get(wt.path) ?? [];
      arr.push(c);
      convsByPath.set(wt.path, arr);
    }
  }

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="branch" className="sm" />
          <span className={styles.title}>
            Worktrees <span className={styles.titleRepo}>· {repoName(repoPath)}</span>
          </span>
          <button
            className={styles.iconBtn}
            onClick={async () => {
              setRefreshError(null);
              const r = await refetch();
              if (r.isError) {
                setRefreshError((r.error as Error)?.message ?? "Échec du rafraîchissement.");
              }
            }}
            disabled={isFetching}
            title="Rafraîchir"
            aria-label="Rafraîchir"
          >
            <Ico name="refresh" className={"sm" + (isFetching ? " " + styles.spin : "")} />
          </button>
          <button className={styles.iconBtn} onClick={close} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {refreshError ? <div className={styles.error}>{refreshError}</div> : null}

          {/* Worktree list */}
          {isLoading ? (
            <div className={styles.empty}>Chargement…</div>
          ) : isError ? (
            /not a git repository/i.test((error as Error).message) ? (
              // A plain folder, not a git repo → no worktrees. Calm, not an error.
              <div className={styles.empty}>
                Ce dossier n'est pas un dépôt git — il n'y a pas de worktree à gérer.
              </div>
            ) : (
              <div className={styles.error}>{(error as Error).message}</div>
            )
          ) : worktrees && worktrees.length > 0 ? (
            <div className={styles.list}>
              {worktrees
                .filter((w) => !w.is_bare)
                .map((w) => (
                  <WorktreeRow
                    key={w.path}
                    repoPath={repoPath}
                    worktree={w}
                    convs={convsByPath.get(w.path) ?? []}
                    onOpenConversation={() => openConversationIn(w.path)}
                  />
                ))}
            </div>
          ) : (
            <div className={styles.empty}>Aucun worktree.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorktreeRow({
  repoPath,
  worktree,
  convs,
  onOpenConversation,
}: {
  repoPath: string;
  worktree: WorktreeInfo;
  convs: Conversation[];
  onOpenConversation: () => void;
}) {
  const { data: status, isError: statusError, error: statusErr } = useWorktreeStatus(worktree.path);
  const remove = useRemoveWorktree(repoPath);
  const [confirming, setConfirming] = useState(false);

  const liveHere = convs.some((c) => c.handle != null);
  const dirty = !!status && (status.dirty || status.untracked);
  const canDelete = !worktree.is_main && !liveHere;

  const disabledReason = worktree.is_main
    ? "Le worktree principal ne peut pas être supprimé."
    : liveHere
      ? "Une session tourne dans ce worktree — arrête-la d'abord."
      : undefined;

  function confirmDelete() {
    // `force` only when there is uncommitted/untracked work — and only ever
    // through this explicit, separate confirmation (the strict guard).
    remove.mutate(
      { worktreePath: worktree.path, force: dirty },
      // Close the dialog on success AND on error: on error the row's red error
      // message (remove.error) must become visible — it would otherwise stay
      // hidden behind the still-open dialog, looking like nothing happened.
      { onSuccess: () => setConfirming(false), onError: () => setConfirming(false) },
    );
  }

  return (
    <div className={styles.row}>
      {/* Header: the worktree's name + the branch it has checked out, then status. */}
      <div className={styles.rowTop}>
        <span className={styles.wtName}>
          <Ico name="folder" className="sm" />
          {worktreeName(worktree)}
        </span>
        <span className={styles.branchTag} title={`Branche checkout : ${worktreeLabel(worktree)}`}>
          <Ico name="branch" className="sm" />
          {worktreeLabel(worktree)}
        </span>
        {worktree.is_main ? <span className={`${styles.tag} ${styles.tagMain}`}>principal</span> : null}
        {worktree.is_locked ? <span className={styles.tag}>verrouillé</span> : null}
        {worktree.is_detached ? <span className={styles.tag}>détaché</span> : null}
        <span className={styles.spacer} />
        {/* git status — error is surfaced (never shown as a neutral "—"). */}
        {statusError ? (
          <span className={styles.statusErr} title={(statusErr as Error)?.message}>
            statut indisponible
          </span>
        ) : status ? (
          dirty ? (
            <span className={styles.dirty}>
              {status.changed_files} modif.{status.untracked ? " · non suivis" : ""}
            </span>
          ) : (
            <span className={styles.clean}>propre</span>
          )
        ) : (
          <span className={styles.muted}>…</span>
        )}
        {status && (status.ahead != null || status.behind != null) ? (
          <span className={styles.muted}>↑{status.ahead ?? 0} ↓{status.behind ?? 0}</span>
        ) : null}
      </div>

      {/* Who is here: attached conversations + a live-session marker. */}
      <div className={styles.meta}>
        <span>
          {convs.length === 0
            ? "aucune conversation"
            : `${convs.length} conversation${convs.length > 1 ? "s" : ""}`}
        </span>
        {liveHere ? (
          <span className={styles.live}>
            <span className={styles.dot} />
            session active
          </span>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button
          className={styles.btn}
          onClick={onOpenConversation}
          title="Démarrer une conversation dans ce worktree"
        >
          + conversation
        </button>
        <span className={styles.spacer} />
        <button
          className={`${styles.btn} ${styles.danger}`}
          disabled={!canDelete || remove.isPending}
          title={disabledReason}
          onClick={() => setConfirming(true)}
        >
          Supprimer
        </button>
      </div>

      {remove.isError ? (
        <div className={styles.error}>{(remove.error as Error).message}</div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        danger
        busy={remove.isPending}
        title={`Supprimer le worktree « ${worktreeLabel(worktree)} » ?`}
        confirmLabel={dirty ? "Forcer la suppression" : "Supprimer"}
        onCancel={() => setConfirming(false)}
        onConfirm={confirmDelete}
      >
        Le dossier <span className="wf-mono">{worktree.path}</span> sera supprimé. La branche{" "}
        <span className="wf-mono">{worktreeLabel(worktree)}</span> est conservée (seul le worktree
        est retiré).
        {convs.length > 0
          ? ` ⚠️ ${convs.length} conversation${convs.length > 1 ? "s" : ""} y ${convs.length > 1 ? "sont rattachées et perdront" : "est rattachée et perdra"} son dossier de travail (tu pourras les relancer, mais plus dans ce worktree).`
          : ""}
        {dirty
          ? " ⚠️ Ce worktree a des modifications non commitées qui seront définitivement perdues."
          : ""}
      </ConfirmDialog>
    </div>
  );
}
