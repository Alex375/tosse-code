import { useEffect, useRef } from "react";
import { commands, events } from "../../ipc/client";
import { useEditorStore } from "./editorStore";

/** Run a watch IPC call, logging both an error Result and a thrown rejection.
 *  Watch is best-effort (a failure only means live-refresh won't fire) but must
 *  never fail silently — a dead watch is otherwise invisible. */
function runWatch(
  label: string,
  run: () => Promise<{ status: "ok"; data: null } | { status: "error"; error: string }>,
): void {
  run()
    .then((r) => {
      if (r.status !== "ok") console.error(`[fsWatch] ${label} failed:`, r.error);
    })
    .catch((e) => console.error(`[fsWatch] ${label} threw:`, e));
}

/**
 * Keep the core's single filesystem watch pointed at the editor's current working
 * directory, and route its coalesced `FsChangeEvent`s into the editor store
 * (reload open files per the conflict policy, refresh expanded tree dirs).
 *
 * The watch follows `cwd`: switching conversation — or the agent entering a
 * worktree (a live cwd move) — re-points it. When the panel closes (`enabled`
 * false) the watch is dropped.
 */
export function useFsWatch(convId: string, cwd: string | null, enabled: boolean): void {
  // Always-current target for the (once-registered) event listener.
  const ctx = useRef({ convId, cwd });
  ctx.current = { convId, cwd };

  // (Re)point the OS watch while the panel is open.
  useEffect(() => {
    if (!enabled || !cwd) {
      runWatch("unwatchDir", () => commands.unwatchDir());
      return;
    }
    runWatch("watchDir", () => commands.watchDir(cwd));
    return () => {
      runWatch("unwatchDir", () => commands.unwatchDir());
    };
  }, [enabled, cwd]);

  // Subscribe once; the handler reads the live target from the ref. A failed
  // listen() registration is logged rather than swallowed.
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    events.fsChangeEvent
      .listen((e) => {
        if (disposed) return;
        const { convId, cwd } = ctx.current;
        if (!cwd) return;
        void useEditorStore.getState().onExternalChange(convId, e.payload.paths);
      })
      .then((fn) => {
        if (disposed) fn();
        else un = fn;
      })
      .catch((e) => console.error("[fsWatch] fsChangeEvent.listen failed:", e));
    return () => {
      disposed = true;
      un?.();
    };
  }, []);
}
