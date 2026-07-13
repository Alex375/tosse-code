import { Ico } from "../../ui/kit";
import { useNotifications } from "../../store/notifications";

/**
 * Always-visible title-bar toggle for the notification sound — the one channel
 * the user reaches for most (mute the chime on the spot, without diving into
 * Settings). Mirrors EditorToggle/TerminalToggle/GitToggle (`wf-icon-btn`, goes
 * `.on` when the sound is enabled) and drives the SAME persisted pref as the
 * Settings → Notifications switch, so both stay in sync. Its ⌘⇧M shortcut lives
 * in App.tsx (see `isSoundToggleChord`).
 */
export function SoundToggle() {
  const sound = useNotifications((s) => s.sound);
  const toggleSound = useNotifications((s) => s.toggleSound);

  return (
    <button
      type="button"
      className={"wf-icon-btn" + (sound ? " on" : "")}
      data-on={sound ? "" : undefined}
      onClick={toggleSound}
      title={
        sound
          ? "Notification sound on — mute (⌘⇧M)"
          : "Notification sound off — turn on (⌘⇧M)"
      }
      aria-label="Toggle notification sound"
      aria-pressed={sound}
    >
      <Ico name={sound ? "volume" : "mute"} className="sm" />
    </button>
  );
}
