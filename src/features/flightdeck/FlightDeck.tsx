// FlightDeck — the agent dashboard view ("Vue Gestion d'agents"). A grid of stream
// cards grouped by repo, with an attention bar on top. Reuses the shared repo
// grouping (useConversationsByRepo) so it orders identically to the sidebar, and
// each card reuses the same status/todo/context selectors as the conversation view.
import { useEffect, useState } from "react";
import { Ico } from "../../ui/kit";
import { createConversationInRepo, repoName } from "../../store/conversationsStore";
import { useFleetLanes } from "../../agent/fleet";
import { AttentionBar } from "./AttentionBar";
import { StreamCard } from "./StreamCard";

/** A coarse clock ticking every 30s so the relative "last activity" stamps on
 *  idle/off/review cards advance even when nothing else re-renders them. One
 *  interval for the whole grid (cheaper than one per card), scoped to mount. */
function useNow(periodMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}

export function FlightDeck({ onOpen }: { onOpen: (id: string) => void }) {
  const groups = useFleetLanes();
  const now = useNow();

  if (groups.length === 0) {
    return (
      <div className="ag-page wf-col">
        <div className="ag-empty">
          <Ico name="grid" />
          <div className="ag-empty-title">Aucun agent</div>
          <div>Ajoute un dépôt et démarre une conversation pour piloter tes agents ici.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="ag-page wf-col">
      <AttentionBar />
      <div className="ag-scroll wf-fade-b">
        {groups.map(({ repo, conversations }) => (
          <div key={repo.id} className="ag-repo">
            <div className="ag-repo-h">
              <Ico name="folder" className="sm" />
              <span className="wf-hi" style={{ fontWeight: 600, fontSize: 12.5 }}>
                {repoName(repo.path)}
              </span>
              <span className="wf-mono wf-xmuted" style={{ fontSize: 11 }}>
                {repo.path}
              </span>
              <span className="ag-repo-counts">
                <button
                  className="wf-icon-btn"
                  title="Nouvelle conversation dans ce dépôt"
                  onClick={() => void createConversationInRepo(repo.path)}
                >
                  <Ico name="plus" className="sm" />
                </button>
                <span className="wf-mono wf-xmuted" style={{ fontSize: 11 }}>
                  {conversations.length} stream{conversations.length > 1 ? "s" : ""}
                </span>
              </span>
            </div>
            {conversations.length === 0 ? (
              <div className="ag-repo-empty">Aucune conversation</div>
            ) : (
              <div className="ag-grid">
                {conversations.map((c) => (
                  <StreamCard key={c.id} conv={c} repoPath={repo.path} now={now} onOpen={onOpen} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
