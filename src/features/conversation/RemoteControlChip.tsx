import { openUrl } from "@tauri-apps/plugin-opener";
import { ChipBtn, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useSetRemoteControl } from "../../ipc/useCommands";
import { statusOf, useRemoteControl } from "../../store/remoteControl";
import { useAppErrors } from "../../store/appErrors";
import type { BackendKind } from "../../store/conversationsStore";

/** Copy a value to the clipboard, surfacing a failure (clipboard blocked / unavailable)
 *  instead of the silent no-op an `?.` + `void` would give — same pattern as the file tree. */
async function copyText(value: string, whatFailed: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (err) {
    useAppErrors.getState().pushError(whatFailed, String(err));
  }
}

/**
 * Composer chip for native Remote Control — bridges THIS conversation to a phone/web so it
 * can be viewed and driven from another device. Backend-aware:
 *
 *  - **Claude** (`/remote-control`): bridges onto claude.ai/code + the Claude mobile app and
 *    hands back a session URL. Messages from the phone/web arrive inline on the normal stream.
 *    The active menu offers open-in-browser · copy-link · disable.
 *  - **Codex** (`remoteControl/enable`): brings up the OpenAI relay bridge and returns a
 *    device-PAIRING CODE (no URL). The active menu shows that code (to enter in the Codex
 *    mobile app) · copy-code · disable.
 *
 * Icon-only (globe) with a status dot: green = connected/active, red = error, pulsing =
 * connecting. Inactive states render a DIRECT toggle (one click enables — lazily spawning
 * the session if needed, since the bridge rides the live process).
 */
export function RemoteControlChip({
  session,
  backend,
  worktreeOnSpawn,
}: {
  session: string;
  /** Which backend's remote-control wire to drive (its state shape is shared, but the
   *  active-menu UX differs: Claude shows a URL, Codex shows a pairing code). */
  backend: BackendKind;
  /** Pending "start in a fresh worktree" choice (only meaningful before the session
   *  spawns) — forwarded so enabling remote control on a brand-new conversation still
   *  honors it instead of silently spawning in the main checkout. */
  worktreeOnSpawn?: boolean;
}) {
  const rc = useRemoteControl(session);
  const status = statusOf(rc);
  const remote = useSetRemoteControl(session);
  const connecting = status === "connecting" || remote.isPending;
  const isCodex = backend === "codex";
  const url = rc?.session_url ?? null;
  const pairingCode = rc?.pairing_code ?? null;

  // The active (menu) state tracks the BRIDGE being up — NOT the presence of a pairing code.
  // (If enable succeeds but pairing/start fails, the bridge is live server-side with no code;
  // gating on the code alone would render the chip as OFF and strand a live bridge with no way
  // to disable it.) Claude: connected. Codex: connecting or connected — the menu then shows the
  // code, or "indisponible" + the error, and always keeps the Désactiver action reachable.
  const active = isCodex ? status === "connected" || status === "connecting" : status === "connected";

  if (active) {
    const dotCls = status === "error" ? "err" : status === "connecting" ? "wait pulse" : "run";
    return (
      <Menu
        up
        align="right"
        trigger={
          <ChipBtn
            icon="globe"
            className="cv-rc-chip"
            data-rc={status === "connected" ? "connected" : "active"}
            aria-label="Remote control actif"
            title={
              isCodex
                ? "Remote control Codex actif — appaire un appareil avec le code, puis pilote cette session depuis l'app Codex"
                : "Remote control actif — cette session est pilotable depuis claude.ai/code et l'app Claude"
            }
          >
            <span className={`wf-dot ${dotCls}`} aria-hidden />
          </ChipBtn>
        }
      >
        {isCodex ? (
          <>
            <MenuLabel>Remote control Codex · {status === "connected" ? "actif" : "connexion…"}</MenuLabel>
            <MenuLabel>Code d'appairage : {pairingCode ?? "indisponible"}</MenuLabel>
            <MenuItem
              icon="copy"
              disabled={!pairingCode}
              onClick={pairingCode ? () => void copyText(pairingCode, "Copie du code d'appairage impossible.") : undefined}
            >
              Copier le code
            </MenuItem>
            <MenuItem icon="stop" onClick={() => remote.mutate({ enabled: false })}>
              Désactiver
            </MenuItem>
          </>
        ) : (
          <>
            <MenuLabel>Remote control · actif</MenuLabel>
            <MenuItem icon="external" disabled={!url} onClick={url ? () => void openUrl(url) : undefined}>
              Ouvrir dans le navigateur
            </MenuItem>
            <MenuItem
              icon="copy"
              disabled={!url}
              onClick={url ? () => void copyText(url, "Copie du lien remote control impossible.") : undefined}
            >
              Copier le lien
            </MenuItem>
            <MenuItem icon="stop" onClick={() => remote.mutate({ enabled: false })}>
              Désactiver
            </MenuItem>
          </>
        )}
      </Menu>
    );
  }

  const isError = status === "error";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={false}
      className="wf-chip cv-rc-chip"
      disabled={connecting}
      onClick={() => remote.mutate({ enabled: true, worktree: worktreeOnSpawn })}
      aria-label="Remote control"
      title={
        isError && rc?.error
          ? `Remote control échoué : ${rc.error} — cliquer pour réessayer`
          : isCodex
            ? "Remote control — piloter/suivre cette conversation depuis l'app mobile Codex (appairage par code)"
            : "Remote control — piloter/suivre cette conversation depuis claude.ai/code ou l'app mobile Claude"
      }
    >
      <Ico name="globe" className="sm" />
      {connecting ? <span className="wf-dot wait pulse" aria-hidden /> : null}
      {isError ? <span className="wf-dot err" aria-hidden /> : null}
    </button>
  );
}
