import { create } from "zustand";

/** A login failure kept until acknowledged. */
export interface LoginFailure {
  error: string | null;
}

interface AccountLoginState {
  /** The last UNACKNOWLEDGED login failure per backend, recorded from the app-global
   *  `AccountLoginEvent` by the always-mounted handler. Codex login completes async
   *  (minutes later), so the outcome can land while the Comptes panel is unmounted — the
   *  in-panel listener would miss it and the user would only see a bare "Non connecté".
   *  Stashing it here lets the panel surface the reason when it reopens. Successes clear the
   *  entry (nothing to show); a new login attempt clears it too. */
  failures: Record<string, LoginFailure | undefined>;
  /** Record an outcome: keep the reason on failure, drop any prior one on success. */
  recordOutcome: (backend: string, success: boolean, error: string | null) => void;
  /** Drop a backend's stashed failure (consumed / superseded by a new attempt). */
  clear: (backend: string) => void;
}

export const useAccountLoginStore = create<AccountLoginState>((set) => ({
  failures: {},
  recordOutcome: (backend, success, error) =>
    set((s) => ({
      failures: { ...s.failures, [backend]: success ? undefined : { error } },
    })),
  clear: (backend) => set((s) => ({ failures: { ...s.failures, [backend]: undefined } })),
}));
