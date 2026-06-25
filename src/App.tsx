import { useEffect, useRef, useState } from "react";
import { ConductorConversation } from "./features/conversation/ConductorConversation";
import { OpenInTerminalButton } from "./features/conversation/OpenInTerminalButton";
import { TerminalToggle } from "./features/conversation/TerminalToggle";
import { StreamControl } from "./features/conversation/StreamControl";
import { WorktreeIndicator } from "./features/git/WorktreeIndicator";
import { WorktreeManager } from "./features/git/WorktreeManager";
import { EditorToggle } from "./features/editor/EditorToggle";
import { FlightDeck } from "./features/flightdeck/FlightDeck";
import { ExtensionsManager } from "./features/extensions/ExtensionsManager";
import { UpdateBanner } from "./features/settings/UpdateBanner";
import { AppErrorBanner } from "./ui/AppErrorBanner";
import { useGlobalSessionEvents } from "./ipc/useGlobalSessionEvents";
import { startUpdaterAutoCheck } from "./store/updater";
import { initNotifications } from "./notifications/notify";
import { primeAudioUnlock } from "./notifications/sound";
import {
  bootConversations,
  repoName,
  useActiveConversationId,
  useConversationRepo,
  useConversations,
  useConversationsStore,
} from "./store/conversationsStore";
import { NavBtn, Tag, Win } from "./ui/kit";
import { viewForShortcut, type View } from "./ui/shortcuts";

export default function App() {
  useGlobalSessionEvents();
  const [view, setView] = useState<View>("conversation");
  const conversations = useConversations();
  const activeId = useActiveConversationId();
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const activeRepo = useConversationRepo(activeId);
  const booted = useRef(false);

  // Focusing an agent from the FlightDeck = select it and switch to its thread.
  const openConversation = (id: string) => {
    useConversationsStore.getState().selectConversation(id);
    setView("conversation");
  };

  // On first mount: hydrate from the core's persisted state. Lazy policy — boot
  // spawns nothing; a conversation's history loads when it's shown and its
  // process starts on the first message. An empty store stays empty.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void bootConversations();
    // Check for app updates now and every 2h while open (idempotent).
    startUpdaterAutoCheck();
    // Prime OS notification permission so the first agent notification doesn't
    // race a permission prompt, and unlock audio on the first user gesture so a
    // background chime isn't blocked by the webview's autoplay policy.
    void initNotifications();
    primeAudioUnlock();
  }, []);

  // ⌘/Ctrl+1 → Conversation, ⌘/Ctrl+2 → Flight Deck. Works from anywhere (even the
  // composer): ⌘+digit never types a character, so it won't clash with editing. The
  // physical-key / modifier logic lives in `viewForShortcut` (pure + unit-tested).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = viewForShortcut(e);
      if (!target) return;
      e.preventDefault();
      setView(target);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Win
      title={view === "flightdeck" ? "Flight Deck" : active?.name ?? "Conductor"}
      banner={<><UpdateBanner /><AppErrorBanner /></>}
      nav={
        <>
          <NavBtn
            icon="chat"
            label="Conversation"
            on={view === "conversation"}
            title="Conversation (⌘1)"
            onClick={() => setView("conversation")}
          />
          <NavBtn
            icon="grid"
            label="Flight Deck"
            on={view === "flightdeck"}
            title="Flight Deck (⌘2)"
            onClick={() => setView("flightdeck")}
          />
        </>
      }
      right={
        view === "conversation" && activeRepo ? (
          <>
            {active ? <WorktreeIndicator conv={active} repoPath={activeRepo.path} /> : null}
            {active ? <StreamControl key={active.id} conv={active} /> : null}
            {active ? <EditorToggle /> : null}
            {active ? <TerminalToggle /> : null}
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
        <FlightDeck onOpen={openConversation} />
      )}
      {/* Mounted once, globally: opens for whichever repo the indicator/badge asks. */}
      <WorktreeManager />
      {/* Idem: the extensions manager, opened per repo (sidebar) or per conversation (composer). */}
      <ExtensionsManager />
    </Win>
  );
}
