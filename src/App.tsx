import { useEffect, useRef, useState } from "react";
import { ConductorConversation } from "./features/conversation/ConductorConversation";
import { OpenInTerminalButton } from "./features/conversation/OpenInTerminalButton";
import { StreamControl } from "./features/conversation/StreamControl";
import { WorktreeIndicator } from "./features/git/WorktreeIndicator";
import { WorktreeManager } from "./features/git/WorktreeManager";
import { FleetPlaceholder } from "./features/fleet/FleetPlaceholder";
import { UpdateBanner } from "./features/settings/UpdateBanner";
import { useGlobalSessionEvents } from "./ipc/useGlobalSessionEvents";
import { startUpdaterAutoCheck } from "./store/updater";
import {
  bootConversations,
  repoName,
  useActiveConversationId,
  useConversationRepo,
  useConversations,
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

  // On first mount: hydrate from the core's persisted state. Lazy policy — boot
  // spawns nothing; a conversation's history loads when it's shown and its
  // process starts on the first message. An empty store stays empty.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void bootConversations();
    // Check for app updates now and every 2h while open (idempotent).
    startUpdaterAutoCheck();
  }, []);

  return (
    <Win
      title={view === "agents" ? "Conductor — agents" : active?.name ?? "Conductor"}
      banner={<UpdateBanner />}
      nav={
        <>
          <NavBtn icon="chat" label="Conversation" on={view === "conversation"} onClick={() => setView("conversation")} />
          <NavBtn icon="grid" label="Agents" on={view === "agents"} onClick={() => setView("agents")} />
        </>
      }
      right={
        view === "conversation" && activeRepo ? (
          <>
            {active ? <WorktreeIndicator conv={active} repoPath={activeRepo.path} /> : null}
            {active ? <StreamControl key={active.id} conv={active} /> : null}
            {active ? <OpenInTerminalButton sessionId={active.sessionId} cwd={active.cwd} /> : null}
            <Tag icon="folder" title={activeRepo.path}>
              {repoName(activeRepo.path)}
            </Tag>
          </>
        ) : undefined
      }
    >
      {view === "conversation" ? (
        <ConductorConversation active={active} />
      ) : (
        <FleetPlaceholder />
      )}
      {/* Mounted once, globally: opens for whichever repo the indicator/badge asks. */}
      <WorktreeManager />
    </Win>
  );
}
