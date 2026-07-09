// The card's clickable context meter: the tiny fill bar, now opening the SAME
// context/usage popover as the conversation composer's ContextRing (context window +
// forfait 5h/7j + « Compacter le contexte »). All the wiring — context tokens, the
// shared plan-usage query, and sending /compact — lives here so StreamCard stays lean.
//
// Backend-aware, EXACTLY like the composer: the usage source, the "Forfait" label, and the
// compact action all branch on the conversation's backend so a Codex card shows Codex's
// (ChatGPT) figures under a « Codex » label — never Claude's under the wrong name.

import { ContextMeterMenu } from "../../ui/kit";
import { useContextData } from "../../store/contextData";
import { usePlanUsage, PLAN_USAGE_STALE_MS } from "../../store/planUsage";
import { useCodexPlanUsage } from "../../store/codexPlanUsage";
import { useSendMessage, useCodexCompact } from "../../ipc/useCommands";
import { useConversationsStore } from "../../store/conversationsStore";
import { useCodexAvailable } from "../../store/codexAvailable";

export function CardContext({ convId }: { convId: string }) {
  const { ctx, ready, plan } = useContextData(convId);
  // This card's backend — drives WHICH usage source is read and the popover's plan label.
  const isCodex = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.kind === "codex",
  );
  // Only label the plan when BOTH backends can coexist (Codex installed); a single-backend
  // setup needs no "Claude/Codex" tag.
  const codexAvailable = useCodexAvailable();
  // Claude polls the Anthropic OAuth endpoint (gated OFF for Codex so a Codex card never
  // reads Claude credentials / pops the Keychain); Codex reads the push-fed account store.
  // One shared query per account, so N cards don't mean N fetches. Both feed the SAME popover.
  const planUsage = usePlanUsage({ enabled: ready && !isCodex });
  const codexPlan = useCodexPlanUsage();
  const send = useSendMessage(convId);
  const codexCompact = useCodexCompact(convId);

  if (!ready) return null;

  const onOpenUsage = isCodex
    ? undefined // push-fed: nothing to refetch on open
    : () => {
        const lastAttempt = Math.max(planUsage.dataUpdatedAt, planUsage.errorUpdatedAt);
        if (Date.now() - lastAttempt >= PLAN_USAGE_STALE_MS) void planUsage.refetch();
      };

  return (
    <ContextMeterMenu
      ctx={ctx}
      plan={isCodex ? null : plan}
      onOpenUsage={onOpenUsage}
      onCompact={isCodex ? () => codexCompact.mutate() : () => send.mutate({ text: "/compact" })}
      usage={isCodex ? codexPlan.usage : (planUsage.data ?? null)}
      usageLoading={isCodex ? false : planUsage.isFetching}
      usageError={isCodex ? null : planUsage.error}
      usageUpdatedAt={isCodex ? codexPlan.updatedAt : planUsage.dataUpdatedAt}
      usageBackend={codexAvailable ? (isCodex ? "codex" : "claude") : undefined}
      onRefreshUsage={() => void planUsage.refetch()}
    />
  );
}
