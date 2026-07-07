// Settings modal — a left-rail tabbed panel (built to scale as more settings
// land). Sections: Général (about), Notifications, Mises à jour, Données (the
// destructive "drop all", kept while the SQL model is still in flux). The active
// section is shared state so deep-links (e.g. the update banner) can open it
// straight onto a given tab.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { wipeAllData } from "../../store/conversationsStore";
import { useSettingsUi, type SettingsSection } from "../../store/settingsUi";
import { useDisplay } from "../../store/display";
import { Ico } from "../../ui/kit";
import { TosseMark } from "../../ui/TosseMark";
import { UpdateSection } from "./UpdateSection";
import { NotificationsSection } from "./NotificationsSection";
import { ConversationSection } from "./ConversationSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

const TABS: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: "general", label: "Général", icon: "cog" },
  { id: "conversation", label: "Conversation", icon: "chat" },
  { id: "shortcuts", label: "Raccourcis", icon: "key" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "updates", label: "Mises à jour", icon: "refresh" },
  { id: "data", label: "Données", icon: "trash" },
];

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const section = useSettingsUi((s) => s.section);
  const setSection = useSettingsUi((s) => s.setSection);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // App version, read from the bundle (tauri.conf.json — the runtime source of
  // truth, kept in sync by `pnpm bump`). Null outside the Tauri webview (e.g. a
  // plain browser dev server), in which case we just hide the chip.
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, [open]);

  // Close on Escape, but never mid-wipe. The app-wide capture guard (App.tsx) always
  // preventDefaults Escape, so gating on `defaultPrevented` here would mean the panel
  // NEVER closes — that signal is now the guard's, not a "higher layer consumed it"
  // marker. One-Escape-one-layer is upheld instead by any ConfirmDialog mounted inside
  // calling stopPropagation, so its Escape never reaches this window-level handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  if (!open) return null;

  async function dropAll() {
    setBusy(true);
    try {
      await wipeAllData();
      onClose();
    } catch (e) {
      console.error("wipeAllData failed:", e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  function close() {
    if (busy) return;
    setConfirming(false);
    onClose();
  }

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <span className={styles.headIcon}>
            <Ico name="cog" className="sm" />
          </span>
          <span className={styles.title}>Réglages</span>
          <button className={styles.close} onClick={close} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>

        <div className={styles.layout}>
          <nav className={styles.rail} aria-label="Sections des réglages">
            <div className={styles.railCap}>Réglages</div>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.railItem}
                data-on={section === t.id ? "" : undefined}
                onClick={() => setSection(t.id)}
              >
                <Ico name={t.icon} className="sm" />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {section === "general" && (
              <div>
                <PageHead title="Général" subtitle="Apparence, flotte et alertes de l'application." />

                <div className={styles.about}>
                  <span className={styles.aboutMark}>
                    <TosseMark />
                  </span>
                  <div>
                    <div className={styles.appName}>Flight Deck</div>
                    <div className={styles.appTag}>
                      Application de bureau pour piloter Claude Code.
                    </div>
                  </div>
                  {version && <span className={styles.version}>v{version}</span>}
                </div>

                <DisplayPrefs />
                <FleetBannerPrefs />
              </div>
            )}

            {section === "conversation" && <ConversationSection />}

            {section === "shortcuts" && <ShortcutsSection />}

            {section === "notifications" && <NotificationsSection />}

            {section === "updates" && <UpdateSection />}

            {section === "data" && (
              <div>
                <PageHead
                  title="Données"
                  subtitle="Gestion des données locales de l'application."
                />
                <div className={styles.desc}>
                  Supprime toutes les conversations et tous les dépôts enregistrés, et vide la base
                  locale. Les transcripts de Claude sur le disque ne sont pas touchés. Action
                  irréversible.
                </div>

                {confirming ? (
                  <div className={styles.row}>
                    <button
                      className={`${styles.btn} ${styles.danger}`}
                      onClick={() => void dropAll()}
                      disabled={busy}
                    >
                      {busy ? "Suppression…" : "Confirmer la suppression"}
                    </button>
                    <button
                      className={`${styles.btn} ${styles.ghost}`}
                      onClick={() => setConfirming(false)}
                      disabled={busy}
                    >
                      Annuler
                    </button>
                  </div>
                ) : (
                  <button
                    className={`${styles.btn} ${styles.danger}`}
                    onClick={() => setConfirming(true)}
                  >
                    Tout supprimer…
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Display prefs in the Général tab. Today: the GLOBAL DEFAULT for "clean output" — fold
 *  each round's work behind a "Travail de Claude" block so only the final message stays in
 *  clear. This is the default applied to conversations that haven't set their own choice;
 *  each conversation's composer chip can override it (per-conversation, persisted). */
function DisplayPrefs() {
  const cleanOutput = useDisplay((s) => s.cleanOutput);
  const showTaskNotifications = useDisplay((s) => s.showTaskNotifications);
  const showLastMessagePreview = useDisplay((s) => s.showLastMessagePreview);
  const messageControls = useDisplay((s) => s.messageControls);
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Affichage" icon="list">
      <ToggleRow
        title="Clean output (par défaut)"
        hint={
          <>
            N'affiche que le message final de chaque réponse ; les outils, la réflexion et les
            étapes intermédiaires sont repliés derrière un bloc « Travail de Claude », dépliable à
            la demande. Réglage <strong>par défaut</strong> : chaque conversation peut le surcharger
            via son bouton « Clean output ».
          </>
        }
        checked={cleanOutput}
        onChange={(v) => set({ cleanOutput: v })}
        label="Clean output par défaut"
      />
      <ToggleRow
        title="Notifications de tâche de fond"
        hint={
          <>
            Affiche les messages <code>&lt;task-notification&gt;</code> (injectés par le CLI quand
            une tâche de fond ou un sous-agent se termine) dans le fil. <strong>Désactivé par
            défaut</strong> : ils encombrent la conversation, surtout au rechargement ou à l'import
            depuis l'historique.
          </>
        }
        checked={showTaskNotifications}
        onChange={(v) => set({ showTaskNotifications: v })}
        label="Afficher les notifications de tâche de fond"
      />
      <ToggleRow
        title="Aperçu du dernier message envoyé"
        hint={
          <>
            Épingle en haut de la conversation un aperçu <strong>flottant</strong> du dernier
            message que tu as envoyé (le message en clair s'il est court, sinon un court résumé) —
            le même que sur le Flight Deck. Un clic dessus <strong>fait défiler</strong> jusqu'au
            message. <strong>Activé par défaut.</strong>
          </>
        }
        checked={showLastMessagePreview}
        onChange={(v) => set({ showLastMessagePreview: v })}
        label="Aperçu du dernier message envoyé"
      />
      <ToggleRow
        title="Contrôles sur les messages"
        hint={
          <>
            Affiche les contrôles au survol des messages (les tiens et ceux de Claude) :
            <strong> « reprendre ici »</strong> (rembobine la conversation à ce point) et
            <strong> « forker »</strong> (branche une nouvelle conversation à ce point).{" "}
            <strong>Activé par défaut.</strong>
          </>
        }
        checked={messageControls}
        onChange={(v) => set({ messageControls: v })}
        label="Afficher les contrôles sur les messages"
      />
    </SettingsGroup>
  );
}

/** The two independent toggles for the "Fleet readout" banner — the adaptive stage
 *  counts ("N Running · N Review · …") across the whole fleet. One controls the wide
 *  bar at the top of the FlightDeck, the other the compact box at the bottom of the
 *  conversation sidebar; they're deliberately separate so either surface can be hidden
 *  on its own. Both on by default (see store/display DEFAULTS). */
function FleetBannerPrefs() {
  const flightDeck = useDisplay((s) => s.fleetBannerFlightDeck);
  const conversation = useDisplay((s) => s.fleetBannerConversation);
  const set = useDisplay((s) => s.set);
  return (
    <SettingsGroup title="Bandeau de flotte" icon="grid">
      <ToggleRow
        title="Afficher dans le Flight Deck"
        hint="Le résumé de la flotte (Running · Review · Need Attention · Idle) en haut du Flight Deck."
        checked={flightDeck}
        onChange={(v) => set({ fleetBannerFlightDeck: v })}
        label="Bandeau de flotte dans le Flight Deck"
      />
      <ToggleRow
        title="Afficher dans la Conversation"
        hint="Le même résumé, en version compacte, en bas de la barre latérale des conversations."
        checked={conversation}
        onChange={(v) => set({ fleetBannerConversation: v })}
        label="Bandeau de flotte dans la Conversation"
      />
    </SettingsGroup>
  );
}
