// App-level error surface: failures that are NOT tied to a single conversation
// turn (boot/hydration, metadata persistence) and so can't ride the conversation
// thread's error bubble. They show as a dismissible banner at the top of the app
// (see `AppErrorBanner`). This is the front half of "zero silent error" for the
// systemic failures: a corrupt DB at boot, or SQL writes failing — both used to be
// `console.error` only (invisible outside devtools).

import { create } from "zustand";

export interface AppError {
  id: string;
  message: string;
  /** Optional raw technical detail, shown under the message. */
  detail?: string | null;
}

interface AppErrorsState {
  errors: AppError[];
  /** Surface an app-level error. Deduped by `message`, so a recurring failure (a
   *  broken DB failing every write) shows ONE banner, not a growing stack. */
  pushError: (message: string, detail?: string | null) => void;
  dismiss: (id: string) => void;
}

let seq = 0;

export const useAppErrors = create<AppErrorsState>((set) => ({
  errors: [],
  pushError: (message, detail) =>
    set((s) =>
      s.errors.some((e) => e.message === message)
        ? s
        : { errors: [...s.errors, { id: `app_err_${seq++}`, message, detail: detail ?? null }] },
    ),
  dismiss: (id) => set((s) => ({ errors: s.errors.filter((e) => e.id !== id) })),
}));
