// The card's clickable context meter: the tiny fill bar, now opening the SAME
// context/usage popover as the conversation composer's ContextRing (context window +
// forfait 5h/7j + « Compacter le contexte »). All the wiring — context tokens, the
// shared plan-usage query, and sending /compact — lives here so StreamCard stays lean.
//
// Mirrors the composer: the meter shows only once the session has reported usage
// (`ready`); /compact is sent to this conversation (spawning/resuming it as needed),
// and the usage query is refetched on open when the figures are stale.

import { ContextMeterMenu } from "../../ui/kit";
import { useContextData } from "../../store/contextData";
import { usePlanUsage, PLAN_USAGE_STALE_MS } from "../../store/planUsage";
import { useSendMessage } from "../../ipc/useCommands";

export function CardContext({ convId }: { convId: string }) {
  const { ctx, ready, plan } = useContextData(convId);
  // Shared query (one poll for the whole account) — every card subscribes to the same
  // cache, so N cards don't mean N fetches. Gated until the meter is actually shown.
  const planUsage = usePlanUsage({ enabled: ready });
  const send = useSendMessage(convId);

  if (!ready) return null;

  const onOpenUsage = () => {
    const lastAttempt = Math.max(planUsage.dataUpdatedAt, planUsage.errorUpdatedAt);
    if (Date.now() - lastAttempt >= PLAN_USAGE_STALE_MS) void planUsage.refetch();
  };

  return (
    <ContextMeterMenu
      ctx={ctx}
      plan={plan}
      onOpenUsage={onOpenUsage}
      onCompact={() => send.mutate({ text: "/compact" })}
      usage={planUsage.data ?? null}
      usageLoading={planUsage.isFetching}
      usageError={planUsage.error}
      usageUpdatedAt={planUsage.dataUpdatedAt}
      onRefreshUsage={() => void planUsage.refetch()}
    />
  );
}
