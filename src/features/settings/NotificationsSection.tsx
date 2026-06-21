// "Notifications" section of the Settings panel. Three independently-toggleable
// channels fired when an agent finishes a turn or needs attention. Prefs live in
// the notifications store; the actual dispatch is in src/notifications/.
import type { ReactNode } from "react";
import { useNotifications } from "../../store/notifications";
import { testSound } from "../../notifications/notify";
import { Toggle } from "../../ui/Toggle";
import styles from "./SettingsPanel.module.css";

export function NotificationsSection() {
  const systemNotification = useNotifications((s) => s.systemNotification);
  const sound = useNotifications((s) => s.sound);
  const dockBounce = useNotifications((s) => s.dockBounce);
  const set = useNotifications((s) => s.set);

  return (
    <div>
      <div className={styles.section}>Notifications</div>
      <div className={styles.desc}>
        Quand un agent termine son tour ou a besoin de ton attention (permission, question).
        Rien ne se déclenche si tu regardes déjà la conversation concernée.
      </div>

      <div className={styles.toggleList}>
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
          hint="L'icône de Tosse Code rebondit dans le Dock."
          checked={dockBounce}
          onChange={(v) => set({ dockBounce: v })}
        />
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  hint,
  checked,
  onChange,
  action,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  action?: ReactNode;
}) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        <div className={styles.toggleTitle}>{title}</div>
        <div className={styles.toggleHint}>{hint}</div>
      </div>
      {action}
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}
