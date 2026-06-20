import { useRef, useState } from "react";
import { pickFolder } from "../../ipc/pickFolder";
import {
  createConversationInRepo,
  repoName,
  streamStatus,
  useActiveConversationId,
  useConversations,
  useConversationsStore,
  useRepos,
  type Conversation,
  type Repo,
} from "../../store/conversationsStore";
import { useSessionState } from "../../store/conversationStore";
import { useSettingsUi } from "../../store/settingsUi";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Dot, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { WorktreeBadge } from "../git/WorktreeBadge";
import { useWorktreeUi } from "../git/worktreeUiStore";

function ConvRow({ conv, active }: { conv: Conversation; active: boolean }) {
  // State is keyed by the conversation's stable id (the message store routes
  // live events back to it); undefined until it has been live at least once.
  const state = useSessionState(conv.id);
  const select = useConversationsStore((s) => s.selectConversation);
  const rename = useConversationsStore((s) => s.renameConversation);
  const remove = useConversationsStore((s) => s.removeConversation);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.name);
  const [confirming, setConfirming] = useState(false);
  // Both Enter/blur commit and Escape cancel unmount the input, which fires a
  // trailing `onBlur`. This latch makes the commit run exactly once and lets
  // Escape suppress it entirely (so a cancel never writes the edited draft).
  const settled = useRef(false);

  function startEdit() {
    settled.current = false;
    setDraft(conv.name);
    setEditing(true);
  }
  function commitEdit() {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    rename(conv.id, draft); // the store ignores a blank or unchanged title
  }
  function cancelEdit() {
    settled.current = true; // suppress the trailing blur-commit
    setEditing(false);
  }

  if (editing) {
    return (
      <div className={"cv-sess-row" + (active ? " on" : "")}>
        <span className="cv-sess" style={{ cursor: "default" }}>
          <Dot s={streamStatus(conv.handle, state)} pulse />
          <input
            className="cv-sess-edit"
            value={draft}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              else if (e.key === "Escape") cancelEdit();
            }}
            onBlur={commitEdit}
          />
        </span>
      </div>
    );
  }

  return (
    <div className={"cv-sess-row" + (active ? " on" : "")}>
      <button
        type="button"
        className="cv-sess"
        onClick={() => select(conv.id)}
        onDoubleClick={startEdit}
      >
        <Dot s={streamStatus(conv.handle, state)} pulse />
        <span className="cv-sess-n">{conv.name}</span>
      </button>
      <WorktreeBadge conv={conv} />
      <Menu
        align="right"
        trigger={
          <button
            type="button"
            className="cv-sess-menu"
            title="Options de la conversation"
            aria-label="Options de la conversation"
          >
            <Ico name="dots" className="sm" />
          </button>
        }
      >
        <MenuItem icon="form" onClick={startEdit}>
          Renommer
        </MenuItem>
        <MenuItem icon="trash" onClick={() => setConfirming(true)}>
          Supprimer
        </MenuItem>
      </Menu>
      <ConfirmDialog
        open={confirming}
        danger
        title="Supprimer la conversation ?"
        confirmLabel="Supprimer"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          remove(conv.id);
        }}
      >
        « {conv.name} » sera retirée de la liste et son process arrêté. Le transcript de
        Claude sur le disque n'est pas touché.
      </ConfirmDialog>
    </div>
  );
}

/** Open the native folder picker, then start a conversation in the chosen folder. */
async function newConversationInPickedFolder() {
  const path = await pickFolder();
  if (path) void createConversationInRepo(path);
}

