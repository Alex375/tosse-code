// "Mise à jour" section of the Settings panel: current vs available version,
// release notes (rendered as Markdown), a manual check button, download progress,
// and the "install + restart" action — gated behind a relaunch confirmation so a
// running conversation is never killed by surprise. All state lives in the updater
// store; the in-app notes are the changelog part of the release body (the GitHub-only
// install instructions are stripped, see `inAppReleaseNotes`).
import { useState } from "react";
import { useUpdater, inAppReleaseNotes } from "../../store/updater";
import { useConversationsStore } from "../../store/conversationsStore";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Ico } from "../../ui/kit";
import { PageHead } from "./SettingsKit";
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
  const lastCheckError = useUpdater((s) => s.lastCheckError);
  const check = useUpdater((s) => s.check);
  const install = useUpdater((s) => s.install);
  // How many Claude sessions are live (a running `claude` process). Relaunching to
  // install interrupts every one of them — the confirm dialog warns about this.
  const liveSessions = useConversationsStore(
    (s) => s.conversations.filter((c) => c.handle !== null).length,
  );

  const [confirmingInstall, setConfirmingInstall] = useState(false);

  const checking = status === "checking";
  const downloading = status === "downloading" || status === "installing";
  const hasUpdate = !!update && (status === "available" || downloading);
  const notes = inAppReleaseNotes(update?.notes);

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div>
      <PageHead title="Mises à jour" subtitle="Version installée, nouveautés et installation." />

      {hasUpdate && update ? (
        <>
          {/* Inviting header: the update motif + a clear current → new version jump. */}
          <div className={styles.updateHero}>
            <span className={styles.updateSpark}>
              <Ico name="spark" />
            </span>
            <div className={styles.updateHeroText}>
              <div className={styles.updateHeadline}>Nouvelle version disponible</div>
              <div className={styles.versionJump}>
                <span className={styles.versionOld}>v{update.currentVersion}</span>
                <Ico name="arrow" className="sm" />
                <span className={styles.versionNew}>v{update.version}</span>
              </div>
            </div>
          </div>

          {notes ? (
            <div className={styles.notesCard}>
              <div className={styles.notesTitle}>Nouveautés</div>
              <div className={styles.notesBody}>
                <StreamMarkdown text={notes} />
              </div>
            </div>
          ) : (
            <div className={styles.desc}>Améliorations et corrections diverses.</div>
          )}

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
              className={`${styles.btn} ${styles.primary} ${styles.btnUpdate}`}
              onClick={() => setConfirmingInstall(true)}
              disabled={downloading}
            >
              <Ico name="refresh" className="sm" />
              {status === "installing"
                ? "Redémarrage…"
                : status === "downloading"
                  ? "Téléchargement…"
                  : error
                    ? "Réessayer l'installation"
                    : "Mettre à jour et redémarrer"}
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
          {status !== "error" && lastCheckError ? (
            <div className={styles.hintWarn}>
              Dernière vérification automatique échouée : {lastCheckError}
            </div>
          ) : null}
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

      {error ? <div className={styles.errorMsg}>{error}</div> : null}

      {/* Relaunch confirmation — ALWAYS shown before installing, because installing
          relaunches the app and drops every live session. Reinforced (danger + count
          + "Attendre") when conversations are actually running. */}
      <ConfirmDialog
        open={confirmingInstall}
        danger={liveSessions > 0}
        title="Mettre à jour Tosse Code ?"
        confirmLabel={liveSessions > 0 ? "Mettre à jour maintenant" : "Mettre à jour et redémarrer"}
        cancelLabel={liveSessions > 0 ? "Attendre" : "Annuler"}
        onCancel={() => setConfirmingInstall(false)}
        onConfirm={() => {
          setConfirmingInstall(false);
          void install();
        }}
      >
        L'application va <strong>redémarrer</strong> pour installer
        {update ? ` la version ${update.version}` : " la mise à jour"}.
        {liveSessions > 0 ? (
          <>
            {" "}
            <strong>
              {liveSessions} conversation{liveSessions > 1 ? "s" : ""} en cours
            </strong>{" "}
            {liveSessions > 1 ? "seront interrompues" : "sera interrompue"} — le travail non
            terminé peut être perdu. Vous pouvez <strong>attendre</strong> qu'{liveSessions > 1
              ? "elles se terminent"
              : "elle se termine"}{" "}
            avant de mettre à jour.
          </>
        ) : (
          " Aucune conversation n'est en cours."
        )}
      </ConfirmDialog>
    </div>
  );
}
