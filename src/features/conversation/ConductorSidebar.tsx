import { useRef, useState } from "react";
import { pickFolder } from "../../ipc/pickFolder";
import { Splitter } from "../editor/Splitter";
import { useSidebar } from "../../store/sidebar";
import { TosseMark } from "../../ui/TosseMark";
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
import { agentStatusToDot, isDismissable, rowAttention, type AgentStatus } from "../../agent/status";
import { useSettingsUi } from "../../store/settingsUi";
import { useSidebarFold, useRepoCollapsed } from "../../store/sidebarFold";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Dot, Ico, Menu, MenuItem, MenuLabel, RunPulse } from "../../ui/kit";
import { WorktreeBadge } from "../git/WorktreeBadge";
import { useWorktreeUi } from "../git/worktreeUiStore";
import { useExtensionsUi } from "../extensions/extensionsUiStore";
import { useHistoryUi } from "../history/historyUiStore";

/** The conversation's status glyph: the "sonar" running indicator while a turn is in
 *  flight, otherwise the plain coloured status dot (review / attention / error / idle…). */
function StatusDot({ status }: { status: AgentStatus }) {
  if (status.kind === "running") return <RunPulse />;
  return <Dot s={agentStatusToDot(status)} pulse />;
}

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
          <StatusDot status={status} />
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
        <StatusDot status={status} />
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
      {/* Friction-free delete: one click removes the conversation immediately, no
          confirm dialog. It's reversible with ⌘Z (undoRemoveConversation) — the on-disk
          transcript is never touched, so nothing is truly lost. Mirrors the "Vu" button
          (cv-sess-seen) — revealed on row hover, danger-tinted. The × is the row's only
          inline affordance: rename is double-click on the name (startEdit). */}
      <button
        type="button"
        className="cv-sess-del"
        title="Supprimer la conversation (⌘Z pour annuler)"
        aria-label="Supprimer la conversation"
        onClick={(e) => {
          e.stopPropagation();
          remove(conv.id);
        }}
      >
        <Ico name="x" className="sm" />
      </button>
    </div>
  );
}

/** Open the native folder picker, then start a conversation in the chosen folder. */
async function newConversationInPickedFolder() {
  const path = await pickFolder();
  if (path) void createConversationInRepo(path);
}

/** One repo swimlane in the sidebar. Single-line header: collapse chevron + repo title,
 *  which flexes to run the full width up to the ALWAYS-visible new-conversation (+) button
 *  pinned at the right. Hovering the header slides in the secondary tools (worktrees,
 *  extensions) between the title and the +, at which point the title truncates to make room.
 *  So at rest the name reaches the right edge; the extra tools only appear on demand. The
 *  collapsed state is per-repo and persisted (see sidebarFold). */
function RepoGroup({
  repo,
  items,
  activeId,
}: {
  repo: { id: string; path: string };
  items: Conversation[];
  activeId: string | null;
}) {
  const collapsed = useRepoCollapsed(repo.id);
  const toggleFold = useSidebarFold((s) => s.toggle);
  const openManager = useWorktreeUi((s) => s.openManager);
  const openExtensions = useExtensionsUi((s) => s.openManager);

  return (
    <div className={"cv-repo" + (collapsed ? " collapsed" : "")}>
      <div className="cv-repo-h">
        {/* Chevron + title — the collapse toggle. Flexes to fill all the space the buttons
            leave, so at rest the name runs right up to the + at the edge. */}
        <button
          type="button"
          className="cv-repo-title"
          title={collapsed ? "Déplier ce dépôt" : "Replier ce dépôt"}
          aria-label={collapsed ? "Déplier ce dépôt" : "Replier ce dépôt"}
          aria-expanded={!collapsed}
          onClick={() => toggleFold(repo.id)}
        >
          <Ico name="chev" className="sm cv-repo-fold-chev" />
          <span className="cv-repo-n">{repoName(repo.path)}</span>
        </button>
        {/* Worktrees + extensions — revealed only on header hover (0-width at rest). */}
        <button
          type="button"
          className="cv-repo-act cv-repo-reveal"
          title="Ouvrir les worktrees de ce dépôt"
          onClick={() => openManager(repo.id)}
        >
          <Ico name="branch" className="sm" />
        </button>
        <button
          type="button"
          className="cv-repo-act cv-repo-reveal"
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
        {/* New conversation (+) — always visible, pinned at the right edge. */}
        <button
          type="button"
          className="cv-repo-act"
          title="Nouvelle conversation dans ce dépôt"
          onClick={() => void createConversationInRepo(repo.path)}
        >
          <Ico name="plus" className="sm" />
        </button>
      </div>
      {collapsed ? null : items.length === 0 ? (
        <div className="cv-repo-empty">Aucune conversation</div>
      ) : (
        items.map((c) => <ConvRow key={c.id} conv={c} active={c.id === activeId} />)
      )}
    </div>
  );
}

export function ConductorSidebar() {
  // Repo-grouped, recency-ordered conversations — the shared selector used by both
  // this sidebar and the FlightDeck grid (see useConversationsByRepo).
  const groups = useConversationsByRepo();
  const activeId = useActiveConversationId();
  const openHistory = useHistoryUi((s) => s.openPanel);
  const settingsOpen = useSettingsUi((s) => s.open);
  const openSettings = useSettingsUi((s) => s.openSettings);
  const closeSettings = useSettingsUi((s) => s.closeSettings);

  // Resizable width, persisted (localStorage). The grip is an absolute handle on the
  // right edge (reusing the editor's Splitter for pointer-capture + hover accent), so
  // resizing stays self-contained here — the parent flex row is untouched.
  const width = useSidebar((s) => s.width);
  const setWidth = useSidebar((s) => s.setWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const onResize = (clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWidth(clientX - rect.left);
  };

  return (
    <div
      ref={rootRef}
      className="wf-col cv-side"
      style={{
        width,
        flex: `0 0 ${width}px`,
        position: "relative",
        borderRight: "1px solid var(--wf-line)",
        background: "var(--wf-bg-2)",
      }}
    >
      <div className="cv-side-h">
        <span className="wf-row" style={{ gap: 8 }}>
          <TosseMark className="cv-brand-mark" />
          <span className="wf-hi" style={{ fontWeight: 600 }}>
            Tosse Code
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

      <button
        type="button"
        className="cv-search"
        title="Rechercher dans l'historique des conversations (tout le disque)"
        onClick={() => openHistory()}
      >
        <Ico name="search" className="sm" />
        <span className="wf-xmuted" style={{ fontSize: 12 }}>
          Historique
        </span>
      </button>

      <div className="cv-sess-scroll">
        {groups.length === 0 ? (
          <div style={{ padding: "20px 12px", color: "var(--wf-tx-lo)", fontSize: 12, lineHeight: 1.6 }}>
            Aucun dépôt. Clique sur <span className="wf-hi">＋</span> pour ouvrir un dossier.
          </div>
        ) : (
          groups.map(({ repo, conversations: items }) => (
            <RepoGroup key={repo.id} repo={repo} items={items} activeId={activeId} />
          ))
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

      {/* Drag handle on the right edge — resizes the sidebar, width persisted. */}
      <div className="cv-side-grip">
        <Splitter axis="x" onMove={onResize} />
      </div>
    </div>
  );
}