export function ConductorSidebar() {
  const repos = useRepos();
  const conversations = useConversations();
  const activeId = useActiveConversationId();
  const openManager = useWorktreeUi((s) => s.openManager);
  const settingsOpen = useSettingsUi((s) => s.open);
  const openSettings = useSettingsUi((s) => s.openSettings);
  const closeSettings = useSettingsUi((s) => s.closeSettings);

  // Group conversations by their repo, then order everything by recency: within a
  // repo the most recently active conversation comes first, and repos are ordered
  // by their most recent conversation (an empty repo falls back to when it was
  // added). So the conversation with the latest message — sent or received — sits
  // at the very top.
  const byRepo = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const arr = byRepo.get(c.repoId) ?? [];
    arr.push(c);
    byRepo.set(c.repoId, arr);
  }
  for (const arr of byRepo.values()) {
    arr.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
  const repoRecency = (r: Repo) => byRepo.get(r.id)?.[0]?.lastActivityAt ?? r.addedAt;
  const ordered = [...repos].sort((a, b) => repoRecency(b) - repoRecency(a));

  return (
    <div
      className="wf-col cv-side"
      style={{ width: 224, flex: "0 0 224px", borderRight: "1px solid var(--wf-line)", background: "var(--wf-bg-2)" }}
    >
      <div className="cv-side-h">
        <span className="wf-row" style={{ gap: 7 }}>
          <span className="wf-avatar ai">✦</span>
          <span className="wf-hi" style={{ fontWeight: 600 }}>
            Conductor
          </span>
        </span>
        <Menu
          align="right"
          trigger={
            <button className="wf-icon-btn" title="Nouvelle conversation">
              <Ico name="plus" className="sm" />
            </button>
          }
        >
          <MenuLabel>Nouvelle conversation dans…</MenuLabel>
          {ordered.map((r) => (
            <MenuItem key={r.id} icon="folder" onClick={() => void createConversationInRepo(r.path)}>
              {repoName(r.path)}
            </MenuItem>
          ))}
          <MenuItem icon="plus" onClick={() => void newConversationInPickedFolder()}>
            Ajouter un dossier…
          </MenuItem>
        </Menu>
      </div>

      <div className="cv-search">
        <Ico name="search" className="sm" />
        <span className="wf-xmuted" style={{ fontSize: 12 }}>
          Rechercher
        </span>
      </div>

      <div className="cv-sess-scroll wf-fade-b">
        {ordered.length === 0 ? (
          <div style={{ padding: "20px 12px", color: "var(--wf-tx-lo)", fontSize: 12, lineHeight: 1.6 }}>
            Aucun dépôt. Clique sur <span className="wf-hi">＋</span> pour ouvrir un dossier.
          </div>
        ) : (
          ordered.map((repo) => {
            const items = byRepo.get(repo.id) ?? [];
            return (
              <div key={repo.id} className="cv-repo">
                <div className="cv-repo-h">
                  <button
                    type="button"
                    className="cv-repo-wt"
                    title="Gérer les worktrees de ce dépôt"
                    onClick={() => openManager(repo.id)}
                  >
                    <Ico name="folder" className="sm" />
                    <span className="cv-repo-n">{repoName(repo.path)}</span>
                    <Ico name="branch" className="sm cv-repo-wt-hint" />
                  </button>
                  <button
                    className="cv-repo-add"
                    title="Nouvelle conversation dans ce dépôt"
                    onClick={() => void createConversationInRepo(repo.path)}
                  >
                    <Ico name="plus" className="sm" />
                  </button>
                  <span className="cv-repo-c">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <div className="cv-repo-empty">Aucune conversation</div>
                ) : (
                  items.map((c) => <ConvRow key={c.id} conv={c} active={c.id === activeId} />)
                )}
              </div>
            );
          })
        )}
      </div>

      <button
        type="button"
        className="cv-side-foot"
        onClick={openSettings}
        style={{
          background: "transparent",
          borderLeft: 0,
          borderRight: 0,
          borderBottom: 0,
          width: "100%",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <Ico name="cog" className="sm" />
        <span className="wf-muted" style={{ fontSize: 12 }}>
          Réglages
        </span>
      </button>

      <SettingsPanel open={settingsOpen} onClose={closeSettings} />
    </div>
  );
}
