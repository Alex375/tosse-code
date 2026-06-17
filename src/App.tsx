import { useEffect, useRef, useState } from "react";
import { ConductorConversation } from "./features/conversation/ConductorConversation";
import { FleetPlaceholder } from "./features/fleet/FleetPlaceholder";
import { useGlobalSessionEvents } from "./ipc/useGlobalSessionEvents";
import {
  createConversationInRepo,
  resumeAllConversations,
  repoName,
  useActiveConversationId,
  useConversationRepo,
  useConversations,
  useConversationsStore,
} from "./store/conversationsStore";
import { NavBtn, Tag, Win } from "./ui/kit";

type View = "conversation" | "agents";

export default function App() {
  useGlobalSessionEvents();
  const [view, setView] = useState<View>("conversation");
  const conversations = useConversations();
  const activeId = useActiveConversationId();
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const activeRepo = useConversationRepo(activeId);
  const booted = useRef(false);

  // On first mount: resume persisted conversations (--resume with their sessionId),
  // or spawn a fresh one if there are none.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const st = useConversationsStore.getState();
    if (st.conversations.length > 0) {
      // Restart: re-spawn all persisted conversations and rebuild their history
      // from Claude's transcript (claude --resume does not re-stream past messages).
      void resumeAllConversations();
    } else {
      // First launch (or wiped data): start a fresh session.
      void createConversationInRepo(st.repos[0]?.path ?? ".");
    }
  }, []);

  return (
    <Win
      title={view === "agents" ? "Conductor — agents" : active?.name ?? "Conductor"}
      nav={
        <>
          <NavBtn icon="chat" label="Conversation" on={view === "conversation"} onClick={() => setView("conversation")} />
          <NavBtn icon="grid" label="Agents" on={view === "agents"} onClick={() => setView("agents")} />
        </>
      }
      right={
        view === "conversation" && activeRepo ? (
          <Tag icon="folder" title={activeRepo.path}>
            {repoName(activeRepo.path)}
          </Tag>
        ) : undefined
      }
    >
      {view === "conversation" ? (
        activeId ? (
          <ConductorConversation key={activeId} session={activeId} />
        ) : (
          <div style={{ margin: "auto", color: "var(--wf-tx-lo)", fontSize: 13 }}>Démarrage de la session…</div>
        )
      ) : (
        <FleetPlaceholder />
      )}
    </Win>
  );
}
