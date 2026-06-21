// Global "update available" indicator. Appears at the top of the app whenever a
// newer signed version has been detected (launch / 2h auto-check / manual check).
// Clicking it opens Settings on the "Mise à jour" section — where the user can
// read the notes and install. Stays until the app is updated.
import { useUpdater } from "../../store/updater";
import { useSettingsUi } from "../../store/settingsUi";
import { Ico } from "../../ui/kit";
import styles from "./UpdateBanner.module.css";

export function UpdateBanner() {
  const status = useUpdater((s) => s.status);
  const update = useUpdater((s) => s.update);
  const openSettings = useSettingsUi((s) => s.openSettings);

  const visible =
    !!update && (status === "available" || status === "downloading" || status === "installing");
  if (!visible || !update) return null;

  const label =
    status === "installing"
      ? "Installation de la mise à jour…"
      : status === "downloading"
        ? "Téléchargement de la mise à jour…"
        : `Mise à jour disponible — v${update.version}`;

  return (
    <button
      type="button"
      className={styles.banner}
      onClick={() => openSettings("updates")}
      title="Ouvrir les réglages de mise à jour"
    >
      <Ico name="spark" className="sm" />
      <span className={styles.label}>{label}</span>
      {status === "available" ? <span className={styles.cta}>Installer →</span> : null}
    </button>
  );
}
