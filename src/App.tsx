import { useEffect, useRef, useState } from "react";
import { ConductorConversation } from "./features/conversation/ConductorConversation";
import { OpenInTerminalButton } from "./features/conversation/OpenInTerminalButton";
import { TerminalToggle } from "./features/conversation/TerminalToggle";
import { StreamControl } from "./features/conversation/StreamControl";
import { WorktreeIndicator } from "./features/git/WorktreeIndicator";
import { WorktreeManager } from "./features/git/WorktreeManager";
import { GitToggle } from "./features/git/GitToggle";
import { EditorToggle } from "./features/editor/EditorToggle";
import { FlightDeck } from "./features/flightdeck/FlightDeck";
import { FlightDeckReplyModal } from "./features/flightdeck/FlightDeckReplyModal";
import { useFlightdeckModal } from "./features/flightdeck/flightdeckModalStore";
import { SoundToggle } from "./features/notifications/SoundToggle";
import { ExtensionsManager } from "./features/extensions/ExtensionsManager";
import { HistoryPanel } from "./features/history/HistoryPanel";
import { UltraCodeBlast } from "./features/conversation/UltraCodeBlast";
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
import { useNotifications } from "./store/notifications";
import { useSettingsUi } from "./store/settingsUi";
import { NavBtn, Tag, Win } from "./ui/kit";
import {
  isEditableTarget,
  isSettingsChord,
  isSoundToggleChord,
  isUndoChord,
  viewForShortcut,
  type View,
} from "./ui/shortcuts";

export default function App() {
  useGlobalSessionEvents();
  const [view, setView] = useState<View>("conversation");
  const conversations = useConversations();
  const activeId = useActiveConversationId();
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const activeRepo = useConversationRepo(activeId);
  const booted = useRef(false);

  // Focusing an agent from the FlightDeck = select it and switch to its thread. Also
  // used to PROMOTE the reply modal to the full view (its "Plein écran" button).
  const openConversation = (id: string) => {
    useConversationsStore.getState().selectConversation(id);
    setView("conversation");
  };

  // The reply modal lives ONLY on the Flight Deck. Close it whenever we leave that
  // view — so promoting it (openConversation → view "conversation") and any ⌘1
  // switch both dismiss it, and the same conversation is never mounted twice (modal
  // + full view) at once.
  const closeReplyModal = useFlightdeckModal((s) => s.close);
  useEffect(() => {
    if (view !== "flightdeck") closeReplyModal();
  }, [view, closeReplyModal]);

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
  // ⌘/Ctrl+, opens Settings (the macOS-standard Preferences chord).
  // ⌘/Ctrl+Z restores the last conversation deleted via its × (the no-confirm delete's
  // undo) — but ONLY when focus isn't in a control with its own undo (composer, Monaco,
  // rename input, terminal), so we never steal their Z. All decisions are pure helpers.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = viewForShortcut(e);
      if (target) {
        e.preventDefault();
        setView(target);
        return;
      }
      // ⌘⇧M toggles the notification sound (mute/unmute the chime on the spot). A
      // distinct chord that never types a character, so it fires app-wide without
      // the editable-target guard — see `isSoundToggleChord`.
      if (isSoundToggleChord(e)) {
        e.preventDefault();
        useNotifications.getState().toggleSound();
        return;
      }
      // ⌘, opens the Settings panel — the macOS-standard Preferences shortcut. Like the
      // other chords it never types a character, so it fires app-wide without an
      // editable-target guard. Decision lives in the pure `isSettingsChord` helper.
      if (isSettingsChord(e)) {
        e.preventDefault();
        useSettingsUi.getState().openSettings();
        return;
      }
      if (isUndoChord(e) && !isEditableTarget(document.activeElement)) {
        // Only consume the key if something was actually restored, so an empty undo
        // stack leaves any other ⌘Z handling untouched.
        if (useConversationsStore.getState().undoRemoveConversation()) e.preventDefault();
      }
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
        <>
          {/* Always visible (both views): mute/unmute the notification chime on the
              spot, without opening Settings. Also bound to ⌘⇧M. */}
          <SoundToggle />
          {view === "conversation" && activeRepo ? (
            <>
              {active ? <WorktreeIndicator conv={active} repoPath={activeRepo.path} /> : null}
              {active ? <StreamControl key={active.id} conv={active} /> : null}
              {active ? <EditorToggle /> : null}
              {active ? <TerminalToggle /> : null}
              {active ? <GitToggle /> : null}
              {active ? (
                <OpenInTerminalButton sessionId={active.sessionId} cwd={active.cwd} />
              ) : null}
              <Tag icon="folder" title={activeRepo.path}>
                {repoName(activeRepo.path)}
              </Tag>
            </>
          ) : null}
        </>
      }
    >
      {view === "conversation" ? (
        <ConductorConversation active={active} />
      ) : (
        <FlightDeck onOpen={openConversation} />
      )}
      {/* Reply-in-place modal over the Flight Deck (store-driven, opened by a card's
          attention action). Gated on the view so it can't overlay the Conversation
          view or double-mount a conversation already shown there. */}
      {view === "flightdeck" ? <FlightDeckReplyModal onPromote={openConversation} /> : null}
      {/* Mounted once, globally: opens for whichever repo the indicator/badge asks. */}
      <WorktreeManager />
      {/* Idem: the extensions manager, opened per repo (sidebar) or per conversation (composer). */}
      <ExtensionsManager />
      {/* Idem: the conversation-history search panel, opened from the sidebar search bar. */}
      <HistoryPanel />
      {/* Mounted once, globally: the full-screen "Ultra code" activation blast. */}
      <UltraCodeBlast />
    </Win>
  );
}
