import { openUrl } from "@tauri-apps/plugin-opener";
import { ChipBtn, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useSetRemoteControl } from "../../ipc/useCommands";
import { statusOf, useRemoteControl } from "../../store/remoteControl";
import { useAppErrors } from "../../store/appErrors";

/** Copy the session URL, surfacing a failure (clipboard blocked / unavailable) instead
 *  of the silent no-op an `?.` + `void` would give — same pattern as the file tree. */
async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
  } catch (err) {
    useAppErrors.getState().pushError("Copie du lien remote control impossible.", String(err));
  }
}

/**
 * Composer chip for Claude Code's native Remote Control (`/remote-control`): it bridges
 * THIS conversation onto claude.ai/code + the Claude mobile app so it can be viewed and
 * driven from another device. Messages sent from the phone/web arrive inline on the
 * session's normal stream, so the thread stays in sync automatically — this chip only
 * toggles the bridge and surfaces the claude.ai/code link.
 *
 * Icon-only (globe) to keep the composer bar uncluttered, with a small status dot:
 * green (`.wf-dot run`) = connected, red = error, pulsing = connecting. Disconnected /
 * error / connecting render a DIRECT toggle (one click enables — lazily spawning the
 * session if needed, since the bridge rides the live process); once connected it becomes
 * a menu (open in browser · copy link · disable).
 */
export function RemoteControlChip({
  session,
  worktreeOnSpawn,
}: {
  session: string;
  /** Pending "start in a fresh worktree" choice (only meaningful before the session
   *  spawns) — forwarded so enabling remote control on a brand-new conversation still
   *  honors it instead of silently spawning in the main checkout. */
  worktreeOnSpawn?: boolean;
}) {
  const rc = useRemoteControl(session);
  const status = statusOf(rc);
  const remote = useSetRemoteControl(session);
  const connecting = status === "connecting" || remote.isPending;
  const url = rc?.session_url ?? null;

  if (status === "connected") {
    return (
      <Menu
        up
        align="right"
        trigger={
          <ChipBtn
            icon="globe"
            className="cv-rc-chip"
            data-rc="connected"
            aria-label="Remote control actif"
            title="Remote control actif — cette session est pilotable depuis claude.ai/code et l'app Claude"
          >
            <span className="wf-dot run" aria-hidden />
          </ChipBtn>
        }
      >
        <MenuLabel>Remote control · actif</MenuLabel>
        <MenuItem
          icon="external"
          disabled={!url}
          onClick={url ? () => void openUrl(url) : undefined}
        >
          Ouvrir dans le navigateur
        </MenuItem>
        <MenuItem
          icon="copy"
          disabled={!url}
          onClick={url ? () => void copyLink(url) : undefined}
        >
          Copier le lien
        </MenuItem>
        <MenuItem icon="stop" onClick={() => remote.mutate({ enabled: false })}>
          Désactiver
        </MenuItem>
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
          : "Remote control — piloter/suivre cette conversation depuis claude.ai/code ou l'app mobile Claude"
      }
    >
      <Ico name="globe" className="sm" />
      {connecting ? <span className="wf-dot wait pulse" aria-hidden /> : null}
      {isError ? <span className="wf-dot err" aria-hidden /> : null}
    </button>
  );
}
