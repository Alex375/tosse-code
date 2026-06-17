// Settings modal. Phase-1 scope: a "Données" section with the destructive
// "drop all" action (clears the core's SQLite db + in-memory state). The SQL
// model is still in flux during development, so a one-click wipe is intentional.
import { useState } from "react";
import { wipeAllData } from "../../store/conversationsStore";
import { Ico } from "../../ui/kit";
import styles from "./SettingsPanel.module.css";

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

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
          <Ico name="cog" className="sm" />
          <span className={styles.title}>Réglages</span>
          <button className={styles.close} onClick={close} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>Données</div>
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
      </div>
    </div>
  );
}
