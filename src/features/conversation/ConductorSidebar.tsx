import { useRef, useState } from "react";
import { pickFolder } from "../../ipc/pickFolder";
import {
  acknowledgeConversation,
  createConversationInRepo,
  repoName,
  useActiveConversationId,
  useConversationsByRepo,
  useConversationsStore,
  type Conversation,
} from "../../store/conversationsStore";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { agentStatusToDot, isDismissable, rowAttention } from "../../agent/status";
import { useSettingsUi } from "../../store/settingsUi";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Dot, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { WorktreeBadge } from "../git/WorktreeBadge";
import { useWorktreeUi } from "../git/worktreeUiStore";
import { useExtensionsUi } from "../extensions/extensionsUiStore";

function ConvRow({ conv, active }: { conv: Conversation; active: boolean }) {
  // Rich status keyed by the conversation's stable id (the message store routes
  // live events back to it). Drives the dot colour, the whole-row highlight, and
  // the "Vu" acknowledge button.
  const status = useAgentStatus(conv.id);
  const attn = rowAttention(status);
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
      <div className={"cv-sess-row" + (active ? " on" : "")} data-attn={attn ?? undefined}>
        <span className="cv-sess" style={{ cursor: "default" }}>
          <Dot s={agentStatusToDot(status)} pulse />
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
    <div className={"cv-sess-row" + (active ? " on" : "")} data-attn={attn ?? undefined}>
      <button
        type="button"
        className="cv-sess"
        onClick={() => select(conv.id)}
        onDoubleClick={startEdit}
      >
        <Dot s={agentStatusToDot(status)} pulse />
        <span className="cv-sess-n">{conv.name}</span>
      </button>
      <WorktreeBadge conv={conv} />
      {isDismissable(status) ? (
        <button
          type="button"
          className="cv-sess-seen"
          title="Marquer comme vu"
          aria-label="Marquer comme vu"
          onClick={(e) => {
            e.stopPropagation();
            acknowledgeConversation(conv.id);
          }}
        >
          <Ico name="check" className="sm" />
        </button>
      ) : null}
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
  // Repo-grouped, recency-ordered conversations — the shared selector used by both
  // this sidebar and the FlightDeck grid (see useConversationsByRepo).
  const groups = useConversationsByRepo();
  const activeId = useActiveConversationId();
  const openManager = useWorktreeUi((s) => s.openManager);
  const openExtensions = useExtensionsUi((s) => s.openManager);
  const settingsOpen = useSettingsUi((s) => s.open);
  const openSettings = useSettingsUi((s) => s.openSettings);
  const closeSettings = useSettingsUi((s) => s.closeSettings);

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
          {groups.map(({ repo: r }) => (
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
        {groups.length === 0 ? (
          <div style={{ padding: "20px 12px", color: "var(--wf-tx-lo)", fontSize: 12, lineHeight: 1.6 }}>
            Aucun dépôt. Clique sur <span className="wf-hi">＋</span> pour ouvrir un dossier.
          </div>
        ) : (
          groups.map(({ repo, conversations: items }) => {
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
                    className="cv-repo-ext"
                    title="Extensions de ce dépôt — MCP, plugins, skills, sous-agents"
                    onClick={() =>
                      openExtensions({
                        kind: "project",
                        path: repo.path,
                        title: repoName(repo.path),
                        session: null,
                      })
                    }
                  >
                    <Ico name="layers" className="sm" />
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
        onClick={() => openSettings()}
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
