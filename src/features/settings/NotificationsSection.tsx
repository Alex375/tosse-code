// "Notifications" section of the Settings panel. Three independently-toggleable
// channels fired when an agent finishes a turn or needs attention. Prefs live in
// the notifications store; the actual dispatch is in src/notifications/.
import { useNotifications } from "../../store/notifications";
import { testSound } from "../../notifications/notify";
import { PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function NotificationsSection() {
  const systemNotification = useNotifications((s) => s.systemNotification);
  const sound = useNotifications((s) => s.sound);
  const dockBounce = useNotifications((s) => s.dockBounce);
  const set = useNotifications((s) => s.set);

  return (
    <div>
      <PageHead
        title="Notifications"
        subtitle="Quand un agent termine son tour ou a besoin de ton attention (permission, question). Rien ne se déclenche si tu regardes déjà la conversation concernée."
      />

      <SettingsGroup title="Canaux" icon="bell">
        <ToggleRow
          title="Notification système"
          hint="Une bannière macOS dans le Centre de notifications."
          checked={systemNotification}
          onChange={(v) => set({ systemNotification: v })}
        />
        <ToggleRow
          title="Son"
          hint="Un petit carillon."
          checked={sound}
          onChange={(v) => set({ sound: v })}
          action={
            <button
              type="button"
              className={`${styles.btn} ${styles.ghost}`}
              onClick={() => testSound("done")}
            >
              Tester
            </button>
          }
        />
        <ToggleRow
          title="Rebond du Dock"
          hint="L'icône de Flight Deck rebondit dans le Dock."
          checked={dockBounce}
          onChange={(v) => set({ dockBounce: v })}
        />
      </SettingsGroup>
    </div>
  );
}
