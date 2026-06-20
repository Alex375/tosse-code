// "Mise à jour" section of the Settings panel: current vs available version,
// release notes, a manual check button, download progress, and the one-click
// "install + restart" action. All state lives in the updater store.
import { useUpdater } from "../../store/updater";
import styles from "./SettingsPanel.module.css";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function UpdateSection() {
  const status = useUpdater((s) => s.status);
  const update = useUpdater((s) => s.update);
  const progress = useUpdater((s) => s.progress);
  const error = useUpdater((s) => s.error);
  const check = useUpdater((s) => s.check);
  const install = useUpdater((s) => s.install);

  const checking = status === "checking";
  const downloading = status === "downloading" || status === "installing";
  const hasUpdate = !!update && (status === "available" || downloading);

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div id="updates">
      <div className={styles.section}>Mise à jour</div>

      {hasUpdate && update ? (
        <>
          <div className={styles.desc}>
            <strong>Version {update.version} disponible</strong> — actuelle&nbsp;:{" "}
            {update.currentVersion}.
          </div>
          {update.notes ? <pre className={styles.notes}>{update.notes.trim()}</pre> : null}

          {downloading && progress ? (
            <div className={styles.progressWrap}>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: pct != null ? `${pct}%` : "100%" }}
                />
              </div>
              <div className={styles.progressLabel}>
                {status === "installing"
                  ? "Installation, redémarrage imminent…"
                  : progress.total
                    ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}${
                        pct != null ? ` (${pct}%)` : ""
                      }`
                    : `${formatBytes(progress.downloaded)}…`}
              </div>
            </div>
          ) : null}

          <div className={styles.row}>
            <button
              className={`${styles.btn} ${styles.primary}`}
              onClick={() => void install()}
              disabled={downloading}
            >
              {status === "installing"
                ? "Redémarrage…"
                : status === "downloading"
                  ? "Téléchargement…"
                  : "Installer et redémarrer"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.desc}>
            {status === "uptodate"
              ? "L'application est à jour."
              : status === "error"
                ? "La dernière vérification a échoué."
                : "Vérifie si une nouvelle version signée est disponible."}
          </div>
          <div className={styles.row}>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              onClick={() => void check()}
              disabled={checking}
            >
              {checking ? "Recherche…" : "Vérifier les mises à jour"}
            </button>
          </div>
        </>
      )}

      {status === "error" && error ? <div className={styles.errorMsg}>{error}</div> : null}
    </div>
  );
}
