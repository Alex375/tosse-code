import { Component, type ReactNode } from "react";
import styles from "./editor.module.css";

/**
 * Catches a render-time failure in the code editor — most importantly a failed
 * lazy chunk load (Monaco) or a Monaco init throw — so it surfaces as a visible
 * message instead of an endless "Chargement…" spinner (a silent failure). Reset
 * by remounting (the boundary is keyed by file path in EditorPane).
 */
export class EditorErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[editor] failed to render the code editor:", error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className={styles.placeholder}>
          Impossible d'afficher l'éditeur de code.
          <br />
          {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
