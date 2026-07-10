// Dynamic Codex model catalogue, fetched from the installed binary (`model/list` via
// the transient app-server IPC). Feeds the composer's model picker (its Codex section)
// AND the data-driven effort gauge (each model's real `supportedReasoningEfforts`).
// Falls back to the verified static list (`CODEX_MODELS`) while loading or on error, so
// the picker is never empty. Cached process-wide (models don't change per cwd).
import { useQuery } from "@tanstack/react-query";
import { commands } from "../../ipc/client";
import { effortLevelsForModel, type EffortLevel } from "./EffortGauge";
import { CODEX_MODELS, type ModelOption } from "./models";

export interface CodexModelsData {
  /** Picker options (dynamic when loaded, else the static fallback). */
  models: ModelOption[];
  /** model id → its supported reasoning-effort steps (for the effort gauge). */
  effortsById: Record<string, EffortLevel[]>;
}

const VALID_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const asEfforts = (xs: string[]): EffortLevel[] =>
  xs.filter((x): x is EffortLevel => (VALID_EFFORTS as string[]).includes(x));

/**
 * The Codex models + per-model effort steps. `enabled` gates the fetch on Codex being
 * installed (never spawns the binary otherwise). Always returns a usable catalogue: the
 * dynamic result when present, the static `CODEX_MODELS` otherwise.
 */
export function useCodexModels(enabled: boolean): CodexModelsData {
  const q = useQuery({
    queryKey: ["codexModels"],
    enabled,
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      const res = await commands.codexListModels();
      if (res.status === "error") throw new Error(res.error);
      return res.data;
    },
  });

  const list = q.data ?? [];
  if (list.length === 0) {
    // Loading / error / empty → verified static fallback. Per-model ladder (gpt-5.6
    // gets max+ultra, older gpt-5.x low→xhigh) via effortLevelsForModel so the fallback
    // never lies about a gpt-5.6 model's real steps.
    const effortsById: Record<string, EffortLevel[]> = {};
    for (const m of CODEX_MODELS) effortsById[m.value] = effortLevelsForModel(m.value);
    return { models: CODEX_MODELS, effortsById };
  }

  const models: ModelOption[] = list.map((m) => ({
    label: m.displayName || m.id,
    value: m.id,
    backend: "codex",
  }));
  const effortsById: Record<string, EffortLevel[]> = {};
  for (const m of list) {
    const steps = asEfforts(m.efforts);
    effortsById[m.id] = steps.length ? steps : effortLevelsForModel(m.id);
  }
  return { models, effortsById };
}
