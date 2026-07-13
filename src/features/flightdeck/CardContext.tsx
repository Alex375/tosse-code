// The card's clickable context meter: the tiny fill bar, now opening the SAME
// context/usage popover as the conversation composer's ContextRing (context window +
// forfait 5h/7j + « Compacter le contexte »). All the backend-aware wiring (usage
// source, "Forfait" label, refresh gating, compact action) comes from the ONE hook
// shared with the composer — `useBackendUsage` — so the two surfaces render identical
// data by construction and can never drift apart.

import { ContextMeterMenu } from "../../ui/kit";
import { useContextData } from "../../store/contextData";
import { useBackendUsage } from "../conversation/backendUsage";

export function CardContext({ convId }: { convId: string }) {
  const { ctx, ready, plan } = useContextData(convId);
  // Backend-aware usage + compact, shared with the composer (see backendUsage.ts).
  // Claude compacts via the default bare `/compact` text turn here (no composer
  // pipeline on this surface); Codex fires its native compact RPC.
  const usage = useBackendUsage(convId, { enabled: ready });

  if (!ready) return null;

  return (
    <ContextMeterMenu
      ctx={ctx}
      plan={usage.isCodex ? null : plan}
      onOpenUsage={usage.onOpenUsage}
      onCompact={usage.onCompact}
      usage={usage.usage}
      usageLoading={usage.usageLoading}
      usageError={usage.usageError}
      usageUpdatedAt={usage.usageUpdatedAt}
      usageBackend={usage.usageBackend}
      onRefreshUsage={usage.onRefreshUsage}
    />
  );
}
