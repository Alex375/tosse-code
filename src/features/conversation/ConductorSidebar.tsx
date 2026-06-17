import { useState } from "react";
import { pickFolder } from "../../ipc/pickFolder";
import {
  createConversationInRepo,
  repoName,
  sessionStreamState,
  useActiveConversationId,
  useConversations,
  useConversationsStore,
  useRepos,
  type Conversation,
} from "../../store/conversationsStore";
import { useSessionState } from "../../store/conversationStore";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Dot, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";

function ConvRow({ conv, active }: { conv: Conversation; active: boolean }) {
  // Live state is keyed by the Rust session handle, not the stable id.
  const state = useSessionState(conv.handle ?? "");
  const select = useConversationsStore((s) => s.selectConversation);
  return (
    <button
      type="button"
      className={"cv-sess" + (active ? " on" : "")}
      style={{ width: "100%", border: 0, background: active ? undefined : "transparent", textAlign: "left", cursor: "pointer" }}
      onClick={() => select(conv.id)}
    >
      <Dot s={sessionStreamState(state)} pulse />
      <span className="cv-sess-n">{conv.name}</span>
    </button>
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Group conversations by their repo (stable, ordered by when the repo was added).
  const byRepo = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const arr = byRepo.get(c.repoId) ?? [];
    arr.push(c);
    byRepo.set(c.repoId, arr);
  }
  const ordered = [...repos].sort((a, b) => a.addedAt - b.addedAt);

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
                  <Ico name="folder" className="sm" />
                  <span className="cv-repo-n" title={repo.path}>
                    {repoName(repo.path)}
                  </span>
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
        onClick={() => setSettingsOpen(true)}
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

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
