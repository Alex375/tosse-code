// The "Raccourcis" settings tab: a read-only recap of every keyboard shortcut the
// app answers to. It renders the shared SHORTCUT_GROUPS catalogue (src/ui/shortcuts.ts)
// — the SAME source the global handler dispatches from for the new chords — so what's
// documented here can never drift from what's wired.
import { SHORTCUT_GROUPS } from "../../ui/shortcuts";
import styles from "./SettingsPanel.module.css";

/** Split a display chord ("⌘⌥ ↑ / ⌘⌥ ↓") into the tokens we render as separate keycaps.
 *  We split on spaces; " / " stays as a literal separator token so alternatives read
 *  naturally (e.g. prev / next). */
function keycaps(keys: string): string[] {
  return keys.split(" ").filter((t) => t.length > 0);
}

export function ShortcutsSection() {
  return (
    <div>
      <div className={styles.section}>Raccourcis clavier</div>
      <div className={styles.desc}>
        Les raccourcis disponibles dans l'application. Sur macOS, ⌘ est la touche Commande ; sous
        Windows/Linux, utilisez Ctrl à la place.
      </div>

      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className={styles.scGroup}>
          <div className={styles.scGroupTitle}>{group.title}</div>
          <div className={styles.scList}>
            {group.items.map((item, i) => (
              <div key={`${item.keys}-${i}`} className={styles.scRow}>
                <span className={styles.scLabel}>{item.label}</span>
                <span className={styles.scKeys}>
                  {keycaps(item.keys).map((tok, j) =>
                    tok === "/" ? (
                      <span key={j} className={styles.scSep}>
                        /
                      </span>
                    ) : (
                      <kbd key={j} className={styles.kbd}>
                        {tok}
                      </kbd>
                    ),
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
