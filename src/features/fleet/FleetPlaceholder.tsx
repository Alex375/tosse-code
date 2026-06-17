import { LayoutGrid } from "lucide-react";

/**
 * Placeholder for the Fleet (agent dashboard) view — built in parallel under its
 * own task ("Vue Gestion d'agents"). Replaced by the real dashboard once it lands.
 */
export function FleetPlaceholder() {
  return (
    <div
      style={{
        margin: "auto",
        textAlign: "center",
        color: "var(--text-muted)",
        maxWidth: 420,
        padding: "var(--space-7)",
      }}
    >
      <LayoutGrid size={28} strokeWidth={1.5} style={{ marginBottom: "var(--space-4)" }} />
      <div style={{ fontSize: "var(--fs-h2)", color: "var(--text-secondary)", marginBottom: "var(--space-2)" }}>
        Gestion d'agents
      </div>
      <div style={{ fontSize: "var(--fs-sm)", lineHeight: 1.7 }}>
        Le dashboard de la flotte (états, notifications, réponses) est en cours de
        construction dans sa propre tâche.
      </div>
    </div>
  );
}
