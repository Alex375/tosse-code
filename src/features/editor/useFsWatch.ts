import { useEffect, useRef } from "react";
import { commands, events } from "../../ipc/client";
import { useEditorStore } from "./editorStore";
import { useAppErrors } from "../../store/appErrors";

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
    const uns: Array<() => void> = [];
    const track = (p: Promise<() => void>, label: string) =>
      p
        .then((fn) => {
          if (disposed) fn();
          else uns.push(fn);
        })
        .catch((e) => console.error(`[fsWatch] ${label}.listen failed:`, e));

    track(
      events.fsChangeEvent.listen((e) => {
        if (disposed) return;
        const { convId, cwd } = ctx.current;
        if (!cwd) return;
        void useEditorStore.getState().onExternalChange(convId, e.payload.paths);
      }),
      "fsChangeEvent",
    );

    // The watcher backend died: live refresh has stopped, so the tree/open files can
    // go stale without any sign. Surface it (deduped) instead of letting it be silent.
    track(
      events.fsWatchErrorEvent.listen((e) => {
        if (disposed) return;
        console.error("[fsWatch] watcher backend error:", e.payload.message);
        useAppErrors
          .getState()
          .pushError(
            "File watching stopped — the tree and open files may not refresh automatically.",
            e.payload.message,
          );
      }),
      "fsWatchErrorEvent",
    );

    return () => {
      disposed = true;
      uns.forEach((un) => un());
    };
  }, []);
}
